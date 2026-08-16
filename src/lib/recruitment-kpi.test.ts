import test from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, drizzleStub, makeTable, argOf, type FakeDb, type QueryCall } from "./test-support/fake-drizzle.ts";
import { loadModule, serverOnlyStub } from "./test-support/load-module.ts";

/* ============================================================
   KIỂM THỬ TẦNG DB — computeRecruitmentKpis(requestId) (mục J)
   ------------------------------------------------------------
   Service DUY NHẤT tính Recruitment Balance vs Realtime Gap, đối
   chiếu (mục K) — canonical, dùng ĐÚNG src/lib/recruitment-kpi.ts.
   ============================================================ */

const schemaStub = {
  recruitmentRequests: makeTable("recruitment_requests"),
  employmentSessions: makeTable("employment_sessions"),
  workerProfiles: makeTable("worker_profiles"),
  workforceMovements: makeTable("workforce_movements"),
};

const helpersStub = {
  todayStr: () => "2026-08-16",
  isMale: (g: string | null) => String(g ?? "").toUpperCase().startsWith("M") || g === "Nam",
  isFemale: (g: string | null) => String(g ?? "").toUpperCase().startsWith("F") || g === "Nữ",
};

function load(db: FakeDb) {
  const workforceRequestKpi = loadModule(new URL("./workforce-request-kpi.ts", import.meta.url), { stubs: {} });
  return loadModule(new URL("./recruitment-kpi.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "drizzle-orm": drizzleStub,
      "@/db": { db },
      "@/db/schema": schemaStub,
      "@/lib/helpers": helpersStub,
      "@/lib/workforce-request-kpi": workforceRequestKpi,
    },
  });
}

function deptWorkforce(male: number, female: number) {
  const rows: { gender: string }[] = [];
  for (let i = 0; i < male; i++) rows.push({ gender: "Nam" });
  for (let i = 0; i < female; i++) rows.push({ gender: "Nữ" });
  return rows;
}

const requestRow = (overrides: Record<string, unknown> = {}) => ({
  id: "req-1",
  deletedAt: null,
  departmentId: "dept-A",
  maleRq: 17,
  femaleRq: 36,
  maleCurrentAtStart: 16,
  femaleCurrentAtStart: 35,
  snapshotAt: new Date("2026-08-01T00:00:00Z"),
  startingDate: null,
  expectedDate: "2026-09-01",
  requestedDate: "2026-08-01",
  endDate: "2026-12-31",
  createdAt: new Date("2026-08-01T00:00:00Z"),
  ...overrides,
});

test("Production case: Snapshot 16/35, Request 17/36, Quit=0, Current Now=51 → Balance=2, Gap=2, reconciled OK", async () => {
  const db = createFakeDb({
    respond(call) {
      if (call.root === "select" && call.table === "recruitment_requests") return [requestRow()];
      if (call.root === "select" && call.table === "workforce_movements") return []; // Quit = 0
      if (call.root === "select" && call.table === "employment_sessions") return deptWorkforce(16, 35); // Current Now = 51
      return undefined;
    },
  });

  const mod = load(db);
  const kpi = (await (mod.computeRecruitmentKpis as (id: string, ex?: unknown) => Promise<Record<string, unknown>>)(
    "req-1",
  )) as {
    maleBalance: number;
    femaleBalance: number;
    totalBalance: number;
    maleRealtimeGap: number;
    totalRealtimeGap: number;
    reconciliationStatus: string;
  };

  assert.equal(kpi.maleBalance, 1);
  assert.equal(kpi.femaleBalance, 1);
  assert.equal(kpi.totalBalance, 2);
  assert.equal(kpi.totalRealtimeGap, 2);
  assert.equal(kpi.reconciliationStatus, "OK");
});

