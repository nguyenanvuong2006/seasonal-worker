/**
 * POST /api/workforce-movements/bulk-approve-resignation — BULK RESIGNATION
 * APPROVAL (2026-09). Proves the route reuses applyMovementAction() (the
 * exact same canonical service the single-row "Duyệt nghỉ việc" endpoint
 * uses) per-item, never reimplements the resignation transition, and:
 *
 *   - RBAC: same permission as the single-row endpoint, checked ONCE,
 *     before any DB access.
 *   - Data Scope: rechecked per id (movementScopeVisibility) — an
 *     out-of-scope id injected into an otherwise-authorized batch is
 *     marked OUT_OF_SCOPE and never reaches applyMovementAction.
 *   - Partial success: one id's failure/ineligibility never blocks the
 *     rest of the batch; every id gets its own outcome.
 *   - Idempotency: an id whose row is already INACTIVE (i.e. a retry of
 *     an already-committed approval) is reported ALREADY_APPROVED and
 *     never re-enters applyMovementAction (no duplicate side effects).
 *   - Per-item audit: writeAudit is called once per successfully
 *     APPROVED id, carrying a shared bulkOperationId for correlation —
 *     never a single collapsed batch-only audit event.
 *   - Input validation: empty/missing requestIds and over-cap batches
 *     are rejected before touching the DB.
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
  return new Request("https://app.example/api/workforce-movements/bulk-approve-resignation", {
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

test("missing/non-array requestIds -> 400", async () => {
  const ctx = makeContext({ guard: OWNER_GUARD, rows: [] });
  const res = await ctx.POST(post({}));
  assert.equal(res.status, 400);
});

test("batch over MAX_BATCH_SIZE (100) -> 400, no DB access", async () => {
  const ctx = makeContext({ guard: OWNER_GUARD, rows: [] });
  const ids = Array.from({ length: 101 }, (_, i) => `m${i}`);
  const res = await ctx.POST(post({ requestIds: ids }));
  assert.equal(res.status, 400);
  assert.equal(ctx.db.calls.length, 0);
});

test("single eligible PENDING_HR resignation -> APPROVED, applyMovementAction called with APPROVE_RESIGNATION, audit written once with bulkOperationId", async () => {
  const ctx = makeContext({
    guard: OWNER_GUARD,
    rows: [{ id: "m1", movementType: "resignation", status: "PENDING_HR", fromDeptId: "d1", toDeptId: null }],
  });
  const res = await ctx.POST(post({ requestIds: ["m1"] }));
  assert.equal(res.status, 200);
  assert.equal(res.body.approved, 1);
  assert.equal(res.body.requested, 1);
  assert.deepEqual(ctx.applyCalls, [{ id: "m1", action: "APPROVE_RESIGNATION" }]);
  assert.equal(ctx.auditCalls.length, 1);
  assert.equal(ctx.auditCalls[0].action, "WORKFORCE_MOVEMENT_APPROVE_RESIGNATION");
  assert.equal(ctx.auditCalls[0].details.bulkOperationId, "bulk-op-fixed-id");
  assert.equal(res.body.bulkOperationId, "bulk-op-fixed-id");
});

test("partial success: mixed batch (approved / already approved / rejected / out-of-scope / not found) — one bad record never fails the batch", async () => {
  const ctx = makeContext({
    guard: OWNER_GUARD,
    scope: ["d1"],
    rows: [
      { id: "ok1", movementType: "resignation", status: "PENDING_HR", fromDeptId: "d1", toDeptId: null },
      { id: "already", movementType: "resignation", status: "INACTIVE", fromDeptId: "d1", toDeptId: null },
      { id: "rejected", movementType: "resignation", status: "REJECTED", fromDeptId: "d1", toDeptId: null },
      { id: "outofscope", movementType: "resignation", status: "PENDING_HR", fromDeptId: "d2", toDeptId: null },
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
  // Only the genuinely eligible id ever reached the canonical service.
  assert.deepEqual(ctx.applyCalls, [{ id: "ok1", action: "APPROVE_RESIGNATION" }]);
});

test("Data Scope mixed batch (3 authorized + 1 out-of-scope): authorized succeed, out-of-scope is never approved — no privilege expansion via bulk mode", async () => {
  const ctx = makeContext({
    guard: OWNER_GUARD,
    scope: ["d1"],
    rows: [
      { id: "a1", movementType: "resignation", status: "PENDING_HR", fromDeptId: "d1", toDeptId: null },
      { id: "a2", movementType: "resignation", status: "PENDING_HR", fromDeptId: "d1", toDeptId: null },
      { id: "a3", movementType: "resignation", status: "PENDING_HR", fromDeptId: "d1", toDeptId: null },
      { id: "outside", movementType: "resignation", status: "PENDING_HR", fromDeptId: "d9", toDeptId: null },
    ],
  });
  const res = await ctx.POST(post({ requestIds: ["a1", "a2", "a3", "outside"] }));
  assert.equal(res.body.approved, 3);
  assert.equal(res.body.outOfScope, 1);
  assert.ok(!ctx.applyCalls.some((c) => c.id === "outside"), "out-of-scope id must never reach applyMovementAction");
  assert.equal(ctx.applyCalls.length, 3);
});

test("transfer-type id sent to the resignation-only bulk endpoint -> NO_LONGER_ELIGIBLE, never approved", async () => {
  const ctx = makeContext({
    guard: OWNER_GUARD,
    rows: [{ id: "t1", movementType: "transfer", status: "PENDING_HR", fromDeptId: "d1", toDeptId: "d2" }],
  });
  const res = await ctx.POST(post({ requestIds: ["t1"] }));
  assert.equal(res.body.noLongerEligible, 1);
  assert.equal(ctx.applyCalls.length, 0);
});

test("one item's applyMovementAction throws -> that item is FAILED with a safe reason, the rest of the batch still processes", async () => {
  const ctx = makeContext({
    guard: OWNER_GUARD,
    rows: [
      { id: "bad", movementType: "resignation", status: "PENDING_HR", fromDeptId: "d1", toDeptId: null },
      { id: "good", movementType: "resignation", status: "PENDING_HR", fromDeptId: "d1", toDeptId: null },
    ],
    applyResult: (id) => {
      if (id === "bad") throw new Error("Không thể thực hiện hành động này ở trạng thái hiện tại (INACTIVE).");
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
  assert.equal(results.find((r) => r.id === "good")!.outcome, "APPROVED");
});

test("idempotency: an id already INACTIVE (retry of an already-committed approval) is ALREADY_APPROVED and never re-enters applyMovementAction — no duplicate side effects/audit", async () => {
  const ctx = makeContext({
    guard: OWNER_GUARD,
    rows: [{ id: "m1", movementType: "resignation", status: "INACTIVE", fromDeptId: "d1", toDeptId: null }],
  });
  const res = await ctx.POST(post({ requestIds: ["m1"] }));
  assert.equal(res.body.alreadyApproved, 1);
  assert.equal(res.body.approved, 0);
  assert.equal(ctx.applyCalls.length, 0);
  assert.equal(ctx.auditCalls.length, 0);
});

test("duplicate ids in the same request collapse into one result entry (no double-processing within one submission)", async () => {
  const ctx = makeContext({
    guard: OWNER_GUARD,
    rows: [{ id: "m1", movementType: "resignation", status: "PENDING_HR", fromDeptId: "d1", toDeptId: null }],
  });
  const res = await ctx.POST(post({ requestIds: ["m1", "m1", "m1"] }));
  assert.equal(res.body.requested, 1);
  const results = res.body.results as { id: string }[];
  assert.equal(results.length, 1);
  assert.equal(ctx.applyCalls.length, 1);
});

test("global scope (null) sees every department — no false OUT_OF_SCOPE for an ADMIN-style unrestricted session", async () => {
  const ctx = makeContext({
    guard: OWNER_GUARD,
    scope: null,
    rows: [{ id: "m1", movementType: "resignation", status: "PENDING_HR", fromDeptId: "any-dept", toDeptId: null }],
  });
  const res = await ctx.POST(post({ requestIds: ["m1"] }));
  assert.equal(res.body.approved, 1);
  assert.equal(res.body.outOfScope, 0);
});
