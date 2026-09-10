/**
 * ELECTRONIC CONFIRMATION — query service regression tests (2026-09-10
 * mission). Loads the REAL confirmation-queries.ts source into a vm
 * sandbox (loadModule) against a fake Drizzle db, proving:
 *   - getElectronicConfirmationHistory returns ONE independent entry per
 *     engagement (employment_session), newest engagement first, and never
 *     merges/overwrites an old CONFIRMED entry with a newer one — the
 *     returning-worker invariant this mission requires.
 *   - getPendingConfirmations/getExpiringConfirmations/
 *     getExpiredUnconfirmedDocuments correctly partition ISSUED/VIEWED rows
 *     by deadline (not-yet-due / due-soon / already-past), using the SAME
 *     isPastDeadline() every other read path uses.
 *   - departmentIds=[] (Data Scope NONE) short-circuits to zero rows
 *     without even querying — never a fallback to "all".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { condsOf, createFakeDb, drizzleStub, inArrayValues, makeTable, type QueryCall } from "../test-support/fake-drizzle.ts";
import { loadModule, serverOnlyStub } from "../test-support/load-module.ts";

const employmentSessions = makeTable("employment_sessions");
const candidateDocuments = makeTable("candidate_documents");
const documentConfirmations = makeTable("document_confirmations");
const dailyApplications = makeTable("daily_applications");
const schemaStub = { employmentSessions, candidateDocuments, documentConfirmations, dailyApplications };

function isPastDeadlineReal(deadlineAt: Date | null, now: Date): boolean {
  return deadlineAt !== null && now.getTime() > deadlineAt.getTime();
}
function effectiveStatusReal(status: string, deadlineAt: Date | null, now: Date): string {
  if ((status === "ISSUED" || status === "VIEWED") && isPastDeadlineReal(deadlineAt, now)) return "EXPIRED";
  return status;
}
const lifecycleStub = { effectiveStatus: effectiveStatusReal, isPastDeadline: isPastDeadlineReal };

type Session = { id: string; workerId: string; startingDate: string };
type Doc = {
  id: string;
  applicationId: string;
  employmentSessionId: string | null;
  templateVersion: number | null;
  documentKind: string | null;
  status: string;
  issuedAt: Date | null;
  confirmationDeadlineAt: Date | null;
  viewedAt: Date | null;
};
type Confirmation = { candidateDocumentId: string; confirmedAtServer: Date; receiptId: string };
type AppRow = { id: string; deptId: string | null; fullName: string };

function loadService(fixtures: { sessions?: Session[]; docs?: Doc[]; confirmations?: Confirmation[]; apps?: AppRow[] }) {
  const sessions = fixtures.sessions ?? [];
  const docs = fixtures.docs ?? [];
  const confirmations = fixtures.confirmations ?? [];
  const apps = fixtures.apps ?? [];

  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.table === "employment_sessions" && call.root === "select") {
        // getElectronicConfirmationHistory: eq(workerId, ...)
        const conds = condsOf(call);
        const workerEq = conds.find((c) => c.op === "eq" && c.col === "employment_sessions.workerId") as { val: unknown } | undefined;
        if (workerEq) return sessions.filter((s) => s.workerId === workerEq.val);
        return sessions;
      }
      if (call.table === "candidate_documents" && call.root === "select") {
        const sessionIds = inArrayValues(call, "candidate_documents.employmentSessionId");
        if (sessionIds) return docs.filter((d) => d.employmentSessionId && sessionIds.includes(d.employmentSessionId));
        // fetchActionableRows: inArray(status, ["ISSUED","VIEWED"])
        const statusVals = inArrayValues(call, "candidate_documents.status");
        let rows = docs;
        if (statusVals) rows = rows.filter((d) => statusVals.includes(d.status));
        const deptVals = inArrayValues(call, "daily_applications.deptId");
        if (deptVals) {
          const appDeptById = new Map(apps.map((a) => [a.id, a.deptId]));
          rows = rows.filter((d) => appDeptById.get(d.applicationId) && deptVals.includes(appDeptById.get(d.applicationId)!));
        }
        return rows.map((d) => {
          const app = apps.find((a) => a.id === d.applicationId);
          return { ...d, applicantFullName: app?.fullName ?? "", deptId: app?.deptId ?? null };
        });
      }
      if (call.table === "document_confirmations" && call.root === "select") {
        const docIds = inArrayValues(call, "document_confirmations.candidateDocumentId");
        if (docIds) return confirmations.filter((c) => docIds.includes(c.candidateDocumentId));
        return confirmations;
      }
      return undefined;
    },
  });

  return loadModule(new URL("./confirmation-queries.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "drizzle-orm": drizzleStub,
      "@/db": { db },
      "@/db/schema": schemaStub,
      "./lifecycle": lifecycleStub,
    },
  }) as {
    getElectronicConfirmationHistory: (workerId: string) => Promise<unknown[]>;
    getPendingConfirmations: (departmentIds: string[] | null, limit: number) => Promise<unknown[]>;
    getExpiringConfirmations: (departmentIds: string[] | null, withinHours: number, limit: number) => Promise<unknown[]>;
    getExpiredUnconfirmedDocuments: (departmentIds: string[] | null, limit: number) => Promise<unknown[]>;
  };
}

test("getElectronicConfirmationHistory: worker with NO employment sessions -> empty history, never throws", async () => {
  const mod = loadService({});
  const result = await mod.getElectronicConfirmationHistory("worker-none");
  assert.equal(result.length, 0);
});

test("getElectronicConfirmationHistory: TWO independent engagements (returning worker) -> TWO independent entries, newest engagement first, neither overwrites the other", async () => {
  const mod = loadService({
    sessions: [
      { id: "sess-1", workerId: "w1", startingDate: "2026-01-01" },
      { id: "sess-2", workerId: "w1", startingDate: "2026-09-01" },
    ],
    docs: [
      { id: "doc-1", applicationId: "app-1", employmentSessionId: "sess-1", templateVersion: 1, documentKind: "GENERIC", status: "CONFIRMED", issuedAt: new Date("2026-01-05"), confirmationDeadlineAt: new Date("2026-01-08"), viewedAt: new Date("2026-01-06") },
      { id: "doc-2", applicationId: "app-2", employmentSessionId: "sess-2", templateVersion: 1, documentKind: "GENERIC", status: "ISSUED", issuedAt: new Date("2026-09-05"), confirmationDeadlineAt: new Date("2026-09-08"), viewedAt: null },
    ],
    confirmations: [{ candidateDocumentId: "doc-1", confirmedAtServer: new Date("2026-01-06"), receiptId: "receipt-1" }],
  });
  const result = (await mod.getElectronicConfirmationHistory("w1")) as { documentId: string; engagementStartingDate: string | null; effectiveStatus: string; receiptId: string | null }[];
  assert.equal(result.length, 2, "both engagements' documents must be present — never merged/dropped");
  assert.equal(result[0].documentId, "doc-2", "the newer engagement (2026-09-01) sorts first");
  assert.equal(result[1].documentId, "doc-1", "the OLD CONFIRMED document is still present, unmodified");
  assert.equal(result[1].effectiveStatus, "CONFIRMED");
  assert.equal(result[1].receiptId, "receipt-1");
});

test("getElectronicConfirmationHistory: an ISSUED document past its deadline reports effectiveStatus EXPIRED, without a persisted status change", async () => {
  const mod = loadService({
    sessions: [{ id: "sess-1", workerId: "w1", startingDate: "2020-01-01" }],
    docs: [{ id: "doc-1", applicationId: "app-1", employmentSessionId: "sess-1", templateVersion: 1, documentKind: "GENERIC", status: "ISSUED", issuedAt: new Date("2020-01-01"), confirmationDeadlineAt: new Date("2020-01-04"), viewedAt: null }],
  });
  const result = (await mod.getElectronicConfirmationHistory("w1")) as { effectiveStatus: string }[];
  assert.equal(result[0].effectiveStatus, "EXPIRED");
});

const NOW_BASE = Date.now();
const HOUR = 60 * 60 * 1000;

function actionableFixture() {
  return {
    docs: [
      { id: "pending-far", applicationId: "app-1", employmentSessionId: null, templateVersion: 1, documentKind: "GENERIC", status: "ISSUED", issuedAt: new Date(), confirmationDeadlineAt: new Date(NOW_BASE + 72 * HOUR), viewedAt: null },
      { id: "expiring-soon", applicationId: "app-2", employmentSessionId: null, templateVersion: 1, documentKind: "GENERIC", status: "VIEWED", issuedAt: new Date(), confirmationDeadlineAt: new Date(NOW_BASE + 5 * HOUR), viewedAt: new Date() },
      { id: "already-expired", applicationId: "app-3", employmentSessionId: null, templateVersion: 1, documentKind: "GENERIC", status: "ISSUED", issuedAt: new Date(), confirmationDeadlineAt: new Date(NOW_BASE - 5 * HOUR), viewedAt: null },
      { id: "confirmed-irrelevant", applicationId: "app-4", employmentSessionId: null, templateVersion: 1, documentKind: "GENERIC", status: "CONFIRMED", issuedAt: new Date(), confirmationDeadlineAt: new Date(NOW_BASE - 5 * HOUR), viewedAt: new Date() },
    ] as Doc[],
    apps: [
      { id: "app-1", deptId: "d1", fullName: "Nguyen Van A" },
      { id: "app-2", deptId: "d1", fullName: "Tran Thi B" },
      { id: "app-3", deptId: "d2", fullName: "Le Van C" },
      { id: "app-4", deptId: "d1", fullName: "Pham Thi D" },
    ] as AppRow[],
  };
}

test("getPendingConfirmations: only ISSUED/VIEWED rows still within their window, CONFIRMED and already-expired excluded, sorted soonest-first", async () => {
  const mod = loadService(actionableFixture());
  const result = (await mod.getPendingConfirmations(null, 20)) as { documentId: string }[];
  assert.deepEqual(Array.from(result, (r) => r.documentId), ["expiring-soon", "pending-far"]);
});

test("getExpiringConfirmations: only rows within the withinHours window (subset of pending), excludes far-out and already-expired", async () => {
  const mod = loadService(actionableFixture());
  const result = (await mod.getExpiringConfirmations(null, 24, 20)) as { documentId: string }[];
  assert.deepEqual(Array.from(result, (r) => r.documentId), ["expiring-soon"]);
});

test("getExpiredUnconfirmedDocuments: only rows already past their deadline, CONFIRMED excluded even though its deadline also passed", async () => {
  const mod = loadService(actionableFixture());
  const result = (await mod.getExpiredUnconfirmedDocuments(null, 20)) as { documentId: string }[];
  assert.deepEqual(Array.from(result, (r) => r.documentId), ["already-expired"]);
});

test("Data Scope: departmentIds narrows results to that department only", async () => {
  const mod = loadService(actionableFixture());
  const result = (await mod.getPendingConfirmations(["d1"], 20)) as { documentId: string; deptId: string | null }[];
  assert.deepEqual(Array.from(result, (r) => r.documentId), ["expiring-soon", "pending-far"]);
  assert.ok(result.every((r) => r.deptId === "d1"));
});

test("Data Scope: departmentIds=[] (NONE) short-circuits to zero rows without querying", async () => {
  const mod = loadService(actionableFixture());
  const pending = await mod.getPendingConfirmations([], 20);
  const expiring = await mod.getExpiringConfirmations([], 24, 20);
  const expired = await mod.getExpiredUnconfirmedDocuments([], 20);
  assert.equal(pending.length, 0);
  assert.equal(expiring.length, 0);
  assert.equal(expired.length, 0);
});

test("a document with NO confirmationDeadlineAt (legacy, pre-feature) never appears in pending/expiring/expired — it has no deadline-driven urgency", async () => {
  const mod = loadService({
    docs: [{ id: "legacy-no-deadline", applicationId: "app-1", employmentSessionId: null, templateVersion: 1, documentKind: "GENERIC", status: "ISSUED", issuedAt: new Date(), confirmationDeadlineAt: null, viewedAt: null }],
    apps: [{ id: "app-1", deptId: "d1", fullName: "Nguyen Van A" }],
  });
  assert.equal((await mod.getPendingConfirmations(null, 20)).length, 0);
  assert.equal((await mod.getExpiringConfirmations(null, 999, 20)).length, 0);
  assert.equal((await mod.getExpiredUnconfirmedDocuments(null, 20)).length, 0);
});
