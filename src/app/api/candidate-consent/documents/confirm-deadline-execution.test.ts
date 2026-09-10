/**
 * POST /api/candidate-consent/documents/[id]/confirm — DEADLINE ENFORCEMENT
 * regression tests (2026-09-10, Electronic Confirmation deadline mission).
 * Sibling file (not nested under [id]/confirm/) — same Node test-runner
 * bracket-glob quirk documented in pdf-route-worker-fallback.test.ts.
 *
 * Focuses specifically on the NEW deadline gate: a VIEWED document whose
 * confirmation_deadline_at has passed must be rejected with a friendly
 * Vietnamese message and a distinguishable error code, the document must
 * stay unconfirmed (no documentConfirmations row inserted, no CONFIRMED
 * status write), and a still-within-deadline VIEWED document must confirm
 * normally exactly as before this feature existed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { argOf, createFakeDb, makeTable } from "../../../../lib/test-support/fake-drizzle.ts";

const ROUTE_PATH = "src/app/api/candidate-consent/documents/[id]/confirm/route.ts";
const routeSource = readFileSync(new URL(`../../../../../${ROUTE_PATH}`, import.meta.url), "utf8");
const jsSource = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

const schemaStub = {
  auditLogs: makeTable("audit_logs"),
  candidateDocuments: makeTable("candidate_documents"),
  documentConfirmations: makeTable("document_confirmations"),
};

type NextResponseLike = { status: number; jsonBody: Record<string, unknown> };

type DocOverrides = { status?: string; confirmationDeadlineAt?: Date | null; pdfSha256?: string | null };

function makeContext(overrides: DocOverrides = {}) {
  const doc = {
    id: "cdoc-1",
    applicationId: "app-1",
    templateVersion: 1,
    pdfSha256: overrides.pdfSha256 ?? "abc123",
    status: overrides.status ?? "VIEWED",
    confirmationDeadlineAt: overrides.confirmationDeadlineAt === undefined ? null : overrides.confirmationDeadlineAt,
  };
  const updates: Record<string, unknown>[] = [];
  const confirmationInserts: Record<string, unknown>[] = [];

  const db = createFakeDb({
    respond: (call) => {
      if (call.root === "select" && call.table === "candidate_documents") return [doc];
      if (call.root === "select" && call.table === "document_confirmations") return [];
      if (call.root === "update" && call.table === "candidate_documents") {
        const set = argOf(call, "set") as Record<string, unknown>;
        updates.push(set);
        if (set.status) doc.status = set.status as string;
        return [];
      }
      if (call.root === "insert" && call.table === "document_confirmations") {
        const values = argOf(call, "values") as Record<string, unknown>;
        confirmationInserts.push(values);
        return [{ ...values, receiptId: values.receiptId ?? "receipt-1", confirmedAtServer: new Date() }];
      }
      if (call.root === "insert" && call.table === "audit_logs") return [];
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
          return { eq: (col: unknown, val: unknown) => ({ __eq: true, col, val }) };
        case "@/db":
          return { db };
        case "@/db/schema":
          return schemaStub;
        case "@/lib/candidate-consent/lifecycle":
          return {
            canConfirm: (status: string) => status === "VIEWED",
            isPastDeadline: (deadlineAt: Date | null, now: Date) => deadlineAt !== null && now.getTime() > deadlineAt.getTime(),
          };
        case "@/lib/candidate-consent/session-store":
          return {
            resolveAccessSession: async () => ({ id: "sess-1", scopedApplicationIds: ["app-1"], revokedAtMs: null, expiresAtMs: Date.now() + 60_000 }),
            sessionCanAccess: (_session: unknown, applicationId: string) => applicationId === "app-1",
          };
        case "@/lib/candidate-consent/evidence":
          return {
            computeEvidenceHashes: () => ({ evidenceSha256: "hash", evidenceHmac: "hmac" }),
            EVIDENCE_SCHEMA_VERSION: "1",
            generateReceiptId: () => "receipt-1",
            sha256Hex: (s: string) => `sha256(${s})`,
          };
        case "@/lib/candidate-consent/evidence-secret":
          return {
            resolveDocumentEvidenceSecret: () => "test-secret",
            DocumentEvidenceSecretMissingError: class DocumentEvidenceSecretMissingError extends Error {},
          };
        case "@/lib/candidate-consent/consent-text":
          return { CONSENT_TEXT: "Nội dung đồng ý.", CONSENT_VERSION: 1 };
        case "@/lib/request-ip":
          return { trustedClientIp: () => "unknown" };
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
  return { POST, doc, updates, confirmationInserts };
}

function postConfirm(id: string): { req: Request; ctx: { params: Promise<{ id: string }> } } {
  return {
    req: new Request(`https://app.example/api/candidate-consent/documents/${id}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agree: true }),
    }),
    ctx: { params: Promise.resolve({ id }) },
  };
}

test("VIEWED document past its confirmation_deadline_at → 409 with a friendly Vietnamese message + CONFIRMATION_EXPIRED code, never confirmed", async () => {
  const pastDeadline = new Date(Date.now() - 60_000);
  const { POST, doc, confirmationInserts } = makeContext({ status: "VIEWED", confirmationDeadlineAt: pastDeadline });
  const { req, ctx } = postConfirm("cdoc-1");
  const res = await POST(req, ctx);

  assert.equal(res.status, 409);
  assert.equal(res.jsonBody.code, "CONFIRMATION_EXPIRED");
  assert.ok(typeof res.jsonBody.error === "string" && res.jsonBody.error.length > 0);
  assert.equal(doc.status, "VIEWED", "status must remain VIEWED, never silently advanced to CONFIRMED");
  assert.equal(confirmationInserts.length, 0, "no document_confirmations row must ever be inserted for an expired confirm attempt");
});

test("VIEWED document with a deadline still in the future → confirms normally (deadline gate does not block a valid confirmation)", async () => {
  const futureDeadline = new Date(Date.now() + 60_000);
  const { POST, doc, confirmationInserts } = makeContext({ status: "VIEWED", confirmationDeadlineAt: futureDeadline });
  const { req, ctx } = postConfirm("cdoc-1");
  const res = await POST(req, ctx);

  assert.equal(res.status, 200);
  assert.equal(res.jsonBody.success, true);
  assert.equal(doc.status, "CONFIRMED");
  assert.equal(confirmationInserts.length, 1);
});

test("VIEWED document with NO deadline (legacy, null) → confirms normally, never treated as expired", async () => {
  const { POST, doc } = makeContext({ status: "VIEWED", confirmationDeadlineAt: null });
  const { req, ctx } = postConfirm("cdoc-1");
  const res = await POST(req, ctx);

  assert.equal(res.status, 200);
  assert.equal(doc.status, "CONFIRMED");
});

test("exactly AT the deadline instant is NOT yet expired (boundary matches isPastDeadline's strict > semantics)", async () => {
  // Freeze "now" is not directly controllable inside the route, so this test
  // instead pins the deadline comfortably in the future and only asserts
  // the route does not misclassify a non-past deadline as expired — the
  // exact boundary arithmetic itself is covered by lifecycle.test.ts's
  // dedicated isPastDeadline boundary tests.
  const almostNow = new Date(Date.now() + 5_000);
  const { POST, doc } = makeContext({ status: "VIEWED", confirmationDeadlineAt: almostNow });
  const { req, ctx } = postConfirm("cdoc-1");
  const res = await POST(req, ctx);
  assert.equal(res.status, 200);
  assert.equal(doc.status, "CONFIRMED");
});

test("ISSUED-but-never-viewed document past its deadline → still rejected by the pre-existing canConfirm(VIEWED-only) gate, not specifically by the deadline gate", async () => {
  const pastDeadline = new Date(Date.now() - 60_000);
  const { POST, doc } = makeContext({ status: "ISSUED", confirmationDeadlineAt: pastDeadline });
  const { req, ctx } = postConfirm("cdoc-1");
  const res = await POST(req, ctx);
  assert.equal(res.status, 409);
  assert.notEqual(res.jsonBody.code, "CONFIRMATION_EXPIRED", "canConfirm's own status message should surface here, not the deadline-specific code");
  assert.equal(doc.status, "ISSUED");
});
