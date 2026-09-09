/**
 * EXECUTION tests for GET /api/xac-thuc-ho-so/[token] — transpiles and RUNS
 * the real route.ts (same convention as issue-ready-execution.test.ts)
 * against a fake DB, with the REAL rate-limiter.ts / identity.ts /
 * request-ip.ts / verification-service.ts (imported for real at the top of
 * this file, then handed into the vm's require shim as the SAME module
 * objects) — only "next/server", "drizzle-orm", "@/db", "@/db/schema", and
 * "@/lib/candidate-consent/evidence-secret" (which carries `import
 * "server-only"`, unresolvable outside Next's webpack) are stubbed.
 *
 * This proves genuine runtime behavior: a wrong token really returns
 * NOT_FOUND before any candidate_documents/daily_applications read, rate
 * limiting really blocks before evidence is touched, and a successful
 * lookup never writes to candidate_documents/document_confirmations.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { condsOf, createFakeDb, drizzleStub, argOf, makeTable, type FakeDb, type QueryCall } from "../../../lib/test-support/fake-drizzle.ts";
import * as verificationService from "../../../lib/candidate-consent/verification-service.ts";
import * as rateLimiter from "../../../lib/candidate-consent/rate-limiter.ts";
import * as identity from "../../../lib/candidate-consent/identity.ts";
import * as requestIp from "../../../lib/request-ip.ts";
import { buildCanonicalEvidencePayload, canonicalizeEvidence, sha256Hex, hmacSha256Hex } from "../../../lib/candidate-consent/evidence.ts";

const ROUTE_PATH = "src/app/api/xac-thuc-ho-so/[token]/route.ts";
const routeSource = readFileSync(new URL(`../../../../${ROUTE_PATH}`, import.meta.url), "utf8");
const jsSource = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

process.env.AUTH_SECRET ||= "unit-test-secret-never-used-in-production";

const TEST_SECRET = "route-test-only-evidence-secret";

const schemaStub = {
  candidateDocuments: makeTable("candidate_documents"),
  dailyApplications: makeTable("daily_applications"),
  documentConfirmations: makeTable("document_confirmations"),
  identityLookupAttempts: makeTable("identity_lookup_attempts"),
  mergeTemplates: makeTable("merge_templates"),
};

type ConfirmationFixture = {
  receiptId: string;
  candidateDocumentId: string;
  applicationId: string;
  pdfSha256: string;
  consentVersion: string;
  consentTextHash: string;
  identityVerificationMethod: string;
  identityVerifiedAt: Date;
  confirmedAtServer: Date;
  accessSessionId: string;
  ipAddress: string | null;
  userAgent: string | null;
  canonicalEvidenceHash: string;
  evidenceHmac: string | null;
};

type DocumentFixture = {
  id: string;
  status: string;
  pdfSha256: string | null;
  templateVersion: number | null;
  revokedAt: Date | null;
  templateName: string | null;
};

/** Builds a confirmation fixture whose stored hashes are genuinely valid for TEST_SECRET. */
function validConfirmation(overrides: Partial<ConfirmationFixture> = {}): ConfirmationFixture {
  const base: Omit<ConfirmationFixture, "canonicalEvidenceHash" | "evidenceHmac"> = {
    receiptId: "SIG-ROUTETEST0000001",
    candidateDocumentId: "doc-1",
    applicationId: "app-1",
    pdfSha256: "a".repeat(64),
    consentVersion: "1",
    consentTextHash: "consent-hash",
    identityVerificationMethod: "CCCD_PHONE",
    identityVerifiedAt: new Date("2026-09-09T10:15:00.000Z"),
    confirmedAtServer: new Date("2026-09-09T10:20:44.000Z"),
    accessSessionId: "session-1",
    ipAddress: "203.0.113.7",
    userAgent: "Mozilla/5.0",
    ...overrides,
  };
  const payload = canonicalizeEvidence(
    buildCanonicalEvidencePayload({
      documentId: base.candidateDocumentId,
      documentVersion: 5,
      documentSha256: base.pdfSha256,
      applicationId: base.applicationId,
      identityVerificationMethod: base.identityVerificationMethod,
      identityVerifiedAt: base.identityVerifiedAt.toISOString(),
      consentVersion: base.consentVersion,
      consentTextHash: base.consentTextHash,
      confirmedAtServer: base.confirmedAtServer.toISOString(),
      accessSessionId: base.accessSessionId,
      ipAddress: base.ipAddress,
      userAgent: base.userAgent,
      receiptId: base.receiptId,
    }),
  );
  return {
    ...base,
    canonicalEvidenceHash: overrides.canonicalEvidenceHash ?? sha256Hex(payload),
    evidenceHmac: "evidenceHmac" in overrides ? overrides.evidenceHmac ?? null : hmacSha256Hex(payload, TEST_SECRET),
  };
}

