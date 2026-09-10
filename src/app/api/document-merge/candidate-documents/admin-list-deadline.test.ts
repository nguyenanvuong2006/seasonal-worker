/**
 * GET /api/document-merge/candidate-documents — DEADLINE + ENGAGEMENT
 * regression tests (2026-09-10, Electronic Confirmation deadline mission).
 * Transpiles and RUNS the real route.ts against a fake DB, proving: each
 * row carries its own confirmationDeadlineAt and a computed effectiveStatus
 * (an ISSUED/VIEWED row past its deadline reports "EXPIRED" without the
 * persisted `status` column ever being touched — this route is READ-ONLY),
 * the summary counts bucket by effectiveStatus (an expired row is NOT
 * double-counted as both issued and expired), and the joined
 * engagementStartingDate surfaces employment_sessions.starting_date for the
 * new "Lần bắt đầu công việc" admin column.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createFakeDb, drizzleStub, makeTable } from "../../../../lib/test-support/fake-drizzle.ts";

const ROUTE_PATH = "src/app/api/document-merge/candidate-documents/route.ts";
const routeSource = readFileSync(new URL(`../../../../../${ROUTE_PATH}`, import.meta.url), "utf8");
const jsSource = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

const schemaStub = {
  candidateDocuments: makeTable("candidate_documents"),
  dailyApplications: makeTable("daily_applications"),
  documentConfirmations: makeTable("document_confirmations"),
  employmentSessions: makeTable("employment_sessions"),
  mergeTemplates: makeTable("merge_templates"),
};

type Row = {
  id: string;
  applicationId: string;
  status: string;
  templateId: string | null;
  templateName: string | null;
  pdfSha256: string | null;
  generatedAt: Date | null;
  issuedAt: Date | null;
  viewedAt: Date | null;
  errorMessage: string | null;
  applicantFullName: string | null;
  createdAt: Date;
  confirmationDeadlineAt: Date | null;
  employmentSessionId: string | null;
  engagementStartingDate: string | null;
};

type NextResponseLike = { status: number; jsonBody: Record<string, unknown> };

function loadRoute(rows: Row[]) {
  const db = createFakeDb({
    respond: (call) => {
      if (call.root === "select" && call.table === "candidate_documents") return rows;
      if (call.root === "select" && call.table === "document_confirmations") return [];
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
          };
        case "@/lib/candidate-consent/lifecycle": {
          function isPastDeadline(deadlineAt: Date | null, now: Date) {
            return deadlineAt !== null && now.getTime() > deadlineAt.getTime();
          }
          function effectiveStatus(status: string, deadlineAt: Date | null, now: Date) {
            if ((status === "ISSUED" || status === "VIEWED") && isPastDeadline(deadlineAt, now)) return "EXPIRED";
            return status;
          }
          return { effectiveStatus, isPastDeadline };
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

  return (moduleObj.exports as { GET: () => Promise<NextResponseLike> }).GET;
}

function baseRow(overrides: Partial<Row>): Row {
  return {
    id: "d1",
    applicationId: "a1",
    status: "ISSUED",
    templateId: null,
    templateName: null,
    pdfSha256: "hash",
    generatedAt: null,
    issuedAt: new Date(),
    viewedAt: null,
    errorMessage: null,
    applicantFullName: "Nguyễn Văn A",
    createdAt: new Date(),
    confirmationDeadlineAt: null,
    employmentSessionId: null,
    engagementStartingDate: null,
    ...overrides,
  };
}

test("ISSUED row past its confirmationDeadlineAt → effectiveStatus reports EXPIRED, persisted status column untouched (READ-ONLY route)", async () => {
  const GET = loadRoute([baseRow({ id: "d1", status: "ISSUED", confirmationDeadlineAt: new Date(Date.now() - 60_000) })]);
  const res = await GET();
  assert.equal(res.status, 200);
  const doc = (res.jsonBody.documents as Record<string, unknown>[])[0];
  assert.equal(doc.status, "ISSUED", "the raw persisted status must never be rewritten by a GET");
  assert.equal(doc.effectiveStatus, "EXPIRED");
});

test("VIEWED row before its deadline → effectiveStatus stays VIEWED", async () => {
  const GET = loadRoute([baseRow({ id: "d1", status: "VIEWED", confirmationDeadlineAt: new Date(Date.now() + 60_000) })]);
  const res = await GET();
  const doc = (res.jsonBody.documents as Record<string, unknown>[])[0];
  assert.equal(doc.effectiveStatus, "VIEWED");
});

test("summary counts bucket by effectiveStatus, not raw status — an expired ISSUED row is counted once, as expired, never also as issued", async () => {
  const GET = loadRoute([
    baseRow({ id: "d1", status: "ISSUED", confirmationDeadlineAt: new Date(Date.now() - 60_000) }), // expired
    baseRow({ id: "d2", status: "ISSUED", confirmationDeadlineAt: new Date(Date.now() + 60_000) }), // still issued
    baseRow({ id: "d3", status: "CONFIRMED", confirmationDeadlineAt: new Date(Date.now() - 60_000) }), // terminal, never expired
  ]);
  const res = await GET();
  const summary = res.jsonBody.summary as Record<string, number>;
  assert.equal(summary.total, 3);
  assert.equal(summary.expired, 1);
  assert.equal(summary.issued, 1);
  assert.equal(summary.confirmed, 1);
});

test("engagementStartingDate is surfaced from the employment_sessions join for the new 'Lần bắt đầu công việc' column", async () => {
  const GET = loadRoute([baseRow({ id: "d1", employmentSessionId: "es-1", engagementStartingDate: "2026-09-15" })]);
  const res = await GET();
  const doc = (res.jsonBody.documents as Record<string, unknown>[])[0];
  assert.equal(doc.engagementStartingDate, "2026-09-15");
});

test("legacy document with no employmentSessionId → engagementStartingDate is null, row still returned normally", async () => {
  const GET = loadRoute([baseRow({ id: "d1", employmentSessionId: null, engagementStartingDate: null })]);
  const res = await GET();
  assert.equal(res.status, 200);
  const doc = (res.jsonBody.documents as Record<string, unknown>[])[0];
  assert.equal(doc.engagementStartingDate, null);
});

test("null confirmationDeadlineAt (legacy, pre-feature document) never derives EXPIRED even if ISSUED long ago", async () => {
  const GET = loadRoute([baseRow({ id: "d1", status: "ISSUED", confirmationDeadlineAt: null })]);
  const res = await GET();
  const doc = (res.jsonBody.documents as Record<string, unknown>[])[0];
  assert.equal(doc.effectiveStatus, "ISSUED");
});
