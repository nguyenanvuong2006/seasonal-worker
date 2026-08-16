import test from "node:test";
import assert from "node:assert/strict";
import {
  createFakeDb,
  drizzleStub,
  makeTable,
  argOf,
  hasOp,
  type FakeDb,
  type QueryCall,
} from "./test-support/fake-drizzle.ts";
import { loadModule, serverOnlyStub } from "./test-support/load-module.ts";

/* ============================================================
   KIỂM THỬ TẦNG DB — provisionRecruitmentRequest()
   ------------------------------------------------------------
   Chạy trên ĐÚNG src/lib/recruitment-request-provisioning.ts.

   Bao phủ (mục C, E, F, G, H, Q, R của đề bài):
     • Snapshot Current Workforce theo Department, chỉ MỘT LẦN
     • Balance = max(0, Rq - Snapshot + Quit) — không dùng Current realtime
     • Auto-link Planning Period + Planning Target (idempotent)
     • Auto-allocate ACTIVE workforce theo Department (idempotent)
     • Worker đã ACTIVE ở request khác → KHÔNG bị tự chuyển
     • Import lại cùng Request Code → không reset snapshot, không tạo trùng
   ============================================================ */

const schemaStub = {
  recruitmentRequests: makeTable("recruitment_requests"),
  planningPeriods: makeTable("planning_periods"),
  planningTargets: makeTable("planning_targets"),
  planningAllocations: makeTable("planning_allocations"),
  requestAllocations: makeTable("request_allocations"),
  requestAllocationHistory: makeTable("request_allocation_history"),
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
  const recruitmentKpi = loadModule(new URL("./recruitment-kpi.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "drizzle-orm": drizzleStub,
      "@/db": { db },
      "@/db/schema": schemaStub,
      "@/lib/helpers": helpersStub,
      "@/lib/workforce-request-kpi": workforceRequestKpi,
    },
  });
  return loadModule(new URL("./recruitment-request-provisioning.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "drizzle-orm": drizzleStub,
      "@/db": { db },
      "@/db/schema": schemaStub,
      "@/lib/helpers": helpersStub,
      "@/lib/workforce-request-kpi": workforceRequestKpi,
      "@/lib/recruitment-kpi": recruitmentKpi,
    },
  });
}

/** Truy vấn "current workforce" (snapshot / quit) chỉ có innerJoin; truy vấn
 *  ứng viên auto-allocate có THÊM leftJoin tới request_allocations. */
function isAutoAllocateCandidateQuery(call: QueryCall): boolean {
  return call.root === "select" && call.table === "employment_sessions" && hasOp(call, "leftJoin");
}
function isSnapshotQuery(call: QueryCall): boolean {
  return call.root === "select" && call.table === "employment_sessions" && !hasOp(call, "leftJoin");
}

type ProvisionInput = {
  requestId: string;
  departmentId: string | null;
  maleRq: number;
  femaleRq: number;
  location: string | null;
  division: string | null;
  section: string | null;
  groupName: string | null;
  startingDate: string | null;
  expectedDate: string | null;
  requestedDate: string | null;
  endDate: string | null;
  status: string;
  actor: string;
};

function baseInput(overrides: Partial<ProvisionInput> = {}): ProvisionInput {
  return {
    requestId: "req-1",
    departmentId: "dept-A",
    maleRq: 17,
    femaleRq: 36,
    location: "Đà Lạt",
    division: "Production",
    section: "Sec 1",
    groupName: "Grp 1",
    startingDate: null,
    expectedDate: "2026-09-01",
    requestedDate: "2026-08-01",
    endDate: "2026-12-31",
    status: "PENDING",
    actor: "recruiter-1",
    ...overrides,
  };
}

/** 51 worker ACTIVE của Department: 16 Nam + 35 Nữ (case production Chrysanth Rossi H). */
function deptWorkforce(male: number, female: number) {
  const rows: { gender: string }[] = [];
  for (let i = 0; i < male; i++) rows.push({ gender: "Nam" });
  for (let i = 0; i < female; i++) rows.push({ gender: "Nữ" });
  return rows;
}