function loadRoute(opts: { confirmation: ConfirmationFixture | null; doc: DocumentFixture | null; applicantFullName?: string | null }) {
  const limiterRows = new Map<string, { attemptCount: number; windowStartAt: Date; lockedUntil: Date | null; lockoutStrikes: number }>();

  const db: FakeDb = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.table === "identity_lookup_attempts") {
        if (call.root === "select") {
          const match = condsOf(call).find((c) => c.op === "eq" && c.col === "identity_lookup_attempts.limiterKey") as
            | { val: string }
            | undefined;
          const row = match ? limiterRows.get(match.val) : undefined;
          return row ? [row] : [];
        }
        if (call.root === "insert") {
          const values = argOf(call, "values") as { limiterKey: string; attemptCount: number; windowStartAt: Date; lockedUntil: Date | null; lockoutStrikes: number };
          limiterRows.set(values.limiterKey, { attemptCount: values.attemptCount, windowStartAt: values.windowStartAt, lockedUntil: values.lockedUntil, lockoutStrikes: values.lockoutStrikes });
          return [];
        }
      }
      if (call.table === "document_confirmations") {
        const selectArg = argOf(call, "select");
        const isCountQuery = selectArg && typeof selectArg === "object" && Object.keys(selectArg as object).length === 1 && "id" in (selectArg as object);
        if (isCountQuery) {
          if (!opts.confirmation) return [];
          return [{ id: opts.confirmation.receiptId }];
        }
        return opts.confirmation ? [opts.confirmation] : [];
      }
      if (call.table === "candidate_documents") {
        return opts.doc ? [opts.doc] : [];
      }
      if (call.table === "daily_applications") {
        return opts.applicantFullName !== undefined ? [{ fullName: opts.applicantFullName }] : [];
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
              json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
                status: init?.status ?? 200,
                jsonBody: body,
                headers: init?.headers ?? {},
              }),
            },
          };
        case "drizzle-orm":
          return drizzleStub;
        case "@/db":
          return { db };
        case "@/db/schema":
          return schemaStub;
        case "@/lib/candidate-consent/verification-service":
          return verificationService;
        case "@/lib/candidate-consent/rate-limiter":
          return rateLimiter;
        case "@/lib/candidate-consent/identity":
          return identity;
        case "@/lib/request-ip":
          return requestIp;
        case "@/lib/candidate-consent/evidence-secret":
          return {
            resolveDocumentEvidenceSecret: () => TEST_SECRET,
            DocumentEvidenceSecretMissingError: class DocumentEvidenceSecretMissingError extends Error {},
          };
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

  const GET = (moduleObj.exports as { GET: (req: Request, ctx: { params: Promise<{ token: string }> }) => Promise<{ status: number; jsonBody: unknown }> }).GET;
  return { GET, db };
}

function getWith(token: string, ip = "198.51.100.1"): { req: Request; ctx: { params: Promise<{ token: string }> } } {
  return {
    req: new Request(`https://app.example/api/xac-thuc-ho-so/${encodeURIComponent(token)}`, {
      headers: { "x-forwarded-for": ip },
    }),
    ctx: { params: Promise.resolve({ token }) },
  };
}

