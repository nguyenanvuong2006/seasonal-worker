/**
 * POST /api/document-merge/candidate-documents/[id]/issue — EXECUTION
 * regression tests (2026-09-10, Electronic Confirmation deadline mission).
 * Named as a sibling file OUTSIDE the [id]/issue/ directory (same convention
 * as issue-ready-execution.test.ts) — Node's test-runner glob resolution
 * does not reliably discover *.test.ts files nested under a bracketed
 * dynamic-route directory.
 *
 * Transpiles and RUNS the real route.ts against a fake DB modeling the CAS
 * semantics, proving: the default 3-day deadline is frozen when no policy
 * is supplied, a custom deadlineDays/deadlineAt policy is honored, invalid
 * policy input is rejected BEFORE the row is touched (status stays READY),
 * and CONFIRMATION_DEADLINE_SET is audited alongside DOCUMENT_ISSUED.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { condsOf, createFakeDb, drizzleStub, eqValue, makeTable, type FakeDb, type QueryCall } from "../../../../lib/test-support/fake-drizzle.ts";

const ROUTE_PATH = "src/app/api/document-merge/candidate-documents/[id]/issue/route.ts";
const routeSource = readFileSync(new URL(`../../../../../${ROUTE_PATH}`, import.meta.url), "utf8");
const jsSource = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

const schemaStub = { candidateDocuments: makeTable("candidate_documents") };

type DocState = { id: string; status: string; applicationId: string; pdfSha256: string | null; storageKey: string | null };
type NextResponseLike = { status: number; jsonBody: Record<string, unknown> };

function loadRoute(initial: DocState) {
  const state = { ...initial };
  const auditWrites: { action: string; details: Record<string, unknown> }[] = [];

  const db: FakeDb = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.table === "candidate_documents" && call.root === "update") {
        const id = eqValue(call, "candidate_documents.id") as string | undefined;
        const requiredStatus = eqValue(call, "candidate_documents.status") as string | undefined;
        const conds = condsOf(call);
        const hasPdfCheck = conds.some((c) => c.op === "isNotNull" && c.col === "candidate_documents.pdfSha256");
        const hasStorageCheck = conds.some((c) => c.op === "isNotNull" && c.col === "candidate_documents.storageKey");
        if (id !== state.id) return [];
        const artifactOk = (!hasPdfCheck || !!state.pdfSha256) && (!hasStorageCheck || !!state.storageKey);
        if (state.status === requiredStatus && artifactOk) {
          state.status = "ISSUED";
          return [{ id: state.id, applicationId: state.applicationId }];
        }
        return [];
      }
      if (call.table === "candidate_documents" && call.root === "select") {
        return [{ ...state }];
      }
      return undefined;
    },
  });

  const moduleObj = { exports: {} as Record<string, unknown> };
  const context = vm.createContext({
    module: moduleObj,
    exports: moduleObj.exports,
    require: (id: string) => {
      switch (id) {
        case "next/server":
          return {
            NextResponse: {
              json: (body: unknown, init?: { status?: number }): NextResponseLike => ({ status: init?.status ?? 200, jsonBody: body as Record<string, unknown> }),
            },
          };
        case "drizzle-orm":
          return drizzleStub;
        case "@/db":
          return { db };
        case "@/db/schema":
          return schemaStub;
        case "@/lib/auth":
          return {
            requirePermission: async () => ({
              ok: true as const,
              session: { id: "staff-1", username: "staff", fullName: "Staff", role: "ADMIN", deptId: null },
            }),
            writeAudit: async (_session: unknown, action: string, _targetType: string, details: Record<string, unknown>) => {
              auditWrites.push({ action, details });
            },
          };
        case "@/lib/candidate-consent/confirmation-deadline": {
          const DEFAULT_CONFIRMATION_WINDOW_DAYS = 3;
          const MS_PER_DAY = 24 * 60 * 60 * 1000;
          function resolveConfirmationDeadline(policy: { kind: string; days?: number; at?: Date }, issuedAt: Date) {
            if (policy.kind === "DAYS") {
              const days = policy.days as number;
              if (!Number.isInteger(days) || days < 1 || days > 365) {
                return { ok: false, error: "Số ngày không hợp lệ (phải từ 1 đến 365)." };
              }
              return { ok: true, deadlineAt: new Date(issuedAt.getTime() + days * MS_PER_DAY) };
            }
            const at = policy.at as Date;
            if (Number.isNaN(at.getTime())) return { ok: false, error: "Ngày giờ hết hạn không hợp lệ." };
            if (at.getTime() <= issuedAt.getTime()) return { ok: false, error: "Hạn xác nhận phải sau thời điểm phát hành." };
            return { ok: true, deadlineAt: at };
          }
          function parseDeadlinePolicyFromBody(body: { deadlineDays?: unknown; deadlineAt?: unknown }) {
            if (typeof body.deadlineAt === "string" && body.deadlineAt.trim().length > 0) return { kind: "ABSOLUTE", at: new Date(body.deadlineAt) };
            if (typeof body.deadlineDays === "number") return { kind: "DAYS", days: body.deadlineDays };
            return { kind: "DAYS", days: DEFAULT_CONFIRMATION_WINDOW_DAYS };
          }
          return { parseDeadlinePolicyFromBody, resolveConfirmationDeadline };
        }
        default:
          throw new Error(`Unexpected require("${id}") — route không được phụ thuộc module này.`);
      }
    },
    process,
    Request,
    console,
    JSON,
  });
  vm.runInContext(jsSource, context);

  const POST = (moduleObj.exports as { POST: (req: Request, ctx: { params: Promise<{ id: string }> } ) => Promise<NextResponseLike> }).POST;
  return { POST, state, auditWrites };
}

function postWith(id: string, body?: Record<string, unknown>): { req: Request; ctx: { params: Promise<{ id: string }> } } {
  return {
    req: new Request(`https://app.example/api/document-merge/candidate-documents/${id}/issue`, {
      method: "POST",
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
    ctx: { params: Promise.resolve({ id }) },
  };
}

test("no deadline policy in body → freezes the default 3-day confirmation deadline from server now", async () => {
  const { POST, auditWrites } = loadRoute({ id: "d1", status: "READY", applicationId: "a1", pdfSha256: "hash", storageKey: "key" });
  const before = Date.now();
  const { req, ctx } = postWith("d1", {});
  const res = await POST(req, ctx);
  const after = Date.now();

  assert.equal(res.status, 200);
  assert.equal(res.jsonBody.alreadyIssued, false);
  const deadlineMs = new Date(res.jsonBody.confirmationDeadlineAt as string).getTime();
  const expectedMin = before + 3 * 24 * 60 * 60 * 1000;
  const expectedMax = after + 3 * 24 * 60 * 60 * 1000;
  assert.ok(deadlineMs >= expectedMin && deadlineMs <= expectedMax, "deadline must be ~3 days from issuedAt");

  const deadlineSetAudit = auditWrites.find((a) => a.action === "CONFIRMATION_DEADLINE_SET");
  assert.ok(deadlineSetAudit, "CONFIRMATION_DEADLINE_SET must be audited");
  assert.equal(deadlineSetAudit!.details.candidateDocumentId, "d1");
  const issuedAudit = auditWrites.find((a) => a.action === "DOCUMENT_ISSUED");
  assert.ok(issuedAudit);
  assert.equal(typeof issuedAudit!.details.confirmationDeadlineAt, "string");
});

test("custom deadlineDays=7 in body → deadline is 7 days from issuedAt, not the 3-day default", async () => {
  const { POST } = loadRoute({ id: "d1", status: "READY", applicationId: "a1", pdfSha256: "hash", storageKey: "key" });
  const before = Date.now();
  const { req, ctx } = postWith("d1", { deadlineDays: 7 });
  const res = await POST(req, ctx);
  const deadlineMs = new Date(res.jsonBody.confirmationDeadlineAt as string).getTime();
  assert.ok(deadlineMs >= before + 7 * 24 * 60 * 60 * 1000 - 1000);
  assert.ok(deadlineMs < before + 8 * 24 * 60 * 60 * 1000);
});

test("custom absolute deadlineAt in body → frozen to that exact instant", async () => {
  const { POST } = loadRoute({ id: "d1", status: "READY", applicationId: "a1", pdfSha256: "hash", storageKey: "key" });
  const future = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
  const { req, ctx } = postWith("d1", { deadlineAt: future });
  const res = await POST(req, ctx);
  assert.equal(res.status, 200);
  assert.equal(new Date(res.jsonBody.confirmationDeadlineAt as string).toISOString(), future);
});

test("invalid deadlineDays (0) → 400 rejected BEFORE the row is touched, status stays READY", async () => {
  const { POST, state } = loadRoute({ id: "d1", status: "READY", applicationId: "a1", pdfSha256: "hash", storageKey: "key" });
  const { req, ctx } = postWith("d1", { deadlineDays: 0 });
  const res = await POST(req, ctx);
  assert.equal(res.status, 400);
  assert.equal(state.status, "READY", "the CAS UPDATE must never run when the deadline policy itself is invalid");
});

test("absolute deadlineAt in the past → 400 rejected, row untouched", async () => {
  const { POST, state } = loadRoute({ id: "d1", status: "READY", applicationId: "a1", pdfSha256: "hash", storageKey: "key" });
  const past = new Date(Date.now() - 1000).toISOString();
  const { req, ctx } = postWith("d1", { deadlineAt: past });
  const res = await POST(req, ctx);
  assert.equal(res.status, 400);
  assert.equal(state.status, "READY");
});

test("double-issue (already ISSUED) → idempotent success, no second CONFIRMATION_DEADLINE_SET audit", async () => {
  const { POST, auditWrites } = loadRoute({ id: "d1", status: "READY", applicationId: "a1", pdfSha256: "hash", storageKey: "key" });
  const first = postWith("d1", {});
  await POST(first.req, first.ctx);
  assert.equal(auditWrites.filter((a) => a.action === "CONFIRMATION_DEADLINE_SET").length, 1);

  const second = postWith("d1", {});
  const res2 = await POST(second.req, second.ctx);
  assert.equal(res2.status, 200);
  assert.equal(res2.jsonBody.alreadyIssued, true);
  assert.equal(auditWrites.filter((a) => a.action === "CONFIRMATION_DEADLINE_SET").length, 1, "double-click must never freeze a second deadline");
});