/* ------------------------------------------------------------
   1. SNAPSHOT + BALANCE — case production-equivalent (16/35/51 → 17/36/53)
   ------------------------------------------------------------ */

test("Request mới: snapshot Current Workforce theo Department (16M/35F=51), Balance = 1/1/2", async () => {
  let insertedCount = 0;
  const db = createFakeDb({
    respond(call) {
      if (call.root === "select" && call.table === "recruitment_requests") return []; // chưa có snapshot/planning
      if (isSnapshotQuery(call)) return deptWorkforce(16, 35);
      if (call.root === "select" && call.table === "workforce_movements") return []; // Quit = 0
      if (isAutoAllocateCandidateQuery(call)) return []; // không auto-allocate trong test này
      if (call.root === "insert" && call.table === "planning_periods") return [{ id: "period-new" }];
      if (call.root === "insert") {
        insertedCount += 1;
        return [{ id: `row-${insertedCount}` }];
      }
      return undefined;
    },
  });

  const mod = load(db);
  await (mod.provisionRecruitmentRequest as (ex: unknown, i: ProvisionInput) => Promise<void>)(db, baseInput());

  // Snapshot ghi đúng 1 lần với giá trị Department (16/35/51).
  const snapshotUpdate = db
    .writesTo("recruitment_requests")
    .find((c) => c.root === "update" && "snapshotAt" in (argOf(c, "set") as Record<string, unknown>));
  assert.ok(snapshotUpdate, "phải có update ghi snapshot");
  const snapshotSet = argOf(snapshotUpdate as QueryCall, "set") as Record<string, unknown>;
  assert.equal(snapshotSet.maleCurrentAtStart, 16);
  assert.equal(snapshotSet.femaleCurrentAtStart, 35);
  assert.equal(snapshotSet.totalCurrentAtStart, 51);

  // Balance = max(0, Rq - Snapshot + Quit) = max(0, 17-16+0)=1 / max(0,36-35+0)=1 / 2.
  const balanceUpdate = db
    .writesTo("recruitment_requests")
    .find((c) => c.root === "update" && "maleBalance" in (argOf(c, "set") as Record<string, unknown>));
  assert.ok(balanceUpdate, "phải có update ghi Balance");
  const balanceSet = argOf(balanceUpdate as QueryCall, "set") as Record<string, unknown>;
  assert.equal(balanceSet.maleBalance, 1);
  assert.equal(balanceSet.femaleBalance, 1);
  assert.equal(balanceSet.totalBalance, 2);
});

test("Import lại cùng Request Code (đã có snapshot): KHÔNG reset snapshot, chỉ recompute Balance", async () => {
  const db = createFakeDb({
    respond(call) {
      if (call.root === "select" && call.table === "recruitment_requests") {
        return [
          {
            snapshotAt: new Date("2026-08-01T00:00:00Z"),
            maleCurrentAtStart: 16,
            femaleCurrentAtStart: 35,
            totalCurrentAtStart: 51,
            planningPeriodId: "period-existing",
          },
        ];
      }
      if (isSnapshotQuery(call)) return deptWorkforce(99, 99); // KHÔNG được dùng — snapshot đã có
      if (call.root === "select" && call.table === "workforce_movements") return []; // Quit = 0
      if (isAutoAllocateCandidateQuery(call)) return [];
      if (call.root === "insert") return [{ id: "row-x" }];
      return undefined;
    },
  });

  const mod = load(db);
  await (mod.provisionRecruitmentRequest as (ex: unknown, i: ProvisionInput) => Promise<void>)(db, baseInput());

  // Guard snapshot_at IS NULL trong WHERE → không có update nào set snapshotAt.
  const snapshotUpdate = db
    .writesTo("recruitment_requests")
    .find((c) => c.root === "update" && "snapshotAt" in (argOf(c, "set") as Record<string, unknown>));
  assert.equal(snapshotUpdate, undefined, "KHÔNG được ghi đè snapshot đã có");

  // Balance vẫn dùng snapshot CŨ (16/35), không phải deptWorkforce(99,99).
  const balanceUpdate = db
    .writesTo("recruitment_requests")
    .find((c) => c.root === "update" && "maleBalance" in (argOf(c, "set") as Record<string, unknown>));
  const balanceSet = argOf(balanceUpdate as QueryCall, "set") as Record<string, unknown>;
  assert.equal(balanceSet.maleBalance, 1);
  assert.equal(balanceSet.femaleBalance, 1);

  // Planning Period đã có (period-existing) → KHÔNG tạo period mới.
  assert.equal(db.writesTo("planning_periods").filter((c) => c.root === "insert").length, 0);
});