test("Quit case: Snapshot 51, Request 53, 2 nghỉ trong cửa sổ request, Current Now=49 → Balance=4, Gap=4", async () => {
  const db = createFakeDb({
    respond(call) {
      if (call.root === "select" && call.table === "recruitment_requests") {
        return [requestRow({ maleRq: 53, femaleRq: 0, maleCurrentAtStart: 51, femaleCurrentAtStart: 0 })];
      }
      if (call.root === "select" && call.table === "workforce_movements") return deptWorkforce(2, 0);
      if (call.root === "select" && call.table === "employment_sessions") return deptWorkforce(49, 0);
      return undefined;
    },
  });

  const mod = load(db);
  const kpi = (await (mod.computeRecruitmentKpis as (id: string, ex?: unknown) => Promise<Record<string, unknown>>)(
    "req-1",
  )) as { maleBalance: number; maleRealtimeGap: number; reconciliationStatus: string };

  assert.equal(kpi.maleBalance, 4);
  assert.equal(kpi.maleRealtimeGap, 4);
  assert.equal(kpi.reconciliationStatus, "OK");
});

test("Mismatch: Current Now giảm nhưng chưa có RESIGNATION xác nhận (Quit=0) → KPI_RECONCILIATION_MISMATCH, KHÔNG âm thầm ghi đè", async () => {
  const db = createFakeDb({
    respond(call) {
      if (call.root === "select" && call.table === "recruitment_requests") {
        return [requestRow({ maleRq: 10, femaleRq: 0, maleCurrentAtStart: 10, femaleCurrentAtStart: 0 })];
      }
      if (call.root === "select" && call.table === "workforce_movements") return []; // Quit chưa xác nhận = 0
      if (call.root === "select" && call.table === "employment_sessions") return deptWorkforce(8, 0); // nhưng Current Now đã giảm
      return undefined;
    },
  });

  const mod = load(db);
  const kpi = (await (mod.computeRecruitmentKpis as (id: string, ex?: unknown) => Promise<Record<string, unknown>>)(
    "req-1",
  )) as { maleBalance: number; maleRealtimeGap: number; reconciliationStatus: string };

  assert.equal(kpi.maleBalance, 0); // 10-10+0
  assert.equal(kpi.maleRealtimeGap, 2); // 10-8
  assert.equal(kpi.reconciliationStatus, "KPI_RECONCILIATION_MISMATCH");
  // Service chỉ TRẢ VỀ trạng thái mismatch — không có bất kỳ lệnh ghi (UPDATE/INSERT) nào ở đây.
  assert.equal(db.writes.length, 0, "computeRecruitmentKpis là READ-ONLY, không âm thầm ghi đè dữ liệu");
});

test("Request không tồn tại / đã xoá → trả về null", async () => {
  const db = createFakeDb({
    respond(call) {
      if (call.root === "select" && call.table === "recruitment_requests") return [];
      return undefined;
    },
  });
  const mod = load(db);
  const kpi = await (mod.computeRecruitmentKpis as (id: string, ex?: unknown) => Promise<unknown>)("missing");
  assert.equal(kpi, null);
});

test("recomputeStoredRecruitmentBalance: ghi lại male_balance/female_balance/total_balance từ KPI mới nhất", async () => {
  const db = createFakeDb({
    respond(call) {
      if (call.root === "select" && call.table === "recruitment_requests") {
        return [requestRow({ maleRq: 53, femaleRq: 0, maleCurrentAtStart: 51, femaleCurrentAtStart: 0 })];
      }
      if (call.root === "select" && call.table === "workforce_movements") return deptWorkforce(2, 0);
      if (call.root === "select" && call.table === "employment_sessions") return deptWorkforce(49, 0);
      return undefined;
    },
  });

  const mod = load(db);
  await (mod.recomputeStoredRecruitmentBalance as (ex: unknown, id: string) => Promise<void>)(db, "req-1");

  const update = db.writesTo("recruitment_requests").find((c) => c.root === "update");
  assert.ok(update, "phải ghi lại Balance");
  const set = argOf(update as QueryCall, "set") as Record<string, unknown>;
  assert.equal(set.maleBalance, 4);
  assert.equal(set.femaleBalance, 0);
  assert.equal(set.totalBalance, 4);
});