test("valid receipt id => 200 VALID DTO, no PII/secret fields, no writes to candidate_documents/document_confirmations", async () => {
  const confirmation = validConfirmation();
  const doc: DocumentFixture = {
    id: confirmation.candidateDocumentId,
    status: "CONFIRMED",
    pdfSha256: confirmation.pdfSha256,
    templateVersion: 5,
    revokedAt: null,
    templateName: "Đăng ký tập nghề",
  };
  const { GET, db } = loadRoute({ confirmation, doc, applicantFullName: "nguyen van a" });
  const { req, ctx } = getWith(confirmation.receiptId);
  const res = await GET(req, ctx);

  assert.equal(res.status, 200);
  const dto = res.jsonBody as Record<string, unknown>;
  assert.equal(dto.status, "VALID");
  assert.equal(dto.receiptId, confirmation.receiptId);
  assert.equal(dto.candidateDisplayName, "Nguyen Van A");
  for (const forbidden of ["ipAddress", "userAgent", "evidenceHmac", "canonicalEvidenceHash", "accessSessionId", "documentId", "applicationId"]) {
    assert.ok(!(forbidden in dto), `DTO must never expose "${forbidden}"`);
  }

  assert.equal(db.writesTo("candidate_documents").length, 0, "verification must never write candidate_documents");
  assert.equal(db.writesTo("document_confirmations").length, 0, "verification must never write document_confirmations");
  assert.ok(db.writesTo("identity_lookup_attempts").length > 0, "rate-limit bookkeeping write is the ONLY allowed write");
});

test("wrong/unknown receipt id => generic 404 NOT_FOUND, candidate_documents/daily_applications never read", async () => {
  const { GET, db } = loadRoute({ confirmation: null, doc: null });
  const { req, ctx } = getWith("SIG-DOES-NOT-EXIST");
  const res = await GET(req, ctx);

  assert.equal(res.status, 404);
  // res.jsonBody was constructed inside the vm's own realm — compare the
  // field, never the whole object (cross-realm objects are never
  // reference-equal to a host object literal even with identical content).
  assert.equal((res.jsonBody as { status: string }).status, "NOT_FOUND");
  assert.equal(db.calls.filter((c) => c.table === "candidate_documents").length, 0);
  assert.equal(db.calls.filter((c) => c.table === "daily_applications").length, 0);
});

test("revoked document (intact evidence) => 200 REVOKED, evidence not disturbed", async () => {
  const confirmation = validConfirmation({ receiptId: "SIG-REVOKEDTEST0001" });
  const doc: DocumentFixture = {
    id: confirmation.candidateDocumentId,
    status: "REVOKED",
    pdfSha256: confirmation.pdfSha256,
    templateVersion: 5,
    revokedAt: new Date("2026-09-10T00:00:00.000Z"),
    templateName: "Đăng ký tập nghề",
  };
  const { GET } = loadRoute({ confirmation, doc, applicantFullName: "nguyen van b" });
  const { req, ctx } = getWith(confirmation.receiptId);
  const res = await GET(req, ctx);

  assert.equal(res.status, 200);
  const dto = res.jsonBody as Record<string, unknown>;
  assert.equal(dto.status, "REVOKED");
});

test("rate limit exceeded => 429 (enumeration guard: repeated WRONG tokens never reset the bucket)", async () => {
  // A wrong token never succeeds, so it never resets the IP's window (only
  // a successful lookup does — see the route's own docblock) — exactly the
  // enumeration scenario the limiter exists to stop. A legitimate user
  // re-checking their OWN valid receipt, by contrast, is never throttled
  // (covered by not hitting this path at all in the "valid receipt id" test).
  const { GET } = loadRoute({ confirmation: null, doc: null });

  const ip = "198.51.100.99";
  let lastRes: { status: number; jsonBody: unknown } | null = null;
  for (let i = 0; i < 6; i += 1) {
    const { req, ctx } = getWith(`SIG-GUESS-${i}`, ip);
    lastRes = await GET(req, ctx);
  }

  assert.equal(lastRes!.status, 429);
  const body = lastRes!.jsonBody as Record<string, unknown>;
  assert.ok(!("receiptId" in body));
  assert.ok(!("status" in body) || body.status !== "NOT_FOUND", "a 429 must not also claim NOT_FOUND — it's a distinct outcome");
});
