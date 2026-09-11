/**
 * WORKER 360° PROFILE — canonical service regression tests (2026-09-10+
 * mission). Loads the REAL worker-360-profile.ts source (loadModule + a
 * fake Drizzle db) — proves the actual assembly logic, not a hand-copied
 * re-implementation. Data-Scope-touching helpers (data-scope.ts,
 * person-name.ts, lifecycle.ts) are PURE (zero imports of their own) so
 * they are loaded FOR REAL via a nested loadModule call rather than
 * hand-reimplemented — no risk of the test's own copy drifting from
 * production logic. workforce-roster.ts and confirmation-queries.ts are
 * stubbed (each already has its own dedicated test file).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { condsOf, createFakeDb, drizzleStub, eqValue, inArrayValues, makeTable, type QueryCall } from "./test-support/fake-drizzle.ts";
import { loadModule, serverOnlyStub } from "./test-support/load-module.ts";

const dataScopeModule = loadModule(new URL("./data-scope.ts", import.meta.url), { stubs: {} });
const personNameModule = loadModule(new URL("./person-name.ts", import.meta.url), { stubs: {} });
const lifecycleModule = loadModule(new URL("./candidate-consent/lifecycle.ts", import.meta.url), { stubs: {} });

const schemaStub = {
  candidateDocuments: makeTable("candidate_documents"),
  dailyApplications: makeTable("daily_applications"),
  departments: makeTable("departments"),
  documentConfirmations: makeTable("document_confirmations"),
  employmentSessions: makeTable("employment_sessions"),
  recruitmentRequests: makeTable("recruitment_requests"),
  requestAllocations: makeTable("request_allocations"),
  workerProfiles: makeTable("worker_profiles"),
  workforceMovements: makeTable("workforce_movements"),
};

type Fixtures = {
  profile: { id: string; cccd: string; fullName: string; fingerprintCode: string | null; fingerprintStatus: string | null; deletedAt: Date | null };
  sessions: { id: string; regDate: string; status: string; startingDate: string | null; endDate: string | null; endReason: string | null; endedBy: string | null; startDateSource: string | null; dailyApplicationId: string | null; note: string | null; deptId: string | null }[];
  departments: { id: string; deptName: string; groupName: string | null; section: string | null }[];
  dailyApplicationsItCode: { id: string; itCode: string | null }[];
  movements: { id: string; movementType: string; fromDeptId: string | null; toDeptId: string | null; effectiveDate: string; status: string; reason: string | null; confirmedBy: string | null; confirmedAt: Date | null; lifecycleAppliedAt: Date | null; employmentSessionId: string | null; createdAt: Date }[];
  confirmationHistory: { documentId: string; applicationId: string; employmentSessionId: string | null; engagementStartingDate: string | null; templateVersion: number | null; templateName: string | null; documentKind: string | null; status: string; effectiveStatus: string; issuedAt: string | null; confirmationDeadlineAt: string | null; viewedAt: string | null; confirmedAt: string | null; receiptId: string | null; supersedesDocumentId: string | null }[];
  legacyDocs: { id: string; applicationId: string; templateVersion: number | null; documentKind: string | null; status: string; issuedAt: Date | null; confirmationDeadlineAt: Date | null; viewedAt: Date | null; supersedesDocumentId: string | null; cccd: string }[];
  legacyConfirmations: { candidateDocumentId: string; confirmedAtServer: Date; receiptId: string }[];
  requestAllocations: { id: string; employmentSessionId: string; requestId: string; status: string; startedAt: Date; endedAt: Date | null; endReason: string | null }[];
  recruitmentRequests: { id: string; requestCode: string; status: string }[];
};

function loadService(fx: Fixtures) {
  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.table === "worker_profiles" && call.root === "select") {
        const idEq = eqValue(call, "worker_profiles.id") as string | undefined;
        return idEq === fx.profile.id && !fx.profile.deletedAt ? [fx.profile] : idEq === fx.profile.id ? [] : [];
      }
      if (call.table === "employment_sessions" && call.root === "select") {
        const conds = condsOf(call);
        const workerEq = conds.find((c) => c.op === "eq" && c.col === "employment_sessions.workerId") as { val: unknown } | undefined;
        if (!workerEq || workerEq.val !== fx.profile.id) return [];
        const deptScope = inArrayValues(call, "employment_sessions.deptId");
        let rows = fx.sessions;
        if (deptScope) rows = rows.filter((s) => s.deptId !== null && deptScope.includes(s.deptId));
        return rows;
      }
      if (call.table === "departments" && call.root === "select") {
        const ids = inArrayValues(call, "departments.id");
        return ids ? fx.departments.filter((d) => ids.includes(d.id)) : fx.departments;
      }
      if (call.table === "daily_applications" && call.root === "select") {
        const ids = inArrayValues(call, "daily_applications.id");
        return ids ? fx.dailyApplicationsItCode.filter((a) => ids.includes(a.id)) : fx.dailyApplicationsItCode;
      }
      if (call.table === "workforce_movements" && call.root === "select") {
        const conds = condsOf(call);
        const workerEq = conds.find((c) => c.op === "eq" && c.col === "workforce_movements.workerId") as { val: unknown } | undefined;
        return workerEq && workerEq.val === fx.profile.id ? fx.movements : [];
      }
      if (call.table === "candidate_documents" && call.root === "select") {
        // Legacy/unlinked doc lookup: isNull(employmentSessionId) AND eq(dailyApplications.cccd, profile.cccd).
        return fx.legacyDocs.filter((d) => d.cccd === fx.profile.cccd).map((d) => ({ ...d }));
      }
      if (call.table === "document_confirmations" && call.root === "select") {
        const ids = inArrayValues(call, "document_confirmations.candidateDocumentId");
        return ids ? fx.legacyConfirmations.filter((c) => ids.includes(c.candidateDocumentId)) : [];
      }
      if (call.table === "request_allocations" && call.root === "select") {
        const ids = inArrayValues(call, "request_allocations.employmentSessionId");
        return ids ? fx.requestAllocations.filter((a) => ids.includes(a.employmentSessionId)) : [];
      }
      if (call.table === "recruitment_requests" && call.root === "select") {
        const ids = inArrayValues(call, "recruitment_requests.id");
        return ids ? fx.recruitmentRequests.filter((r) => ids.includes(r.id)) : [];
      }
      return undefined;
    },
  });

  return loadModule(new URL("./worker-360-profile.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "drizzle-orm": drizzleStub,
      "@/db": { db },
      "@/db/schema": schemaStub,
      "./data-scope": dataScopeModule,
      "./person-name": personNameModule,
      "./candidate-consent/lifecycle": lifecycleModule,
      "./workforce-roster": {
        getWorkerCurrentState: async () => ({ lifecycleState: "ACTIVE", deptId: "d2", deptName: "Dept B", groupName: null, section: null, startingDate: "2026-09-01", upcoming: null }),
      },
      "./candidate-consent/confirmation-queries": {
        getElectronicConfirmationHistory: async () => fx.confirmationHistory,
      },
    },
  }) as { getWorker360Profile: (workerId: string, scope: string[] | null) => Promise<unknown> };
}

function baseFixtures(): Fixtures {
  return {
    profile: { id: "w1", cccd: "010000000001", fullName: "nguyen van a", fingerprintCode: "FP1", fingerprintStatus: "DA_CAP", deletedAt: null },
    sessions: [
      { id: "sess-1", regDate: "2026-01-01", status: "APPROVED", startingDate: "2026-01-01", endDate: "2026-06-01", endReason: "TRANSFER", endedBy: null, startDateSource: "ASSIGNMENT", dailyApplicationId: "app-1", note: null, deptId: "d2" },
      { id: "sess-2", regDate: "2026-07-01", status: "APPROVED", startingDate: "2026-07-01", endDate: null, endReason: null, endedBy: null, startDateSource: "ASSIGNMENT", dailyApplicationId: "app-2", note: null, deptId: "d2" },
    ],
    departments: [
      { id: "d1", deptName: "Dept A", groupName: null, section: null },
      { id: "d2", deptName: "Dept B", groupName: null, section: null },
    ],
    dailyApplicationsItCode: [
      { id: "app-1", itCode: "IT001" },
      { id: "app-2", itCode: "IT002" },
    ],
    movements: [
      { id: "m1", movementType: "transfer", fromDeptId: "d1", toDeptId: "d2", effectiveDate: "2026-06-01", status: "TRANSFER_COMPLETED", reason: null, confirmedBy: "hr1", confirmedAt: new Date("2026-05-30"), lifecycleAppliedAt: new Date("2026-06-01"), employmentSessionId: "sess-1", createdAt: new Date("2026-05-25") },
    ],
    confirmationHistory: [
      { documentId: "doc-1", applicationId: "app-1", employmentSessionId: "sess-1", engagementStartingDate: "2026-01-01", templateVersion: 1, templateName: "Mau A", documentKind: "GENERIC", status: "CONFIRMED", effectiveStatus: "CONFIRMED", issuedAt: "2026-01-02T00:00:00Z", confirmationDeadlineAt: "2026-01-05T00:00:00Z", viewedAt: "2026-01-02T01:00:00Z", confirmedAt: "2026-01-02T02:00:00Z", receiptId: "receipt-1", supersedesDocumentId: null },
      { documentId: "doc-2", applicationId: "app-2", employmentSessionId: "sess-2", engagementStartingDate: "2026-07-01", templateVersion: 1, templateName: "Mau A", documentKind: "GENERIC", status: "ISSUED", effectiveStatus: "ISSUED", issuedAt: "2026-07-02T00:00:00Z", confirmationDeadlineAt: "2026-07-05T00:00:00Z", viewedAt: null, confirmedAt: null, receiptId: null, supersedesDocumentId: null },
    ],
    legacyDocs: [],
    legacyConfirmations: [],
    requestAllocations: [
      { id: "alloc-1", employmentSessionId: "sess-1", requestId: "rq-1", status: "ENDED", startedAt: new Date("2026-01-01"), endedAt: new Date("2026-06-01"), endReason: "TRANSFER" },
      { id: "alloc-2", employmentSessionId: "sess-2", requestId: "rq-2", status: "ACTIVE", startedAt: new Date("2026-07-01"), endedAt: null, endReason: null },
    ],
    recruitmentRequests: [
      { id: "rq-1", requestCode: "RQ-001", status: "COMPLETED" },
      { id: "rq-2", requestCode: "RQ-002", status: "PENDING" },
    ],
  };
}

test("GLOBAL scope (ADMIN): returns both engagements, movements, and documents", async () => {
  const mod = loadService(baseFixtures());
  const profile = (await mod.getWorker360Profile("w1", null)) as { engagements: { session: { id: string } }[] };
  assert.equal(profile.engagements.length, 2);
  assert.deepEqual(Array.from(profile.engagements, (e) => e.session.id), ["sess-1", "sess-2"], "server order preserved (newest-first is the DB's own orderBy, not re-sorted here)");
});

test("worker not found -> null", async () => {
  const mod = loadService(baseFixtures());
  const profile = await mod.getWorker360Profile("nonexistent", null);
  assert.equal(profile, null);
});

test("soft-deleted worker -> null, even for ADMIN (GLOBAL scope)", async () => {
  const fx = baseFixtures();
  fx.profile.deletedAt = new Date();
  const mod = loadService(fx);
  const profile = await mod.getWorker360Profile("w1", null);
  assert.equal(profile, null);
});

test("Data Scope NONE (scope=[]) -> null, never a global existence oracle", async () => {
  const mod = loadService(baseFixtures());
  const profile = await mod.getWorker360Profile("w1", []);
  assert.equal(profile, null);
});

test("Data Scope: manager scoped to d2 sees BOTH engagements (both sessions currently in d2 after the transfer) — IDOR test: manager scoped to d1 (neither session's CURRENT dept) sees NOTHING -> null", async () => {
  const mod = loadService(baseFixtures());
  const inScope = (await mod.getWorker360Profile("w1", ["d2"])) as { engagements: unknown[] } | null;
  assert.ok(inScope);
  assert.equal(inScope!.engagements.length, 2);

  const outOfScope = await mod.getWorker360Profile("w1", ["d1"]);
  assert.equal(outOfScope, null, "a manager whose scope matches NEITHER session's current department must get 404-equivalent null, not a leaked profile");
});

test("movement redaction: manager scoped to d2 (destination) sees the transfer with fromDept REDACTED (REDACTED_INCOMING)", async () => {
  const mod = loadService(baseFixtures());
  const profile = (await mod.getWorker360Profile("w1", ["d2"])) as { engagements: { session: { id: string }; movements: { movementType: string; fromDeptId: string | null; fromDeptName: string | null; toDeptId: string | null }[] }[] };
  const sess1 = profile.engagements.find((e) => e.session.id === "sess-1")!;
  assert.equal(sess1.movements.length, 1);
  assert.equal(sess1.movements[0].fromDeptId, null, "fromDept must be redacted for a manager who only has scope on the destination department");
  assert.equal(sess1.movements[0].toDeptId, "d2");
});

test("movement FULL visibility: a manager scoped to BOTH d1 and d2 sees the transfer with fromDept intact", async () => {
  const mod = loadService(baseFixtures());
  const profile = (await mod.getWorker360Profile("w1", ["d1", "d2"])) as { engagements: { session: { id: string }; movements: { fromDeptId: string | null; fromDeptName: string | null }[] }[] };
  const sess1 = profile.engagements.find((e) => e.session.id === "sess-1")!;
  assert.equal(sess1.movements[0].fromDeptId, "d1");
  assert.equal(sess1.movements[0].fromDeptName, "Dept A");
});

test("WORKER 360 HISTORY (Phase 6, historical workforce lifecycle reconciliation mission) — a movement reports the ORIGINAL request date (createdAt) distinct from the HR approval date (confirmedAt) and the lifecycle-applied date, never fabricated/omitted", async () => {
  const mod = loadService(baseFixtures());
  const profile = (await mod.getWorker360Profile("w1", null)) as { engagements: { session: { id: string }; movements: { requestedAt: string; confirmedAt: string | null; lifecycleAppliedAt: string | null }[] }[] };
  const sess1 = profile.engagements.find((e) => e.session.id === "sess-1")!;
  const movement = sess1.movements[0];
  assert.equal(movement.requestedAt, new Date("2026-05-25").toISOString());
  assert.equal(movement.confirmedAt, new Date("2026-05-30").toISOString());
  assert.equal(movement.lifecycleAppliedAt, new Date("2026-06-01").toISOString());
  assert.ok(
    movement.requestedAt < movement.confirmedAt! && movement.confirmedAt! < movement.lifecycleAppliedAt!,
    "the three dates must be independently distinguishable: request -> approval -> lifecycle-applied",
  );
});

test("documents attach to the CORRECT engagement (never merged across engagements) — returning-worker invariant", async () => {
  const mod = loadService(baseFixtures());
  const profile = (await mod.getWorker360Profile("w1", null)) as { engagements: { session: { id: string }; electronicDocuments: { documentId: string }[] }[] };
  const sess1 = profile.engagements.find((e) => e.session.id === "sess-1")!;
  const sess2 = profile.engagements.find((e) => e.session.id === "sess-2")!;
  assert.deepEqual(Array.from(sess1.electronicDocuments, (d) => d.documentId), ["doc-1"]);
  assert.deepEqual(Array.from(sess2.electronicDocuments, (d) => d.documentId), ["doc-2"], "the second engagement's own document must never be conflated with the first's");
});

test("IT Code is resolved per-engagement from that engagement's own daily_application", async () => {
  const mod = loadService(baseFixtures());
  const profile = (await mod.getWorker360Profile("w1", null)) as { engagements: { session: { id: string; itCode: string | null } }[] };
  const sess1 = profile.engagements.find((e) => e.session.id === "sess-1")!;
  const sess2 = profile.engagements.find((e) => e.session.id === "sess-2")!;
  assert.equal(sess1.session.itCode, "IT001");
  assert.equal(sess2.session.itCode, "IT002");
});

test("isCurrent flags exactly the session that is APPROVED with no end date", async () => {
  const mod = loadService(baseFixtures());
  const profile = (await mod.getWorker360Profile("w1", null)) as { engagements: { session: { id: string }; isCurrent: boolean }[] };
  const sess1 = profile.engagements.find((e) => e.session.id === "sess-1")!;
  const sess2 = profile.engagements.find((e) => e.session.id === "sess-2")!;
  assert.equal(sess1.isCurrent, false, "sess-1 has an endDate — not current");
  assert.equal(sess2.isCurrent, true, "sess-2 is APPROVED with no endDate — current");
});

test("legacy/unlinked document: attributable ONLY via exact CCCD match, never guessed onto the latest engagement", async () => {
  const fx = baseFixtures();
  fx.legacyDocs = [
    { id: "legacy-1", applicationId: "app-legacy", templateVersion: 1, documentKind: "GENERIC", status: "ISSUED", issuedAt: new Date("2020-01-01"), confirmationDeadlineAt: null, viewedAt: null, supersedesDocumentId: null, cccd: fx.profile.cccd },
    { id: "legacy-2-wrong-cccd", applicationId: "app-legacy-2", templateVersion: 1, documentKind: "GENERIC", status: "ISSUED", issuedAt: new Date("2020-01-01"), confirmationDeadlineAt: null, viewedAt: null, supersedesDocumentId: null, cccd: "999999999999" },
  ];
  const mod = loadService(fx);
  const profile = (await mod.getWorker360Profile("w1", null)) as { legacyUnlinkedDocuments: { documentId: string }[]; engagements: { electronicDocuments: { documentId: string }[] }[] };
  assert.deepEqual(Array.from(profile.legacyUnlinkedDocuments, (d) => d.documentId), ["legacy-1"], "only the CCCD-matching document is attributed to this worker");
  for (const e of profile.engagements) {
    assert.ok(!e.electronicDocuments.some((d) => d.documentId === "legacy-1"), "a legacy document must NEVER be silently attached to any engagement");
  }
});

test("legacy document confirmation evidence (receipt/confirmedAt) is surfaced when it exists, not hardcoded null", async () => {
  const fx = baseFixtures();
  fx.legacyDocs = [{ id: "legacy-confirmed", applicationId: "app-legacy", templateVersion: 1, documentKind: "GENERIC", status: "CONFIRMED", issuedAt: new Date("2020-01-01"), confirmationDeadlineAt: null, viewedAt: new Date("2020-01-02"), supersedesDocumentId: null, cccd: fx.profile.cccd }];
  fx.legacyConfirmations = [{ candidateDocumentId: "legacy-confirmed", confirmedAtServer: new Date("2020-01-03"), receiptId: "receipt-legacy" }];
  const mod = loadService(fx);
  const profile = (await mod.getWorker360Profile("w1", null)) as { legacyUnlinkedDocuments: { documentId: string; receiptId: string | null; confirmedAt: string | null }[] };
  assert.equal(profile.legacyUnlinkedDocuments[0].receiptId, "receipt-legacy");
  assert.ok(profile.legacyUnlinkedDocuments[0].confirmedAt);
});

test("unlinked movement (no employmentSessionId) is surfaced separately, never guessed onto an engagement", async () => {
  const fx = baseFixtures();
  fx.movements.push({ id: "m-legacy", movementType: "resignation", fromDeptId: "d2", toDeptId: null, effectiveDate: "2019-01-01", status: "INACTIVE", reason: null, confirmedBy: null, confirmedAt: null, lifecycleAppliedAt: new Date("2019-01-01"), employmentSessionId: null, createdAt: new Date("2018-12-20") });
  const mod = loadService(fx);
  const profile = (await mod.getWorker360Profile("w1", null)) as { unlinkedMovements: { id: string }[]; engagements: { movements: { id: string }[] }[] };
  assert.deepEqual(Array.from(profile.unlinkedMovements, (m) => m.id), ["m-legacy"]);
  for (const e of profile.engagements) {
    assert.ok(!e.movements.some((m) => m.id === "m-legacy"));
  }
});

test("Phase 2B mục 5: requestAllocations gắn đúng vào engagement (session) sở hữu, kèm requestCode/requestStatus tra cứu từ recruitment_requests", async () => {
  const mod = loadService(baseFixtures());
  const profile = (await mod.getWorker360Profile("w1", null)) as {
    engagements: { session: { id: string }; requestAllocations: { id: string; requestId: string; requestCode: string | null; requestStatus: string | null; status: string; endedAt: string | null }[] }[];
  };
  const sess1 = profile.engagements.find((e) => e.session.id === "sess-1")!;
  const sess2 = profile.engagements.find((e) => e.session.id === "sess-2")!;

  assert.equal(sess1.requestAllocations.length, 1);
  assert.equal(sess1.requestAllocations[0].requestId, "rq-1");
  assert.equal(sess1.requestAllocations[0].requestCode, "RQ-001");
  assert.equal(sess1.requestAllocations[0].requestStatus, "COMPLETED");
  assert.equal(sess1.requestAllocations[0].status, "ENDED");
  assert.ok(sess1.requestAllocations[0].endedAt, "allocation đã kết thúc (transfer) phải có endedAt");

  assert.equal(sess2.requestAllocations.length, 1);
  assert.equal(sess2.requestAllocations[0].requestId, "rq-2");
  assert.equal(sess2.requestAllocations[0].requestCode, "RQ-002");
  assert.equal(sess2.requestAllocations[0].status, "ACTIVE");
  assert.equal(sess2.requestAllocations[0].endedAt, null);
});

test("requestAllocations rỗng khi session không có allocation nào (không lỗi, không undefined)", async () => {
  const fx = baseFixtures();
  fx.requestAllocations = [];
  const mod = loadService(fx);
  const profile = (await mod.getWorker360Profile("w1", null)) as { engagements: { requestAllocations: unknown[] }[] };
  for (const e of profile.engagements) {
    // e.requestAllocations được dựng trong VM sandbox (realm khác test file) —
    // deepEqual cross-realm với mảng rỗng báo "same structure but not reference-equal",
    // JSON round-trip chuẩn hoá về plain array cùng realm (đã dùng ở list-execution.test.ts).
    assert.deepEqual(JSON.parse(JSON.stringify(e.requestAllocations)), []);
  }
});

test("person object never carries CCCD or phone (PII minimization)", async () => {
  const mod = loadService(baseFixtures());
  const profile = (await mod.getWorker360Profile("w1", null)) as { person: Record<string, unknown> };
  assert.ok(!("cccd" in profile.person), "cccd must never appear in the 360 profile DTO");
  assert.ok(!("phone" in profile.person), "phone must never appear in the 360 profile DTO");
});
