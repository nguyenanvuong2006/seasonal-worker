/**
 * POST /api/workforce-movements/bulk-approve-transfer — BULK TRANSFER
 * ARRIVAL CONFIRMATION (final-project-hardening — PR #187 deferred this
 * until the effective-date lifecycle behavior was proven safe in
 * Production; now migrated/reconciled/tested/verified). Same skeleton as
 * bulk-approve-resignation/route.ts (see its own test file for the shared
 * invariants); this file additionally proves the two transfer-specific
 * adaptations:
 *
 *   - Eligibility accepts movementType="transfer" with status PENDING_HR
 *     OR TRANSFER_RESCHEDULED (resignation only has PENDING_HR); terminal/
 *     already-done state is TRANSFER_COMPLETED (resignation's is INACTIVE).
 *   - Data Scope accepts FULL OR REDACTED_INCOMING visibility (a manager
 *     scoped only to the destination department can bulk-confirm arrivals
 *     there — the same rule the single-item PATCH route already applies
 *     for CONFIRM_ARRIVED) — resignation-type ids are always OUT_OF_SCOPE
 *     since REDACTED_INCOMING never applies to that movement type.
 *   - applyMovementAction is always called with action="CONFIRM_ARRIVED",
 *     never a second/duplicated transition engine.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createFakeDb, drizzleStub, makeTable, type FakeDb } from "../../../../lib/test-support/fake-drizzle.ts";
import { loadModule } from "../../../../lib/test-support/load-module.ts";

const dataScopeModule = loadModule(new URL("../../../../lib/data-scope.ts", import.meta.url), { stubs: {} });

const routeSource = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
const jsSource = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

const schemaStub = { workforceMovements: makeTable("workforce_movements") };

type Guard = { ok: true; session: { id: string; username: string; role: string } } | { ok: false; status: number; error: string };
type Row = { id: string; movementType: string; status: string; fromDeptId: string | null; toDeptId: string | null };
type Response = { status: number; body: Record<string, unknown> };

function makeContext(opts: {
  guard: Guard;
  scope?: string[] | null;
  rows: Row[];
  applyResult?: (id: string) => { spawnedResignationId: string | null } | Promise<never>;
}) {
  const applyCalls: { id: string; action: string }[] = [];
  const auditCalls: { action: string; targetType: string; details: Record<string, unknown> }[] = [];
  const rowsById = new Map(opts.rows.map((r) => [r.id, r]));

  const db = createFakeDb({
    respond: (call) => {
      if (call.root === "select" && call.table === "workforce_movements") return opts.rows;
      return undefined;
    },
  });

  const moduleObj = { exports: {} as Record<string, unknown> };
  const requireShim = (specifier: string): unknown => {
    switch (specifier) {
      case "next/server":
        return { NextResponse: { json: (body: Record<string, unknown>, init?: { status?: number }): Response => ({ status: init?.status ?? 200, body }) } };
      case "node:crypto":
        return { randomUUID: () => "bulk-op-fixed-id" };
      case "drizzle-orm":
        return drizzleStub;
      case "@/db":
        return { db };
      case "@/db/schema":
        return schemaStub;
      case "@/lib/auth":
        return {
          requirePermission: async () => opts.guard,
          getUserScope: async () => opts.scope ?? null,
          writeAudit: async (_session: unknown, action: string, targetType: string, details: Record<string, unknown>) => {
            auditCalls.push({ action, targetType, details });
          },
        };
      case "@/lib/data-scope":
        return dataScopeModule;
      case "@/lib/workforce-movements":
        return {
          applyMovementAction: async (_session: unknown, id: string, action: string) => {
            applyCalls.push({ id, action });
            const row = rowsById.get(id);
            if (!row) throw new Error("Không tìm thấy yêu cầu.");
            const outcome = opts.applyResult ? opts.applyResult(id) : { spawnedResignationId: null };
            return outcome;
          },
        };
      default:
        throw new Error(`Unexpected require("${specifier}")`);
    }
  };

  const context = vm.createContext({
    module: moduleObj,
    exports: moduleObj.exports,
    require: requireShim,
    process,
    Request,
    Response: globalThis.Response,
    Headers,
    URL,
    URLSearchParams,
    console,
    Date,
    JSON,
    Array,
    Object,
    Number,
    Boolean,
    String,
    Set,
    Map,
    Math,
    Error,
  });
  vm.runInContext(jsSource, context);

  return {
    POST: (moduleObj.exports as { POST: (req: Request) => Promise<Response> }).POST,
    db: db as FakeDb,
    applyCalls,
    auditCalls,
  };
}

function post(body: unknown): Request {
  return new Request("https://app.example/api/workforce-movements/bulk-approve-transfer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const OWNER_GUARD: Guard = { ok: true, session: { id: "u1", username: "hr1", role: "HR_RECRUITER" } };
const DENIED_GUARD: Guard = { ok: false, status: 403, error: "Không có quyền." };

test("permission denied -> 403, service never called, DB never queried", async () => {
  const ctx = makeContext({ guard: DENIED_GUARD, rows: [] });
  const res = await ctx.POST(post({ requestIds: ["m1"] }));
  assert.equal(res.status, 403);
  assert.equal(ctx.applyCalls.length, 0);
  assert.equal(ctx.db.calls.length, 0);
});

test("empty requestIds -> 400, no DB access", async () => {
  const ctx = makeContext({ guard: OWNER_GUARD, rows: [] });
  const res = await ctx.POST(post({ requestIds: [] }));
  assert.equal(res.status, 400);
  assert.equal(ctx.db.calls.length, 0);
});

test("batch over MAX_BATCH_SIZE (100) -> 400, no DB access", async () => {
  const ctx = makeContext({ guard: OWNER_GUARD, rows: [] });
  const ids = Array.from({ length: 101 }, (_, i) => `m${i}`);
  const res = await ctx.POST(post({ requestIds: ids }));
  assert.equal(res.status, 400);
  assert.equal(ctx.db.calls.length, 0);
});

test("single eligible PENDING_HR transfer -> APPROVED, applyMovementAction called with CONFIRM_ARRIVED, audit written once with bulkOperationId", async () => {
  const ctx = makeContext({
    guard: OWNER_GUARD,
    rows: [{ id: "t1", movementType: "transfer", status: "PENDING_HR", fromDeptId: "d1", toDeptId: "d2" }],
  });
  const res = await ctx.POST(post({ requestIds: ["t1"] }));
  assert.equal(res.status, 200);
  assert.equal(res.body.approved, 1);
  assert.deepEqual(ctx.applyCalls, [{ id: "t1", action: "CONFIRM_ARRIVED" }]);
  assert.equal(ctx.auditCalls.length, 1);
  assert.equal(ctx.auditCalls[0].action, "WORKFORCE_MOVEMENT_CONFIRM_ARRIVED");
  assert.equal(ctx.auditCalls[0].details.bulkOperationId, "bulk-op-fixed-id");
});

test("TRANSFER_RESCHEDULED (a rescheduled transfer still confirmable) -> APPROVED, same as PENDING_HR", async () => {
  const ctx = makeContext({
    guard: OWNER_GUARD,
    rows: [{ id: "t2", movementType: "transfer", status: "TRANSFER_RESCHEDULED", fromDeptId: "d1", toDeptId: "d2" }],
  });
  const res = await ctx.POST(post({ requestIds: ["t2"] }));
  assert.equal(res.body.approved, 1);
  assert.deepEqual(ctx.applyCalls, [{ id: "t2", action: "CONFIRM_ARRIVED" }]);
});

test("idempotency: TRANSFER_COMPLETED (retry of an already-committed confirmation) -> ALREADY_APPROVED, never re-enters applyMovementAction", async () => {
  const ctx = makeContext({
    guard: OWNER_GUARD,
    rows: [{ id: "t3", movementType: "transfer", status: "TRANSFER_COMPLETED", fromDeptId: "d1", toDeptId: "d2" }],
  });
  const res = await ctx.POST(post({ requestIds: ["t3"] }));
  assert.equal(res.body.alreadyApproved, 1);
  assert.equal(res.body.approved, 0);
  assert.equal(ctx.applyCalls.length, 0);
  assert.equal(ctx.auditCalls.length, 0);
});

test("resignation-type id sent to the transfer-only bulk endpoint -> NO_LONGER_ELIGIBLE, never approved", async () => {
  const ctx = makeContext({
    guard: OWNER_GUARD,
    rows: [{ id: "r1", movementType: "resignation", status: "PENDING_HR", fromDeptId: "d1", toDeptId: null }],
  });
  const res = await ctx.POST(post({ requestIds: ["r1"] }));
  assert.equal(res.body.noLongerEligible, 1);
  assert.equal(ctx.applyCalls.length, 0);
});

test("Data Scope: destination-only manager (REDACTED_INCOMING, scope=[d2]) CAN bulk-confirm an incoming transfer — no source-department permission needed", async () => {
  const ctx = makeContext({
    guard: OWNER_GUARD,
    scope: ["d2"],
    rows: [{ id: "t4", movementType: "transfer", status: "PENDING_HR", fromDeptId: "d1", toDeptId: "d2" }],
  });
  const res = await ctx.POST(post({ requestIds: ["t4"] }));
  assert.equal(res.body.approved, 1, "REDACTED_INCOMING (destination-only scope) must still be allowed to bulk-confirm arrival");
  assert.deepEqual(ctx.applyCalls, [{ id: "t4", action: "CONFIRM_ARRIVED" }]);
});

test("Data Scope: manager with NEITHER source NOR destination in scope -> OUT_OF_SCOPE, never approved", async () => {
  const ctx = makeContext({
    guard: OWNER_GUARD,
    scope: ["d9"],
    rows: [{ id: "t5", movementType: "transfer", status: "PENDING_HR", fromDeptId: "d1", toDeptId: "d2" }],
  });
  const res = await ctx.POST(post({ requestIds: ["t5"] }));
  assert.equal(res.body.outOfScope, 1);
  assert.equal(ctx.applyCalls.length, 0);
});

test("partial success: mixed batch (approved / already-completed / rejected / out-of-scope / not found) — one bad record never fails the batch", async () => {
  const ctx = makeContext({
    guard: OWNER_GUARD,
    scope: ["d1", "d2"],
    rows: [
      { id: "ok1", movementType: "transfer", status: "PENDING_HR", fromDeptId: "d1", toDeptId: "d2" },
      { id: "already", movementType: "transfer", status: "TRANSFER_COMPLETED", fromDeptId: "d1", toDeptId: "d2" },
      { id: "rejected", movementType: "transfer", status: "REJECTED", fromDeptId: "d1", toDeptId: "d2" },
      { id: "outofscope", movementType: "transfer", status: "PENDING_HR", fromDeptId: "d8", toDeptId: "d9" },
    ],
  });
  const res = await ctx.POST(post({ requestIds: ["ok1", "already", "rejected", "outofscope", "missing"] }));
  assert.equal(res.status, 200);
  assert.equal(res.body.requested, 5);
  assert.equal(res.body.approved, 1);
  assert.equal(res.body.alreadyApproved, 1);
  assert.equal(res.body.noLongerEligible, 2); // rejected + missing
  assert.equal(res.body.outOfScope, 1);
  assert.equal(res.body.failed, 0);
  const results = res.body.results as { id: string; outcome: string }[];
  assert.equal(results.find((r) => r.id === "ok1")!.outcome, "APPROVED");
  assert.equal(results.find((r) => r.id === "already")!.outcome, "ALREADY_APPROVED");
  assert.equal(results.find((r) => r.id === "rejected")!.outcome, "NO_LONGER_ELIGIBLE");
  assert.equal(results.find((r) => r.id === "outofscope")!.outcome, "OUT_OF_SCOPE");
  assert.equal(results.find((r) => r.id === "missing")!.outcome, "NO_LONGER_ELIGIBLE");
  assert.deepEqual(ctx.applyCalls, [{ id: "ok1", action: "CONFIRM_ARRIVED" }]);
});

test("one item's applyMovementAction throws -> that item is FAILED with a safe reason, the rest of the batch still processes", async () => {
  const ctx = makeContext({
    guard: OWNER_GUARD,
    rows: [
      { id: "bad", movementType: "transfer", status: "PENDING_HR", fromDeptId: "d1", toDeptId: "d2" },
      { id: "good", movementType: "transfer", status: "PENDING_HR", fromDeptId: "d1", toDeptId: "d2" },
    ],
    applyResult: (id) => {
      if (id === "bad") throw new Error("Không thể thực hiện hành động này ở trạng thái hiện tại.");
      return { spawnedResignationId: null };
    },
  });
  const res = await ctx.POST(post({ requestIds: ["bad", "good"] }));
  assert.equal(res.status, 200);
  assert.equal(res.body.failed, 1);
  assert.equal(res.body.approved, 1);
  const results = res.body.results as { id: string; outcome: string; reason?: string }[];
  assert.equal(results.find((r) => r.id === "bad")!.outcome, "FAILED");
  assert.ok(results.find((r) => r.id === "bad")!.reason);
});

test("duplicate ids in the same request collapse into one result entry (no double-processing within one submission)", async () => {
  const ctx = makeContext({
    guard: OWNER_GUARD,
    rows: [{ id: "t1", movementType: "transfer", status: "PENDING_HR", fromDeptId: "d1", toDeptId: "d2" }],
  });
  const res = await ctx.POST(post({ requestIds: ["t1", "t1", "t1"] }));
  assert.equal(res.body.requested, 1);
  const results = res.body.results as { id: string }[];
  assert.equal(results.length, 1);
  assert.equal(ctx.applyCalls.length, 1);
});

test("global scope (null) sees every department — no false OUT_OF_SCOPE for an ADMIN-style unrestricted session", async () => {
  const ctx = makeContext({
    guard: OWNER_GUARD,
    scope: null,
    rows: [{ id: "t1", movementType: "transfer", status: "PENDING_HR", fromDeptId: "any-dept", toDeptId: "other-dept" }],
  });
  const res = await ctx.POST(post({ requestIds: ["t1"] }));
  assert.equal(res.body.approved, 1);
  assert.equal(res.body.outOfScope, 0);
});
