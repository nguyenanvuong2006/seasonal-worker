/**
 * GET /api/candidate-consent/documents — DEADLINE + ACTIONABLE SORT
 * regression tests (2026-09-10, Electronic Confirmation deadline mission).
 * Sibling file (route.ts itself is not under a bracket directory here, but
 * keeping the naming convention consistent with the other deadline tests
 * in this feature).
 *
 * Proves: each visible row carries confirmationDeadlineAt + a derived
 * effectiveStatus + an `actionable` flag; actionable rows (ISSUED/VIEWED,
 * not yet expired) sort BEFORE pure-history rows (CONFIRMED/EXPIRED)
 * regardless of raw insertion order — this is the "CẦN XÁC NHẬN" vs
 * "LỊCH SỬ" split the candidate lookup UI depends on; and within the
 * actionable group, the soonest deadline sorts first (most urgent).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createFakeDb, drizzleStub, makeTable } from "../../../../lib/test-support/fake-drizzle.ts";

const ROUTE_PATH = "src/app/api/candidate-consent/documents/route.ts";
const routeSource = readFileSync(new URL(`../../../../../${ROUTE_PATH}`, import.meta.url), "utf8");
const jsSource = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

const schemaStub = {
  candidateDocuments: makeTable("candidate_documents"),
  dailyApplications: makeTable("daily_applications"),
  documentConfirmations: makeTable("document_confirmations"),
  mergeTemplates: makeTable("merge_templates"),
};

type Row = {
  id: string;
  applicationId: string;
  status: string;
  issuedAt: Date | null;
  confirmationDeadlineAt: Date | null;
  templateName: string | null;
  templateVersion: number | null;
  regDate: string | null;
};

type NextResponseLike = { status: number; jsonBody: Record<string, unknown> };

function loadRoute(rows: Row[], scopedApplicationIds: string[] = rows.map((r) => r.applicationId)) {
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
        case "@/lib/candidate-consent/session-store":
          return {
            resolveAccessSession: async () => ({ id: "sess-1", scopedApplicationIds, revokedAtMs: null, expiresAtMs: Date.now() + 60_000 }),
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

  return (moduleObj.exports as { GET: () => Promise<NextResponseLike> }).GET;
}

function baseRow(overrides: Partial<Row>): Row {
  return {
    id: "d1",
    applicationId: "a1",
    status: "ISSUED",
    issuedAt: new Date(),
    confirmationDeadlineAt: null,
    templateName: "Template",
    templateVersion: 1,
    regDate: "2026-09-01",
    ...overrides,
  };
}

test("READY document is excluded entirely (not visible to the candidate), existing behavior preserved", async () => {
  const GET = loadRoute([baseRow({ id: "d1", status: "READY" })]);
  const res = await GET();
  assert.equal((res.jsonBody.documents as unknown[]).length, 0);
});

test("actionable (ISSUED/VIEWED, not expired) rows sort BEFORE history (CONFIRMED) rows regardless of raw order", async () => {
  const now = Date.now();
  const GET = loadRoute([
    baseRow({ id: "confirmed-old", applicationId: "a1", status: "CONFIRMED", issuedAt: new Date(now - 10_000) }),
    baseRow({ id: "issued-new", applicationId: "a2", status: "ISSUED", confirmationDeadlineAt: new Date(now + 3 * 24 * 60 * 60 * 1000) }),
  ]);
  const res = await GET();
  const docs = res.jsonBody.documents as { id: string; actionable: boolean }[];
  assert.equal(docs[0].id, "issued-new");
  assert.equal(docs[0].actionable, true);
  assert.equal(docs[1].id, "confirmed-old");
  assert.equal(docs[1].actionable, false);
});

test("an EXPIRED (derived) row is treated as history, sorted after actionable rows", async () => {
  const now = Date.now();
  const GET = loadRoute([
    baseRow({ id: "expired-1", applicationId: "a1", status: "ISSUED", confirmationDeadlineAt: new Date(now - 60_000) }),
    baseRow({ id: "issued-1", applicationId: "a2", status: "VIEWED", confirmationDeadlineAt: new Date(now + 60_000) }),
  ]);
  const res = await GET();
  const docs = res.jsonBody.documents as { id: string; effectiveStatus: string; actionable: boolean }[];
  assert.equal(docs[0].id, "issued-1");
  assert.equal(docs[1].id, "expired-1");
  assert.equal(docs[1].effectiveStatus, "EXPIRED");
  assert.equal(docs[1].actionable, false);
});

test("within the actionable group, soonest deadline sorts first (most urgent)", async () => {
  const now = Date.now();
  const GET = loadRoute([
    baseRow({ id: "far", applicationId: "a1", status: "ISSUED", confirmationDeadlineAt: new Date(now + 7 * 24 * 60 * 60 * 1000) }),
    baseRow({ id: "near", applicationId: "a2", status: "VIEWED", confirmationDeadlineAt: new Date(now + 1 * 24 * 60 * 60 * 1000) }),
  ]);
  const res = await GET();
  const docs = res.jsonBody.documents as { id: string }[];
  assert.deepEqual(Array.from(docs, (d) => d.id), ["near", "far"]);
});

test("returning-worker scenario: TWO independent engagements (old CONFIRMED + new actionable ISSUED) both remain in the list — history is never dropped", async () => {
  const now = Date.now();
  const GET = loadRoute([
    baseRow({ id: "engagement-1-confirmed", applicationId: "a1", status: "CONFIRMED", issuedAt: new Date(now - 90 * 24 * 60 * 60 * 1000) }),
    baseRow({ id: "engagement-2-issued", applicationId: "a2", status: "ISSUED", confirmationDeadlineAt: new Date(now + 3 * 24 * 60 * 60 * 1000) }),
  ]);
  const res = await GET();
  const docs = res.jsonBody.documents as { id: string }[];
  assert.equal(docs.length, 2, "both engagements' documents must be present — the old CONFIRMED one is never overwritten or hidden");
  assert.deepEqual(Array.from(docs, (d) => d.id).sort(), ["engagement-1-confirmed", "engagement-2-issued"]);
});