test("Quit during request được cộng vào Balance (KHÔNG cộng vào Current Now — chống double-count)", async () => {
  const db = createFakeDb({
    respond(call) {
      if (call.root === "select" && call.table === "recruitment_requests") {
        return [
          {
            snapshotAt: new Date("2026-08-01T00:00:00Z"),
            maleCurrentAtStart: 51,
            femaleCurrentAtStart: 0,
            totalCurrentAtStart: 51,
            planningPeriodId: "period-existing",
          },
        ];
      }
      if (call.root === "select" && call.table === "workforce_movements") return deptWorkforce(2, 0); // 2 nam nghỉ
      if (isAutoAllocateCandidateQuery(call)) return [];
      if (call.root === "insert") return [{ id: "row-x" }];
      return undefined;
    },
  });

  const mod = load(db);
  await (mod.provisionRecruitmentRequest as (ex: unknown, i: ProvisionInput) => Promise<void>)(
    db,
    baseInput({ maleRq: 53, femaleRq: 0 }),
  );

  const balanceUpdate = db
    .writesTo("recruitment_requests")
    .find((c) => c.root === "update" && "maleBalance" in (argOf(c, "set") as Record<string, unknown>));
  const balanceSet = argOf(balanceUpdate as QueryCall, "set") as Record<string, unknown>;
  // 53 - 51 + 2 = 4 (đúng công thức snapshot + quit).
  assert.equal(balanceSet.maleBalance, 4);
});

/* ------------------------------------------------------------
   2. AUTO-LINK PLANNING PERIOD + TARGET
   ------------------------------------------------------------ */

test("Auto-link Planning Period khi request chưa có: tạo ACTIVE cho PENDING/PROCESSING, ORIGINAL, version 1", async () => {
  const db = createFakeDb({
    respond(call) {
      if (call.root === "select" && call.table === "recruitment_requests") return [];
      if (isSnapshotQuery(call)) return [];
      if (call.root === "select" && call.table === "workforce_movements") return [];
      if (isAutoAllocateCandidateQuery(call)) return [];
      if (call.root === "insert" && call.table === "planning_periods") return [{ id: "period-new" }];
      if (call.root === "insert") return [{ id: "row-x" }];
      return undefined;
    },
  });

  const mod = load(db);
  await (mod.provisionRecruitmentRequest as (ex: unknown, i: ProvisionInput) => Promise<void>)(
    db,
    baseInput({ status: "PENDING" }),
  );

  const periodInsert = db.writesTo("planning_periods").find((c) => c.root === "insert");
  assert.ok(periodInsert, "phải tạo Planning Period");
  const values = argOf(periodInsert as QueryCall, "values") as Record<string, unknown>;
  assert.equal(values.departmentId, "dept-A");
  assert.equal(values.status, "ACTIVE");
  assert.equal(values.version, 1);
  assert.equal(values.requestType, "ORIGINAL");
  assert.equal(values.supplementIndex, 0);
  assert.equal(values.requestId, "req-1");

  // Request được cập nhật planning_period_id trỏ về period mới.
  const linkUpdate = db
    .writesTo("recruitment_requests")
    .find((c) => c.root === "update" && "planningPeriodId" in (argOf(c, "set") as Record<string, unknown>));
  assert.ok(linkUpdate);
  assert.equal((argOf(linkUpdate as QueryCall, "set") as Record<string, unknown>).planningPeriodId, "period-new");

  // Planning Target = demand từ male_rq/female_rq của request.
  const targetInsert = db.writesTo("planning_targets").find((c) => c.root === "insert");
  assert.ok(targetInsert);
  const targetValues = argOf(targetInsert as QueryCall, "values") as Record<string, unknown>;
  assert.equal(targetValues.demandMale, 17);
  assert.equal(targetValues.demandFemale, 36);
  assert.equal(targetValues.targetCount, 53);
});

