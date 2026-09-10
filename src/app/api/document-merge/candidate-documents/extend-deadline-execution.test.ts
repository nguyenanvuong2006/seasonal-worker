/**
 * POST /api/document-merge/candidate-documents/[id]/extend-deadline —
 * EXECUTION regression tests (2026-09-10, Electronic Confirmation deadline
 * mission). Named as a sibling file outside the [id]/extend-deadline/
 * directory — same reason as issue-single-deadline.test.ts (Node's test
 * runner does not reliably discover test files nested under a bracketed
 * dynamic-route directory).
 *
 * Proves: only ISSUED/VIEWED documents are extendable; the new deadline
 * must be strictly after the OLD one (never a silent shortening); the new
 * deadline is a fresh N-days-from-NOW computation (not from the original
 * issuedAt); CONFIRMATION_DEADLINE_EXTENDED is audited with old+new+reason.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { argOf, createFakeDb, drizzleStub, eqValue, makeTable, type FakeDb, type QueryCall } from "../../../../lib/test-support/fake-drizzle.ts";

const ROUTE_PATH = "src/app/api/document-merge/candidate-documents/[id]/extend-deadline/route.ts";
const routeSource = readFileSync(new URL(`../../../../../${ROUTE_PATH}`, import.meta.url), "utf8");
const jsSource = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

const schemaStub = { candidateDocuments: makeTable("candidate_documents") };

type DocState = { id: string; status: string; applicationId: string; confirmationDeadlineAt: Date | null };
type NextResponseLike = { status: number; jsonBody: Record<string, unknown> };

function loadRoute(initial: DocState) {
  const state = { ...initial };
  const auditWrites: { action: string; details: Record<string, unknown> }[] = [];

  const db: FakeDb = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.table === "candidate_documents" && call.root === "select") {
        const id = eqValue(call, "candidate_documents.id") as string | undefined;
        if (id !== state.id) return [];
        return [{ ...state }];
      }
      if (call.table === "candidate_documents" && call.root === "update") {
        const id = eqValue(call, "candidate_documents.id") as string | undefined;
        if (id !== state.id) return [];
        const setValues = argOf(call, "set") as Record<string, unknown> | undefined;
        if (setValues?.confirmationDeadlineAt instanceof Date) {
          state.confirmationDeadlineAt = setValues.confirmationDeadlineAt;
        }
        return [{ id: state.id }];
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

  const POST = (moduleObj.exports as { POST: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<NextResponseLike> }).POST;
  return { POST, state, auditWrites };
}

function postWith(id: string, body: Record<string, unknown>): { req: Request; ctx: { params: Promise<{ id: string }> } } {
  return {
    req: new Request(`https://app.example/api/document-merge/candidate-documents/${id}/extend-deadline`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    ctx: { params: Promise.resolve({ id }) },
  };
}

test("ISSUED document, deadlineDays=5 → deadline extended to ~5 days from NOW (extension moment), old deadline unaffected as a base", async () => {
  const oldDeadline = new Date(Date.now() + 24 * 60 * 60 * 1000); // 1 day from now
  const { POST, state, auditWrites } = loadRoute({ id: "d1", status: "ISSUED", applicationId: "a1", confirmationDeadlineAt: oldDeadline });
  const before = Date.now();
  const { req, ctx } = postWith("d1", { deadlineDays: 5, reason: "Ứng viên yêu cầu thêm thời gian" });
  const res = await POST(req, ctx);

  assert.equal(res.status, 200);
  const newDeadlineMs = new Date(res.jsonBody.confirmationDeadlineAt as string).getTime();
  assert.ok(newDeadlineMs >= before + 5 * 24 * 60 * 60 * 1000 - 1000);
  assert.equal(state.confirmationDeadlineAt!.getTime(), newDeadlineMs);

  const audit = auditWrites.find((a) => a.action === "CONFIRMATION_DEADLINE_EXTENDED");
  assert.ok(audit);
  assert.equal(audit!.details.candidateDocumentId, "d1");
  assert.equal(audit!.details.oldDeadlineAt, oldDeadline.toISOString());
  assert.equal(audit!.details.reason, "Ứng viên yêu cầu thêm thời gian");
});

test("VIEWED document is also extendable (not only ISSUED)", async () => {
  const oldDeadline = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const { POST } = loadRoute({ id: "d1", status: "VIEWED", applicationId: "a1", confirmationDeadlineAt: oldDeadline });
  const { req, ctx } = postWith("d1", { deadlineDays: 3 });
  const res = await POST(req, ctx);
  assert.equal(res.status, 200);
});

test("CONFIRMED document cannot be extended (nothing left to extend)", async () => {
  const { POST } = loadRoute({ id: "d1", status: "CONFIRMED", applicationId: "a1", confirmationDeadlineAt: new Date() });
  const { req, ctx } = postWith("d1", { deadlineDays: 3 });
  const res = await POST(req, ctx);
  assert.equal(res.status, 409);
});

test("REVOKED document cannot be extended", async () => {
  const { POST } = loadRoute({ id: "d1", status: "REVOKED", applicationId: "a1", confirmationDeadlineAt: new Date() });
  const { req, ctx } = postWith("d1", { deadlineDays: 3 });
  const res = await POST(req, ctx);
  assert.equal(res.status, 409);
});

test("attempting to shorten the deadline (new absolute deadline before the old one) → 400 rejected, state unchanged", async () => {
  const oldDeadline = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000); // 10 days out
  const { POST, state } = loadRoute({ id: "d1", status: "ISSUED", applicationId: "a1", confirmationDeadlineAt: oldDeadline });
  const shorterAbsolute = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(); // only 2 days out — a shortening
  const { req, ctx } = postWith("d1", { deadlineAt: shorterAbsolute });
  const res = await POST(req, ctx);
  assert.equal(res.status, 400);
  assert.equal(state.confirmationDeadlineAt!.getTime(), oldDeadline.getTime(), "old deadline must be untouched when the extension attempt is rejected");
});

test("document not found → 404", async () => {
  const { POST } = loadRoute({ id: "d1", status: "ISSUED", applicationId: "a1", confirmationDeadlineAt: new Date() });
  const { req, ctx } = postWith("missing-doc", { deadlineDays: 3 });
  const res = await POST(req, ctx);
  assert.equal(res.status, 404);
});