test("Import lại cùng request: Planning Target upsert (onConflictDoUpdate), KHÔNG insert Planning Period trùng", async () => {
  const db = createFakeDb({
    respond(call) {
      if (call.root === "select" && call.table === "recruitment_requests") {
        return [
          {
            snapshotAt: new Date(),
            maleCurrentAtStart: 0,
            femaleCurrentAtStart: 0,
            totalCurrentAtStart: 0,
            planningPeriodId: "period-existing",
          },
        ];
      }
      if (call.root === "select" && call.table === "workforce_movements") return [];
      if (isAutoAllocateCandidateQuery(call)) return [];
      if (call.root === "insert") return [{ id: "row-x" }];
      return undefined;
    },
  });

  const mod = load(db);
  await (mod.provisionRecruitmentRequest as (ex: unknown, i: ProvisionInput) => Promise<void>)(db, baseInput());
  await (mod.provisionRecruitmentRequest as (ex: unknown, i: ProvisionInput) => Promise<void>)(db, baseInput());

  assert.equal(db.writesTo("planning_periods").filter((c) => c.root === "insert").length, 0);
  const targetInserts = db.writesTo("planning_targets").filter((c) => c.root === "insert");
  assert.equal(targetInserts.length, 2, "mỗi lần gọi đều upsert (onConflictDoUpdate, không tạo trùng nhờ unique index)");
  for (const call of targetInserts) {
    assert.ok(hasOp(call, "onConflictDoUpdate"), "phải dùng onConflictDoUpdate để không tạo target trùng");
  }
});

/* ------------------------------------------------------------
   3. AUTO-ALLOCATE — ACTIVE workforce theo Department (mục G + H)
   ------------------------------------------------------------ */

test("Auto-allocate: worker ACTIVE theo Department được phân bổ vào request_allocations + planning_allocations", async () => {
  const db = createFakeDb({
    respond(call) {
      if (call.root === "select" && call.table === "recruitment_requests") {
        return [
          {
            snapshotAt: new Date(),
            maleCurrentAtStart: 1,
            femaleCurrentAtStart: 0,
            totalCurrentAtStart: 1,
            planningPeriodId: "period-existing",
          },
        ];
      }
      if (call.root === "select" && call.table === "workforce_movements") return [];
      if (isAutoAllocateCandidateQuery(call)) {
        return [{ sessionId: "sess-1", workerId: "worker-1" }];
      }
      if (call.root === "insert" && call.table === "request_allocations") return [{ id: "alloc-1" }];
      if (call.root === "insert") return [{ id: "row-x" }];
      return undefined;
    },
  });

  const mod = load(db);
  await (mod.provisionRecruitmentRequest as (ex: unknown, i: ProvisionInput) => Promise<void>)(db, baseInput());

  const allocInsert = db.writesTo("request_allocations").find((c) => c.root === "insert");
  assert.ok(allocInsert, "phải tạo request_allocations cho worker ACTIVE");
  const allocValues = argOf(allocInsert as QueryCall, "values") as Record<string, unknown>;
  assert.equal(allocValues.workerId, "worker-1");
  assert.equal(allocValues.employmentSessionId, "sess-1");
  assert.equal(allocValues.requestId, "req-1");
  assert.equal(allocValues.status, "ACTIVE");
  assert.ok(hasOp(allocInsert as QueryCall, "onConflictDoNothing"), "phải chống double-click/race qua onConflictDoNothing");

  const historyInsert = db.writesTo("request_allocation_history").find((c) => c.root === "insert");
  assert.ok(historyInsert);
  assert.equal((argOf(historyInsert as QueryCall, "values") as Record<string, unknown>).action, "ALLOCATE");

  const planningAllocInsert = db.writesTo("planning_allocations").find((c) => c.root === "insert");
  assert.ok(planningAllocInsert, "phải mirror sang planning_allocations");
  const planningValues = argOf(planningAllocInsert as QueryCall, "values") as Record<string, unknown>;
  assert.equal(planningValues.employmentSessionId, "sess-1");
  assert.equal(planningValues.planningPeriodId, "period-existing");
  assert.equal(planningValues.recruitmentRequestId, "req-1");
});

test("Auto-allocate: query ứng viên LOẠI worker đã có ACTIVE allocation ở BẤT KỲ request nào (mục H)", async () => {
  // Không cần dữ liệu — chỉ cần khẳng định truy vấn candidate join tới
  // request_allocations qua leftJoin + isNull(id) (đã lọc TRƯỚC KHI ứng dụng
  // thấy dữ liệu — worker đã ACTIVE ở request khác không lọt vào danh sách
  // ứng viên ngay từ đầu, nên không có allocation nào bị tạo/ END cho worker đó).
  let candidateQuerySeen: QueryCall | null = null;
  const db = createFakeDb({
    respond(call) {
      if (call.root === "select" && call.table === "recruitment_requests") {
        return [
          {
            snapshotAt: new Date(),
            maleCurrentAtStart: 0,
            femaleCurrentAtStart: 0,
            totalCurrentAtStart: 0,
            planningPeriodId: "period-existing",
          },
        ];
      }
      if (call.root === "select" && call.table === "workforce_movements") return [];
      if (isAutoAllocateCandidateQuery(call)) {
        candidateQuerySeen = call;
        // Danh sách ứng viên rỗng — worker-already-active-elsewhere đã bị lọc bởi
        // chính câu truy vấn (isNull(requestAllocations.id) trong WHERE).
        return [];
      }
      if (call.root === "insert") return [{ id: "row-x" }];
      return undefined;
    },
  });

  const mod = load(db);
  await (mod.provisionRecruitmentRequest as (ex: unknown, i: ProvisionInput) => Promise<void>)(db, baseInput());

  assert.ok(candidateQuerySeen, "phải chạy truy vấn ứng viên auto-allocate");
  assert.ok(hasOp(candidateQuerySeen!, "leftJoin"), "phải leftJoin tới request_allocations để loại worker đã ACTIVE nơi khác");
  // Không có allocation nào được tạo (danh sách ứng viên rỗng) — request khác không bị đụng tới.
  assert.equal(db.writesTo("request_allocations").filter((c) => c.root === "insert").length, 0);
  assert.equal(
    db.writesTo("request_allocations").filter((c) => c.root === "update").length,
    0,
    "KHÔNG được tự END allocation của request khác",
  );
});

/* ------------------------------------------------------------
   4. KHÔNG MATCH ĐƯỢC DEPARTMENT
   ------------------------------------------------------------ */

test("Không match được department_id: Balance = Rq, không snapshot/auto-link/auto-allocate", async () => {
  const db = createFakeDb({ respond: () => undefined });
  const mod = load(db);
  await (mod.provisionRecruitmentRequest as (ex: unknown, i: ProvisionInput) => Promise<void>)(
    db,
    baseInput({ departmentId: null, maleRq: 5, femaleRq: 3 }),
  );

  const balanceUpdate = db
    .writesTo("recruitment_requests")
    .find((c) => c.root === "update" && "maleBalance" in (argOf(c, "set") as Record<string, unknown>));
  const balanceSet = argOf(balanceUpdate as QueryCall, "set") as Record<string, unknown>;
  assert.equal(balanceSet.maleBalance, 5);
  assert.equal(balanceSet.femaleBalance, 3);
  assert.equal(db.writesTo("planning_periods").length, 0);
  assert.equal(db.writesTo("request_allocations").length, 0);
});
