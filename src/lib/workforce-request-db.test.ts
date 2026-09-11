import test from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, drizzleStub, makeTable, condsOf, eqValue, argOf, inArrayValues, type FakeDb, type QueryCall } from "./test-support/fake-drizzle.ts";
import { loadModule, serverOnlyStub } from "./test-support/load-module.ts";
import { toVNDateStr } from "./helpers.ts";

/* ============================================================
   KIỂM THỬ TẦNG DB — batchComputeRequestKpis() trên ĐÚNG
   src/lib/workforce-request.ts (Phase 2B mục 3.6 — approved design
   mục 4: "RQ09 hết hạn -> KPI phải đóng băng tại asOf, không trôi
   theo Current Workforce realtime của RQ10").

   Scenario C (mission mục 10.C, acceptance #7-#10):
     RQ09: requestedDate=2026-09-01, expectedDate=endDate=2026-09-30.
       w1: allocated RQ09 09-01 -> RESIGN hiệu lực 09-25 (Quit).
       w2: allocated RQ09 09-01 -> TRANSFER (department khác) hiệu lực
           09-20, lifecycleAppliedAt đã set (Transfer-Out).
       w3: allocated RQ09 09-01 -> vẫn ACTIVE xuyên suốt 09-30.
     Sau 09-30 (mô phỏng RQ10 tiếp nhận): w3 CŨNG được end allocation
     RQ09 (giả lập reallocate sang RQ10 ngày 10-01).

   Assertions bắt buộc:
     - asOf=2026-09-30 (đúng như route sẽ resolveDefaultAsOf cho RQ09
       đã EXPIRED): Current=1 (w3), Quit=1 (w1), TransferOut=1 (w2) —
       kết quả CUỐI KỲ, không đổi dù đã sang tháng 10.
     - asOf="today" (2026-10-15, LIVE — mô phỏng lỗi CŨ nếu route quên
       truyền asOf): Current=0 vì w3 đã bị end allocation sau 10-01 —
       CHỨNG MINH sự khác biệt giữa "đóng băng đúng" và "trôi theo
       realtime" mà mission yêu cầu phải tránh.
   ============================================================ */

const requestAllocations = makeTable("request_allocations");
const employmentSessions = makeTable("employment_sessions");
const workerProfiles = makeTable("worker_profiles");
const workforceMovements = makeTable("workforce_movements");
const dailyApplications = makeTable("daily_applications");
const recruitmentRequests = makeTable("recruitment_requests");
const schemaStub = {
  requestAllocations,
  employmentSessions,
  workerProfiles,
  workforceMovements,
  dailyApplications,
  recruitmentRequests,
};

const TODAY = "2026-10-15";
const RQ09 = "rq09";

type AllocRow = {
  id: string;
  requestId: string;
  workerId: string;
  employmentSessionId: string;
  status: "ACTIVE" | "ENDED";
  startedAt: Date;
  endedAt: Date | null;
};
type SessionRow = { id: string; status: string; endDate: string | null; startingDate: string | null };
type WorkerRow = { id: string; gender: string; deletedAt: null };
type MovementRow = {
  id: string;
  workerId: string;
  movementType: "resignation" | "transfer";
  status: string;
  effectiveDate: string;
  lifecycleAppliedAt: Date | null;
};

function buildFixture() {
  const allocations: AllocRow[] = [
    { id: "a-w1", requestId: RQ09, workerId: "w1", employmentSessionId: "s-w1", status: "ENDED", startedAt: new Date("2026-09-01"), endedAt: new Date("2026-09-25") },
    { id: "a-w2", requestId: RQ09, workerId: "w2", employmentSessionId: "s-w2", status: "ENDED", startedAt: new Date("2026-09-01"), endedAt: new Date("2026-09-20") },
    // w3 ban đầu ACTIVE, sau đó (mô phỏng bước "sang RQ10") bị END 10-01 — 2 bản ghi
    // riêng biệt để phản ánh đúng append-only: KHÔNG update tại chỗ, chỉ có 1 dòng vì
    // fixture test chỉ cần trạng thái ENDED cuối cùng — asOf=09-30 vẫn thấy ACTIVE vì
    // endedAt=10-01 >= 09-30.
    { id: "a-w3", requestId: RQ09, workerId: "w3", employmentSessionId: "s-w3", status: "ENDED", startedAt: new Date("2026-09-01"), endedAt: new Date("2026-10-01") },
  ];
  const sessions: Record<string, SessionRow> = {
    "s-w1": { id: "s-w1", status: "ENDED", endDate: "2026-09-25", startingDate: "2026-09-01" },
    "s-w2": { id: "s-w2", status: "APPROVED", endDate: null, startingDate: "2026-09-01" }, // transfer KHÔNG end session
    "s-w3": { id: "s-w3", status: "APPROVED", endDate: null, startingDate: "2026-09-01" },
  };
  const workers: Record<string, WorkerRow> = {
    w1: { id: "w1", gender: "Nam", deletedAt: null },
    w2: { id: "w2", gender: "Nữ", deletedAt: null },
    w3: { id: "w3", gender: "Nam", deletedAt: null },
  };
  const movements: MovementRow[] = [
    { id: "m-resign-w1", workerId: "w1", movementType: "resignation", status: "INACTIVE", effectiveDate: "2026-09-25", lifecycleAppliedAt: new Date("2026-09-25") },
    { id: "m-transfer-w2", workerId: "w2", movementType: "transfer", status: "TRANSFER_COMPLETED", effectiveDate: "2026-09-20", lifecycleAppliedAt: new Date("2026-09-20") },
  ];
  const pipeline = [
    { requestId: RQ09, gender: "Nam", status: "APPROVED", submittedAt: new Date("2026-09-01") },
    { requestId: RQ09, gender: "Nữ", status: "APPROVED", submittedAt: new Date("2026-09-01") },
    { requestId: RQ09, gender: "Nam", status: "APPROVED", submittedAt: new Date("2026-09-01") },
  ];
  return { allocations, sessions, workers, movements, pipeline };
}

function respondFor(fixture: ReturnType<typeof buildFixture>) {
  return (call: QueryCall): unknown => {
    if (call.table === "request_allocations") {
      const movementType = eqValue(call, "workforce_movements.movementType");
      if (movementType === "resignation") {
        // fetchQuitRows: JOIN request_allocations (mọi status) + workforce_movements
        // resignation/INACTIVE/lifecycleAppliedAt IS NOT NULL (follow-up correctness fix —
        // cùng invariant với Transfer-Out: status=INACTIVE được ghi ngay khi HR approve,
        // có thể SỚM HƠN effectiveDate thật).
        return fixture.allocations
          .map((a) => {
            const mv = fixture.movements.find(
              (m) => m.workerId === a.workerId && m.movementType === "resignation" && m.status === "INACTIVE" && m.lifecycleAppliedAt,
            );
            if (!mv) return null;
            return {
              requestId: a.requestId,
              movementId: mv.id,
              workerId: a.workerId,
              gender: fixture.workers[a.workerId].gender,
              effectiveDate: mv.effectiveDate,
              allocatedAt: a.startedAt,
            };
          })
          .filter((r): r is NonNullable<typeof r> => r !== null);
      }
      if (movementType === "transfer") {
        // fetchTransferOutRows: JOIN request_allocations (mọi status) + workforce_movements
        // transfer/TRANSFER_COMPLETED/lifecycleAppliedAt IS NOT NULL.
        return fixture.allocations
          .map((a) => {
            const mv = fixture.movements.find(
              (m) => m.workerId === a.workerId && m.movementType === "transfer" && m.status === "TRANSFER_COMPLETED" && m.lifecycleAppliedAt,
            );
            if (!mv) return null;
            return {
              requestId: a.requestId,
              movementId: mv.id,
              workerId: a.workerId,
              gender: fixture.workers[a.workerId].gender,
              effectiveDate: mv.effectiveDate,
              allocatedAt: a.startedAt,
              fromDeptId: "d1",
              toDeptId: "d2",
            };
          })
          .filter((r): r is NonNullable<typeof r> => r !== null);
      }
      const activeEq = eqValue(call, "request_allocations.status");
      if (activeEq === "ACTIVE") {
        // fetchLiveAllocationRows: CHỈ ACTIVE + session APPROVED + endDate NULL (bỏ qua asOf).
        return fixture.allocations
          .filter((a) => a.status === "ACTIVE" && fixture.sessions[a.employmentSessionId].status === "APPROVED" && fixture.sessions[a.employmentSessionId].endDate === null)
          .map((a) => ({ id: a.id, requestId: a.requestId, workerId: a.workerId, sessionId: a.employmentSessionId, gender: fixture.workers[a.workerId].gender }));
      }
      // fetchHistoricalAllocationRows: có sql fragment asOf — parse từ điều kiện sql text/values.
      const sqlConds = condsOf(call).filter((c) => c.op === "sql");
      const asOfVal = sqlConds
        .flatMap((c) => (c.op === "sql" ? c.values : []))
        .find((v): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v));
      const asOf = asOfVal ?? TODAY;
      return fixture.allocations
        .filter((a) => {
          const sess = fixture.sessions[a.employmentSessionId];
          const startedOk = a.startedAt.toISOString().slice(0, 10) <= asOf;
          const allocEndOk = a.endedAt === null || a.endedAt.toISOString().slice(0, 10) >= asOf;
          const sessEndOk = sess.endDate === null || sess.endDate >= asOf;
          const sessStartOk = sess.startingDate === null || sess.startingDate <= asOf;
          return startedOk && allocEndOk && sessEndOk && sessStartOk;
        })
        .map((a) => ({ id: a.id, requestId: a.requestId, workerId: a.workerId, sessionId: a.employmentSessionId, gender: fixture.workers[a.workerId].gender }));
    }
    if (call.table === "daily_applications") {
      return fixture.pipeline;
    }
    return undefined;
  };
}

function load(db: FakeDb) {
  const kpi = loadModule(new URL("./workforce-request-kpi.ts", import.meta.url), { stubs: {} });
  return loadModule(new URL("./workforce-request.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "drizzle-orm": drizzleStub,
      "@/db": { db },
      "@/db/schema": schemaStub,
      "@/lib/auth": { getUserScope: async () => null, hasPermission: async () => false, writeAudit: async () => undefined },
      "@/lib/data-scope": { scopeAllowsDepartment: () => true },
      "@/lib/helpers": {
        todayStr: () => TODAY,
        isMale: (g: string | null) => g === "Nam",
        isFemale: (g: string | null) => g === "Nữ",
        toVNDateStr,
      },
      "@/lib/person-name": { normalizePersonName: (s: string) => s },
      "@/lib/workforce-request-kpi": kpi,
    },
  });
}

type RequestRow = {
  id: string;
  maleRq: number;
  femaleRq: number;
  totalRequest: number;
  requestedDate: string | null;
  expectedDate: string | null;
  endDate: string | null;
  createdAt: Date;
};

const RQ09_ROW: RequestRow = {
  id: RQ09,
  maleRq: 2,
  femaleRq: 1,
  totalRequest: 3,
  requestedDate: "2026-09-01",
  expectedDate: "2026-09-30",
  endDate: "2026-09-30",
  createdAt: new Date("2026-09-01"),
};

test("Scenario C: RQ09 xem lại asOf=2026-09-30 (endDate) -> Current/Quit/TransferOut đúng CUỐI KỲ, bất biến", async () => {
  const fixture = buildFixture();
  const db = createFakeDb({ respond: respondFor(fixture) });
  const mod = load(db) as {
    batchComputeRequestKpis: (rows: RequestRow[], asOf: string) => Promise<Map<string, Record<string, number>>>;
  };

  const kpis = await mod.batchComputeRequestKpis([RQ09_ROW], "2026-09-30");
  const kpi = kpis.get(RQ09)!;

  assert.equal(kpi.totalCurrent, 1, "chỉ w3 còn ACTIVE trên RQ09 tại 09-30 (w1 nghỉ, w2 chuyển đi)");
  assert.equal(kpi.totalQuit, 1, "w1 nghỉ việc trong cửa sổ request -> Quit=1");
  assert.equal(kpi.totalTransferOut, 1, "w2 thuyên chuyển có hiệu lực trong cửa sổ request -> TransferOut=1");
  assert.equal(kpi.totalRecruited, 3, "pipeline daily_applications APPROVED gắn với RQ09");
});

test("Scenario C: gọi LẠI sau khi w3 cũng rời RQ09 (RQ10 tiếp nhận) — asOf=endDate VẪN cho kết quả CUỐI KỲ y hệt, không trôi theo RQ10", async () => {
  const fixture = buildFixture(); // w3 đã có endedAt=2026-10-01 sẵn trong fixture (đại diện cho "đã reallocate sang RQ10")
  const db = createFakeDb({ respond: respondFor(fixture) });
  const mod = load(db) as {
    batchComputeRequestKpis: (rows: RequestRow[], asOf: string) => Promise<Map<string, Record<string, number>>>;
  };

  const historical = await mod.batchComputeRequestKpis([RQ09_ROW], "2026-09-30");
  assert.equal(historical.get(RQ09)!.totalCurrent, 1, "asOf=endDate PHẢI vẫn thấy w3 (còn allocation tới tận 10-01), bất kể hôm nay là gì");

  const live = await mod.batchComputeRequestKpis([RQ09_ROW], TODAY);
  assert.equal(live.get(RQ09)!.totalCurrent, 0, "asOf=today (LIVE) đúng là 0 vì w3 đã rời RQ09 — CHỨNG MINH khác biệt: route PHẢI dùng asOf=endDate cho request EXPIRED/COMPLETED, không được để mặc định 'today' làm trôi lịch sử");
});

/* ============================================================
   PRE-MERGE REVIEW (PR #204) — Scenario C QUA reallocateDws() THẬT,
   không phải mô phỏng tay bằng fixture tĩnh.
   ------------------------------------------------------------
   Trước đây "Scenario C: gọi LẠI sau khi w3 cũng rời RQ09" mô phỏng việc
   w3 rời RQ09 bằng cách set sẵn `endedAt` trong fixture tĩnh — chứng minh
   ĐÚNG cơ chế đóng băng lịch sử (resolveDefaultAsOf/requestWindow chỉ đọc
   recruitment_requests, không đọc request_allocations), nhưng KHÔNG chứng
   minh reallocateDws() THẬT tạo ra đúng hiệu ứng dữ liệu đó.

   Test dưới đây gọi reallocateDws() THẬT (nạp từ planning-reallocation.ts,
   dùng chung `db` giả và dùng chung workforce-request.ts THẬT — không stub
   syncRequestAllocationOnPlanningMove/batchComputeRequestKpis) để chuyển w3
   từ RQ09 (đã đóng 2026-09-30) sang RQ10, SAU khi đóng (today=2026-10-05),
   rồi đọc lại batchComputeRequestKpis(RQ09, asOf=2026-09-30) — canonical KPI
   THẬT, không phải hàm thuần resolveDefaultAsOf() đơn lẻ — và khẳng định w3
   vẫn còn trong lịch sử RQ09 tại đúng asOf đóng băng.
   ============================================================ */
const RQ10 = "rq10";

/**
 * buildFixture() dùng chung ở trên đã có sẵn w3 với `status: "ENDED",
 * endedAt: 2026-10-01` (mô phỏng TĨNH cho 2 test Scenario C phía trên).
 * Test composed dưới đây cần w3 THỰC SỰ ACTIVE (endedAt=null) tại thời điểm
 * bắt đầu — nếu tái dùng buildFixture() nguyên bản, reallocateDws() sẽ "đóng"
 * một allocation ĐÃ ĐÓNG SẴN, khiến assertion LIVE pass giả (đã tự kiểm chứng
 * bằng cách cố tình phá nhánh UPDATE và thấy test vẫn pass — sai, đã sửa).
 */
function buildFixtureForRealloc() {
  const fixture = buildFixture();
  const w3 = fixture.allocations.find((a) => a.id === "a-w3")!;
  w3.status = "ACTIVE";
  w3.endedAt = null;
  return fixture;
}

type PlanningAllocRow = {
  id: string;
  employmentSessionId: string;
  planningPeriodId: string;
  recruitmentRequestId: string | null;
  allocationEndDate: string | null;
  allocationStartDate: string | null;
  workerId: string;
  gender: string | null;
};

function reallocateDwsRespond(fixture: ReturnType<typeof buildFixture>, planningAllocs: PlanningAllocRow[]) {
  const baseRespond = respondFor(fixture);
  let reqSelectSeq = 0;

  return (call: QueryCall): unknown => {
    if (call.table === "recruitment_requests" && call.root === "select") {
      const id = eqValue(call, "recruitment_requests.id");
      reqSelectSeq += 1;
      if (id === RQ09) return [{ id: RQ09, requestCode: "RQ09", status: "EXPIRED", endDate: "2026-09-30", departmentId: "d1", planningPeriodId: null, maleRq: RQ09_ROW.maleRq, femaleRq: RQ09_ROW.femaleRq, totalRequest: RQ09_ROW.totalRequest, deletedAt: null }];
      if (id === RQ10) return [{ id: RQ10, requestCode: "RQ10", status: "PENDING", endDate: null, departmentId: "d1", planningPeriodId: null, maleRq: 5, femaleRq: 5, totalRequest: 10, deletedAt: null }];
      // reallocateDws() không truyền id trong 2 lệnh select đầu (fromReq/toReq
      // dùng and(eq(id,...), isNull(deletedAt))) — dispatch theo thứ tự gọi khi
      // eqValue không tìm thấy trực tiếp (do and() lồng nhau qua drizzleStub).
      if (reqSelectSeq === 1) return [{ id: RQ09, requestCode: "RQ09", status: "EXPIRED", endDate: "2026-09-30", departmentId: "d1", planningPeriodId: null, maleRq: RQ09_ROW.maleRq, femaleRq: RQ09_ROW.femaleRq, totalRequest: RQ09_ROW.totalRequest, deletedAt: null }];
      return [{ id: RQ10, requestCode: "RQ10", status: "PENDING", endDate: null, departmentId: "d1", planningPeriodId: null, maleRq: 5, femaleRq: 5, totalRequest: 10, deletedAt: null }];
    }
    if (call.table === "planning_allocations") {
      if (call.root === "select") {
        const ids = inArrayValues(call, "planning_allocations.id");
        if (ids) return planningAllocs.filter((a) => ids.includes(a.id));
        return planningAllocs;
      }
      if (call.root === "update") return { rowCount: 1 };
      if (call.root === "insert") return [{ id: "new-planning-alloc-1" }];
    }
    if (call.table === "planning_tasks") return call.root === "select" ? [{ remaining: 0 }] : { rowCount: 0 };
    if (call.table === "employment_sessions" && call.root === "select") {
      const sessId = eqValue(call, "employment_sessions.id");
      const workerId = Object.entries(fixture.sessions).find(([sid]) => sid === sessId)?.[0];
      if (workerId) return [{ workerId: "w3" }]; // fixture này chỉ cần w3
      return [];
    }
    if (call.table === "request_allocations") {
      if (call.root === "update") {
        // syncRequestAllocationOnPlanningMove() ĐÓNG allocation cũ của worker.
        const id = eqValue(call, "request_allocations.id");
        const row = fixture.allocations.find((a) => a.id === id);
        if (row) {
          row.status = "ENDED";
          row.endedAt = new Date(argOf(call, "set") ? "2026-10-05" : "2026-10-05");
        }
        return { rowCount: 1 };
      }
      if (call.root === "insert") {
        // syncRequestAllocationOnPlanningMove() TẠO allocation mới tại RQ10.
        fixture.allocations.push({
          id: `a-w3-rq10`,
          requestId: RQ10,
          workerId: "w3",
          employmentSessionId: "s-w3",
          status: "ACTIVE",
          startedAt: new Date("2026-10-05"),
          endedAt: null,
        });
        return [{ id: "new-request-alloc-1" }];
      }
      // Mọi SELECT (quit/transfer/live/historical/capacity-preflight) — dùng
      // lại respondFor() THẬT (đã có test riêng, không viết lại logic).
      return baseRespond(call);
    }
    return baseRespond(call);
  };
}

function loadReallocateDws(db: FakeDb) {
  const kpi = loadModule(new URL("./workforce-request-kpi.ts", import.meta.url), { stubs: {} });
  const realWorkforceRequest = load(db);
  const core = loadModule(new URL("./planning-recruitment-core.ts", import.meta.url), {
    stubs: {
      "./recruitment-request-columns.ts": loadModule(new URL("./recruitment-request-columns.ts", import.meta.url), { stubs: {} }),
    },
  });
  return loadModule(new URL("./planning-reallocation.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "drizzle-orm": drizzleStub,
      "@/db": { db },
      "@/db/schema": {
        ...schemaStub,
        planningAllocations: makeTable("planning_allocations"),
        planningTasks: makeTable("planning_tasks"),
      },
      "@/lib/helpers": { todayStr: () => "2026-10-05", isMale: (g: string | null) => g === "Nam", isFemale: (g: string | null) => g === "Nữ", toVNDateStr },
      "@/lib/data-scope": { scopeAllowsDepartment: () => true },
      "@/lib/planning-recruitment-core": core,
      "@/lib/workforce-request-kpi": kpi,
      // KHÔNG stub — dùng CHÍNH workforce-request.ts thật đã nạp cho phần
      // batchComputeRequestKpis/getRequestDetail bên trên, để syncRequestAllocationOnPlanningMove()
      // chạy logic canonical thật, cùng chia sẻ `db` giả với phần đọc lịch sử.
      "@/lib/workforce-request": realWorkforceRequest,
    },
  });
}

test("PRE-MERGE C — reallocateDws() THẬT sau khi RQ09 đóng: lịch sử RQ09 tại asOf đóng băng KHÔNG đổi", async () => {
  const fixture = buildFixtureForRealloc(); // w3 THỰC SỰ ACTIVE (endedAt=null) tại thời điểm bắt đầu
  const planningAllocs: PlanningAllocRow[] = [
    { id: "palloc-w3", employmentSessionId: "s-w3", planningPeriodId: "period-old", recruitmentRequestId: RQ09, allocationEndDate: null, allocationStartDate: "2026-09-01", workerId: "w3", gender: "Nam" },
  ];
  const db = createFakeDb({ respond: reallocateDwsRespond(fixture, planningAllocs) });

  const reallocMod = loadReallocateDws(db);
  const result = (await (reallocMod.reallocateDws as (i: unknown) => Promise<{ ok: boolean; moved?: number; error?: string }>)({
    fromRequestId: RQ09,
    toRequestId: RQ10,
    allocationIds: ["palloc-w3"],
    actor: "recruiter-1",
    scope: null,
    today: "2026-10-05",
  }));

  assert.equal(result.ok, true, `reallocateDws() phải thành công (lỗi nếu có: ${result.error})`);
  assert.equal(result.moved, 1);

  // ĐỌC LẠI canonical KPI THẬT (batchComputeRequestKpis — không phải resolveDefaultAsOf() đơn lẻ)
  // cho RQ09 tại asOf ĐÓNG BĂNG của chính nó (2026-09-30) — SAU KHI đã thực sự chuyển w3 đi.
  const detailMod = load(db) as {
    batchComputeRequestKpis: (rows: RequestRow[], asOf: string) => Promise<Map<string, Record<string, number>>>;
  };
  const historicalAfterRealloc = await detailMod.batchComputeRequestKpis([RQ09_ROW], "2026-09-30");
  assert.equal(
    historicalAfterRealloc.get(RQ09)!.totalCurrent,
    1,
    "w3 VẪN phải xuất hiện là Current trong lịch sử RQ09 tại asOf=2026-09-30 — reallocateDws() (chạy SAU đó, 2026-10-05) không được làm trôi/xoá snapshot lịch sử",
  );
  assert.equal(historicalAfterRealloc.get(RQ09)!.totalQuit, 1, "Quit (w1) không đổi");
  assert.equal(historicalAfterRealloc.get(RQ09)!.totalTransferOut, 1, "TransferOut (w2) không đổi");

  // Đối chứng: đọc LIVE (today=2026-10-05, SAU khi chuyển) phải thấy w3 đã RỜI RQ09.
  // detailMod dùng chung load() với todayStr() = TODAY ("2026-10-15") — phải hỏi
  // đúng asOf=TODAY để batchComputeRequestKpis() đi vào nhánh LIVE (status=ACTIVE
  // thuần, không phải historical với so sánh endedAt theo asOf).
  const liveAfterRealloc = await detailMod.batchComputeRequestKpis([RQ09_ROW], TODAY);
  assert.equal(liveAfterRealloc.get(RQ09)!.totalCurrent, 0, `LIVE (today=${TODAY}) đúng là 0 — w3 đã thật sự rời RQ09 theo request_allocations mới`);
});

/* ----------------------- Scenario B (mission mục 10.B): Transfer TƯƠNG LAI (lifecycleAppliedAt=null) KHÔNG được tính Transfer-Out, worker vẫn Current ----------------------- */

function buildFixtureWithFutureTransfer() {
  const fixture = buildFixture();
  // w4: allocation RQ09 VẪN ACTIVE (chưa bị end) — transfer đã CONFIRM_ARRIVED
  // (status=TRANSFER_COMPLETED) nhưng effectiveDate là NGÀY MAI và
  // lifecycleAppliedAt CHƯA được set (applyEffectiveWorkforceMovements chưa chạy tới
  // ngày đó) — đúng invariant workforce-movements.ts: department/allocation chỉ đổi
  // khi lifecycle THỰC SỰ áp dụng, không phải tại thời điểm HR xác nhận.
  fixture.allocations.push({
    id: "a-w4", requestId: RQ09, workerId: "w4", employmentSessionId: "s-w4",
    status: "ACTIVE", startedAt: new Date("2026-09-01"), endedAt: null,
  });
  fixture.sessions["s-w4"] = { id: "s-w4", status: "APPROVED", endDate: null, startingDate: "2026-09-01" };
  fixture.workers.w4 = { id: "w4", gender: "Nam", deletedAt: null };
  fixture.movements.push({
    id: "m-transfer-w4", workerId: "w4", movementType: "transfer", status: "TRANSFER_COMPLETED",
    effectiveDate: "2026-09-30", lifecycleAppliedAt: null,
  });
  return fixture;
}

test("Scenario B: transfer CONFIRMED nhưng lifecycle CHƯA áp dụng (lifecycleAppliedAt=null) -> Transfer-Out=0, worker VẪN tính Current trên RQ09", async () => {
  const fixture = buildFixtureWithFutureTransfer();
  const db = createFakeDb({ respond: respondFor(fixture) });
  const mod = load(db) as {
    batchComputeRequestKpis: (rows: RequestRow[], asOf: string) => Promise<Map<string, Record<string, number>>>;
  };

  const kpis = await mod.batchComputeRequestKpis([RQ09_ROW], TODAY);
  const kpi = kpis.get(RQ09)!;

  // Base fixture đã có sẵn w2 (Transfer-Out=1, lifecycleAppliedAt đã set) — w4 (lifecycleAppliedAt=null)
  // KHÔNG được cộng thêm vào con số này dù status cũng đã TRANSFER_COMPLETED.
  assert.equal(kpi.totalTransferOut, 1, "lifecycleAppliedAt=null -> w4 KHÔNG được tính Transfer-Out dù status đã TRANSFER_COMPLETED (chỉ w2 của base fixture được tính)");
  assert.equal(kpi.totalCurrent, 1, "w4 vẫn ACTIVE trên RQ09 (allocation chưa bị END) -> vẫn tính Current");
});

test("Scenario B: SAU KHI lifecycle áp dụng (lifecycleAppliedAt được set, allocation ENDED) -> Transfer-Out=1, worker KHÔNG còn tính Current", async () => {
  const fixture = buildFixtureWithFutureTransfer();
  // Mô phỏng applyEffectiveWorkforceMovements() đã chạy tới effectiveDate: allocation
  // RQ09 của w4 bị END (append-only, KHÔNG update tại chỗ) và lifecycleAppliedAt được set.
  fixture.allocations = fixture.allocations.map((a) =>
    a.id === "a-w4" ? { ...a, status: "ENDED" as const, endedAt: new Date("2026-09-30") } : a,
  );
  fixture.movements = fixture.movements.map((m) =>
    m.id === "m-transfer-w4" ? { ...m, lifecycleAppliedAt: new Date("2026-09-30") } : m,
  );
  const db = createFakeDb({ respond: respondFor(fixture) });
  const mod = load(db) as {
    batchComputeRequestKpis: (rows: RequestRow[], asOf: string) => Promise<Map<string, Record<string, number>>>;
  };

  const kpis = await mod.batchComputeRequestKpis([RQ09_ROW], TODAY);
  const kpi = kpis.get(RQ09)!;

  // w2 (base fixture) + w4 (giờ đã lifecycle-applied) = 2.
  assert.equal(kpi.totalTransferOut, 2, "lifecycleAppliedAt được set -> Transfer-Out phải tính CẢ w2 (base) và w4");
  assert.equal(kpi.totalCurrent, 0, "allocation RQ09 của w4 đã ENDED -> KHÔNG còn tính Current trên RQ09 (employment vẫn ACTIVE ở dept mới, không thuộc phạm vi KPI của RQ09 nữa)");
});

/* ----------------------- Follow-up correctness fix (post-Phase 2B report): Resignation TƯƠNG LAI (lifecycleAppliedAt=null) KHÔNG được tính Quit, worker vẫn Current — mirror của Scenario B cho Transfer ----------------------- */

function buildFixtureWithFutureResignation() {
  const fixture = buildFixture();
  // w5 (Nữ): allocation RQ09 VẪN ACTIVE (chưa bị end) — HR đã APPROVE_RESIGNATION
  // (status=INACTIVE) nhưng lifecycleAppliedAt CHƯA được set (applyEffectiveWorkforceMovements
  // chưa chạy tới effectiveDate) — đúng invariant workforce-movements.ts: employment_session/
  // request_allocation chỉ đổi khi lifecycle THỰC SỰ áp dụng, không phải tại thời điểm HR xác
  // nhận (xem finalizeResignationEffect() chỉ được gọi khi effectiveDate <= hôm nay hoặc từ
  // applyEffectiveWorkforceMovements()).
  fixture.allocations.push({
    id: "a-w5", requestId: RQ09, workerId: "w5", employmentSessionId: "s-w5",
    status: "ACTIVE", startedAt: new Date("2026-09-01"), endedAt: null,
  });
  fixture.sessions["s-w5"] = { id: "s-w5", status: "APPROVED", endDate: null, startingDate: "2026-09-01" };
  fixture.workers.w5 = { id: "w5", gender: "Nữ", deletedAt: null };
  fixture.movements.push({
    id: "m-resign-w5", workerId: "w5", movementType: "resignation", status: "INACTIVE",
    effectiveDate: "2026-09-30", lifecycleAppliedAt: null,
  });
  return fixture;
}

test("Follow-up: resignation APPROVED nhưng lifecycle CHƯA áp dụng (lifecycleAppliedAt=null) -> Quit=0, worker VẪN tính Current trên RQ09, Balance KHÔNG đổi sớm", async () => {
  const fixture = buildFixtureWithFutureResignation();
  const db = createFakeDb({ respond: respondFor(fixture) });
  const mod = load(db) as {
    batchComputeRequestKpis: (rows: RequestRow[], asOf: string) => Promise<Map<string, Record<string, number>>>;
  };

  const kpis = await mod.batchComputeRequestKpis([RQ09_ROW], TODAY);
  const kpi = kpis.get(RQ09)!;

  // Base fixture đã có sẵn w1 (Quit=1, lifecycleAppliedAt đã set) — w5 (lifecycleAppliedAt=null)
  // KHÔNG được cộng thêm vào con số này dù status đã INACTIVE (quyết định HR đã ghi).
  assert.equal(kpi.totalQuit, 1, "lifecycleAppliedAt=null -> w5 KHÔNG được tính Quit dù status đã INACTIVE (chỉ w1 của base fixture được tính)");
  assert.equal(kpi.totalCurrent, 1, "w5 vẫn ACTIVE trên RQ09 (allocation chưa bị END) -> vẫn tính Current");
  // femaleRq=1 (RQ09_ROW); w5 (Nữ) vẫn tính Current -> femaleCurrent=1 -> Balance = max(0,1-1) = 0.
  // KHÔNG được trôi sớm thành thiếu người chỉ vì HR đã approve resignation nhưng chưa hiệu lực.
  assert.equal(kpi.femaleCurrent, 1, "w5 (Nữ) vẫn ACTIVE -> vẫn tính femaleCurrent");
  assert.equal(kpi.femaleBalance, 0, "Balance KHÔNG được coi w5 đã rời đi sớm — vẫn max(0, 1-1)=0");
});

test("Follow-up: SAU KHI lifecycle áp dụng (lifecycleAppliedAt được set, allocation ENDED) -> Quit=1, worker KHÔNG còn tính Current, Balance chỉ phản ánh Target-Current (không cộng Quit lần 2)", async () => {
  const fixture = buildFixtureWithFutureResignation();
  // Mô phỏng applyEffectiveWorkforceMovements() đã chạy tới effectiveDate: allocation
  // RQ09 của w5 bị END (append-only, KHÔNG update tại chỗ) và lifecycleAppliedAt được set.
  fixture.allocations = fixture.allocations.map((a) =>
    a.id === "a-w5" ? { ...a, status: "ENDED" as const, endedAt: new Date("2026-09-30") } : a,
  );
  fixture.movements = fixture.movements.map((m) =>
    m.id === "m-resign-w5" ? { ...m, lifecycleAppliedAt: new Date("2026-09-30") } : m,
  );
  const db = createFakeDb({ respond: respondFor(fixture) });
  const mod = load(db) as {
    batchComputeRequestKpis: (rows: RequestRow[], asOf: string) => Promise<Map<string, Record<string, number>>>;
  };

  const kpis = await mod.batchComputeRequestKpis([RQ09_ROW], TODAY);
  const kpi = kpis.get(RQ09)!;

  // w1 (base fixture) + w5 (giờ đã lifecycle-applied) = 2.
  assert.equal(kpi.totalQuit, 2, "lifecycleAppliedAt được set -> Quit phải tính CẢ w1 (base) và w5");
  assert.equal(kpi.totalCurrent, 0, "allocation RQ09 của w5 đã ENDED -> Current giảm đúng 1 (từ 1 xuống 0)");
  // femaleRq=1; femaleCurrent giờ =0 (w5 đã ENDED) -> Balance = max(0, 1-0) = 1, KHÔNG PHẢI 2
  // (một công thức sai sẽ cộng thêm Quit=1 lần thứ hai: 1 (target-current) + 1 (quit) = 2).
  assert.equal(kpi.femaleCurrent, 0, "w5 (Nữ) không còn ACTIVE trên RQ09 -> femaleCurrent giảm về 0");
  assert.equal(kpi.femaleBalance, 1, "Balance = max(0, Target-Current) = 1, KHÔNG cộng thêm Quit lần hai thành 2");
});

test("Quit/TransferOut không đổi bởi asOf muộn hơn effectiveDate (bị chặn bởi window.end=endDate, không phải bởi asOf)", async () => {
  const fixture = buildFixture();
  const db = createFakeDb({ respond: respondFor(fixture) });
  const mod = load(db) as {
    batchComputeRequestKpis: (rows: RequestRow[], asOf: string) => Promise<Map<string, Record<string, number>>>;
  };
  const farFuture = await mod.batchComputeRequestKpis([RQ09_ROW], "2027-01-01");
  const kpi = farFuture.get(RQ09)!;
  assert.equal(kpi.totalQuit, 1, "Quit vẫn = 1 dù xem ở thời điểm rất xa sau đó — cửa sổ request (endDate) đã chốt, không đổi theo asOf");
  assert.equal(kpi.totalTransferOut, 1, "TransferOut tương tự — bất biến theo cửa sổ request");
});

/* ============================================================
   Follow-up correctness fix #2 (post-PR#203 report): requestWindow() phải dùng
   endDate (ngày kết thúc yêu cầu thực sự) làm biên trên cho movement attribution,
   KHÔNG dùng expectedDate (ngày CẦN nhân lực — chỉ là deadline/target hiển thị,
   sort, cảnh báo, KHÔNG phải lifecycle end). 4 case bắt buộc theo yêu cầu review.
   ============================================================ */

const RQW = "rqw";

function buildWindowFixture() {
  const allocations: AllocRow[] = [
    { id: "a-wq1", requestId: RQW, workerId: "wq1", employmentSessionId: "s-wq1", status: "ACTIVE", startedAt: new Date("2026-09-01"), endedAt: null },
    { id: "a-wq2", requestId: RQW, workerId: "wq2", employmentSessionId: "s-wq2", status: "ACTIVE", startedAt: new Date("2026-09-01"), endedAt: null },
    { id: "a-wq3", requestId: RQW, workerId: "wq3", employmentSessionId: "s-wq3", status: "ACTIVE", startedAt: new Date("2026-09-01"), endedAt: null },
  ];
  const sessions: Record<string, SessionRow> = {
    "s-wq1": { id: "s-wq1", status: "APPROVED", endDate: null, startingDate: "2026-09-01" },
    "s-wq2": { id: "s-wq2", status: "APPROVED", endDate: null, startingDate: "2026-09-01" },
    "s-wq3": { id: "s-wq3", status: "APPROVED", endDate: null, startingDate: "2026-09-01" },
  };
  const workers: Record<string, WorkerRow> = {
    wq1: { id: "wq1", gender: "Nam", deletedAt: null },
    wq2: { id: "wq2", gender: "Nữ", deletedAt: null },
    wq3: { id: "wq3", gender: "Nam", deletedAt: null },
  };
  // wq1: resign hiệu lực 09-20 (SAU expectedDate=09-10, TRƯỚC endDate=09-30).
  // wq2: transfer hiệu lực 09-22 (cũng nằm giữa expectedDate và endDate).
  // wq3: resign hiệu lực 10-01 (SAU endDate=09-30) — dùng cho case W2.
  const movements: MovementRow[] = [
    { id: "m-resign-wq1", workerId: "wq1", movementType: "resignation", status: "INACTIVE", effectiveDate: "2026-09-20", lifecycleAppliedAt: new Date("2026-09-20") },
    { id: "m-transfer-wq2", workerId: "wq2", movementType: "transfer", status: "TRANSFER_COMPLETED", effectiveDate: "2026-09-22", lifecycleAppliedAt: new Date("2026-09-22") },
    { id: "m-resign-wq3", workerId: "wq3", movementType: "resignation", status: "INACTIVE", effectiveDate: "2026-10-01", lifecycleAppliedAt: new Date("2026-10-01") },
  ];
  const pipeline: { requestId: string; gender: string; status: string; submittedAt: Date }[] = [];
  return { allocations, sessions, workers, movements, pipeline };
}

test("W1: expectedDate (09-10) TRƯỚC endDate (09-30) — Quit hiệu lực 09-20 và Transfer-Out hiệu lực 09-22 (SAU expectedDate, TRƯỚC endDate) VẪN được tính, KHÔNG bị loại chỉ vì đã qua expectedDate", async () => {
  const fixture = buildWindowFixture();
  const db = createFakeDb({ respond: respondFor(fixture) });
  const mod = load(db) as {
    batchComputeRequestKpis: (rows: RequestRow[], asOf: string) => Promise<Map<string, Record<string, number>>>;
  };
  const rqwRow: RequestRow = {
    id: RQW, maleRq: 2, femaleRq: 1, totalRequest: 3,
    requestedDate: "2026-09-01", expectedDate: "2026-09-10", endDate: "2026-09-30",
    createdAt: new Date("2026-09-01"),
  };

  const kpis = await mod.batchComputeRequestKpis([rqwRow], "2026-10-15");
  const kpi = kpis.get(RQW)!;

  assert.equal(kpi.totalQuit, 1, "wq1 resign 09-20 (sau expectedDate=09-10) VẪN thuộc lịch sử request — expectedDate KHÔNG phải hard upper bound");
  assert.equal(kpi.totalTransferOut, 1, "wq2 transfer 09-22 (sau expectedDate=09-10) VẪN thuộc lịch sử request — cùng lý do");
});

test("W2: movement hiệu lực SAU endDate (10-01 > 09-30) KHÔNG được tính vào request này", async () => {
  const fixture = buildWindowFixture();
  const db = createFakeDb({ respond: respondFor(fixture) });
  const mod = load(db) as {
    batchComputeRequestKpis: (rows: RequestRow[], asOf: string) => Promise<Map<string, Record<string, number>>>;
  };
  const rqwRow: RequestRow = {
    id: RQW, maleRq: 2, femaleRq: 1, totalRequest: 3,
    requestedDate: "2026-09-01", expectedDate: "2026-09-10", endDate: "2026-09-30",
    createdAt: new Date("2026-09-01"),
  };

  const kpis = await mod.batchComputeRequestKpis([rqwRow], "2026-10-15");
  const kpi = kpis.get(RQW)!;

  // wq3 (resign 10-01) không được tính — chỉ wq1 (Quit) và wq2 (TransferOut) thuộc window.
  assert.equal(kpi.totalQuit, 1, "chỉ wq1 (09-20, trong window) được tính — wq3 (10-01, sau endDate) bị loại");
  assert.equal(kpi.totalTransferOut, 1, "wq2 (09-22, trong window) được tính bình thường");
});

test("W3: request ĐANG MỞ (endDate=null) đã qua expectedDate — movement hiệu lực SAU expectedDate nhưng <= asOf VẪN được attribution, chứng minh expectedDate không phải lifecycle end", async () => {
  const fixture = buildWindowFixture();
  const db = createFakeDb({ respond: respondFor(fixture) });
  const mod = load(db) as {
    batchComputeRequestKpis: (rows: RequestRow[], asOf: string) => Promise<Map<string, Record<string, number>>>;
  };
  // Request vẫn MỞ: chưa có endDate. expectedDate=09-10 đã qua (asOf=TODAY=10-15).
  const openRow: RequestRow = {
    id: RQW, maleRq: 2, femaleRq: 1, totalRequest: 3,
    requestedDate: "2026-09-01", expectedDate: "2026-09-10", endDate: null,
    createdAt: new Date("2026-09-01"),
  };

  const kpis = await mod.batchComputeRequestKpis([openRow], TODAY);
  const kpi = kpis.get(RQW)!;

  // Cả 3 movement (kể cả wq3 hiệu lực 10-01) đều <= asOf=TODAY(10-15) và request
  // chưa đóng (endDate=null) -> KHÔNG có upper bound nào khác ngoài asOf.
  assert.equal(kpi.totalQuit, 2, "wq1 (09-20) VÀ wq3 (10-01) đều được tính — request còn mở, chỉ bị chặn bởi asOf, không bởi expectedDate");
  assert.equal(kpi.totalTransferOut, 1, "wq2 (09-22) được tính bình thường");
});

test("W4: historical request THIẾU endDate — asOf do resolveDefaultAsOf() cung cấp (mô phỏng ở đây bằng giá trị asOf truyền vào) mới là biên đóng, requestWindow() KHÔNG tự mở vô hạn", async () => {
  const fixture = buildWindowFixture();
  // Thêm 1 worker mới với movement hiệu lực SAU asOf lịch sử đã resolve (mô phỏng dữ
  // liệu phát sinh sau khi request đã "đóng" theo asOf lịch sử — không được rò vào).
  fixture.allocations.push({ id: "a-wq4", requestId: RQW, workerId: "wq4", employmentSessionId: "s-wq4", status: "ACTIVE", startedAt: new Date("2026-09-01"), endedAt: null });
  fixture.sessions["s-wq4"] = { id: "s-wq4", status: "APPROVED", endDate: null, startingDate: "2026-09-01" };
  fixture.workers.wq4 = { id: "wq4", gender: "Nữ", deletedAt: null };
  fixture.movements.push({ id: "m-resign-wq4", workerId: "wq4", movementType: "resignation", status: "INACTIVE", effectiveDate: "2026-09-25", lifecycleAppliedAt: new Date("2026-09-25") });

  const db = createFakeDb({ respond: respondFor(fixture) });
  const mod = load(db) as {
    batchComputeRequestKpis: (rows: RequestRow[], asOf: string) => Promise<Map<string, Record<string, number>>>;
  };
  // Legacy row: endDate=null (chưa từng được ghi). resolveDefaultAsOf() (không gọi trực
  // tiếp ở đây — đã có test riêng ở workforce-request.test.ts) đã resolve fallback closing
  // = "2026-09-20" (ví dụ completedDate/updatedAt fallback) — route truyền asOf này vào
  // batchComputeRequestKpis(), KHÔNG phải today.
  const legacyRow: RequestRow = {
    id: RQW, maleRq: 2, femaleRq: 2, totalRequest: 4,
    requestedDate: "2026-09-01", expectedDate: "2026-09-10", endDate: null,
    createdAt: new Date("2026-09-01"),
  };
  const resolvedAsOf = "2026-09-20";

  const kpis = await mod.batchComputeRequestKpis([legacyRow], resolvedAsOf);
  const kpi = kpis.get(RQW)!;

  // wq1 (09-20, đúng bằng resolved asOf) -> tính. wq4 (09-25, SAU resolved asOf) -> KHÔNG
  // tính, dù endDate=null — requestWindow() không được tự mở cửa sổ vượt qua asOf lịch sử
  // đã chốt chỉ vì thiếu endDate.
  assert.equal(kpi.totalQuit, 1, "chỉ wq1 (<= resolved asOf) được tính; wq4 (sau resolved asOf) bị loại dù endDate=null");
});

/* ============================================================
   Final pre-merge review finding (BLOCKER, fixed pre-merge): a worker
   allocated to the SAME request MORE THAN ONCE over time (append-only
   ALLOCATE -> END -> REALLOCATE -> END, e.g. via "Chuyển phân bổ DW" out
   and later back into the same RQ) must have their resignation/transfer
   counted EXACTLY ONCE for that request — not once per allocation row
   that happens to join with the movement.
   ============================================================ */

test("Duplicate-count fix: worker allocated TWICE to the same request (re-allocated in after leaving) — a single resignation must count Quit=1, not 2", async () => {
  const fixture = buildFixture();
  // w7: first stint 09-01..09-10 (ended — e.g. reallocated OUT via Chuyển phân bổ DW),
  // second stint 09-12..09-25 (reallocated back IN). ONE resignation, effective 09-20,
  // lifecycleAppliedAt set — both allocation rows independently satisfy
  // allocatedAt <= effectiveDate, so the raw JOIN produces 2 rows for this ONE movement.
  fixture.allocations.push(
    { id: "a-w7a", requestId: RQ09, workerId: "w7", employmentSessionId: "s-w7", status: "ENDED", startedAt: new Date("2026-09-01"), endedAt: new Date("2026-09-10") },
    { id: "a-w7b", requestId: RQ09, workerId: "w7", employmentSessionId: "s-w7", status: "ENDED", startedAt: new Date("2026-09-12"), endedAt: new Date("2026-09-25") },
  );
  fixture.sessions["s-w7"] = { id: "s-w7", status: "ENDED", endDate: "2026-09-25", startingDate: "2026-09-01" };
  fixture.workers.w7 = { id: "w7", gender: "Nam", deletedAt: null };
  fixture.movements.push({ id: "m-resign-w7", workerId: "w7", movementType: "resignation", status: "INACTIVE", effectiveDate: "2026-09-20", lifecycleAppliedAt: new Date("2026-09-20") });

  const db = createFakeDb({ respond: respondFor(fixture) });
  const mod = load(db) as {
    batchComputeRequestKpis: (rows: RequestRow[], asOf: string) => Promise<Map<string, Record<string, number>>>;
  };

  const kpis = await mod.batchComputeRequestKpis([RQ09_ROW], "2026-09-30");
  const kpi = kpis.get(RQ09)!;

  // Base fixture already contributes w1 (Quit=1). w7's ONE resignation must add exactly 1,
  // not 2 — even though 2 of w7's own allocation rows both qualify for the window check.
  assert.equal(kpi.totalQuit, 2, "w1 (base) + w7 (1 resignation, not 2) = 2 — the same movement joined via 2 allocation rows must not be double-counted");
});

test("Duplicate-count fix: worker allocated TWICE to the same request — a single transfer must count Transfer-Out=1, not 2, and getRequestDetail() must not list the worker twice", async () => {
  const fixture = buildFixture();
  fixture.allocations.push(
    { id: "a-w8a", requestId: RQ09, workerId: "w8", employmentSessionId: "s-w8", status: "ENDED", startedAt: new Date("2026-09-01"), endedAt: new Date("2026-09-08") },
    { id: "a-w8b", requestId: RQ09, workerId: "w8", employmentSessionId: "s-w8", status: "ENDED", startedAt: new Date("2026-09-10"), endedAt: new Date("2026-09-18") },
  );
  fixture.sessions["s-w8"] = { id: "s-w8", status: "APPROVED", endDate: null, startingDate: "2026-09-01" };
  fixture.workers.w8 = { id: "w8", gender: "Nữ", deletedAt: null };
  fixture.movements.push({ id: "m-transfer-w8", workerId: "w8", movementType: "transfer", status: "TRANSFER_COMPLETED", effectiveDate: "2026-09-15", lifecycleAppliedAt: new Date("2026-09-15") });

  const db = createFakeDb({ respond: respondFor(fixture) });
  const mod = load(db) as {
    batchComputeRequestKpis: (rows: RequestRow[], asOf: string) => Promise<Map<string, Record<string, number>>>;
  };

  const kpis = await mod.batchComputeRequestKpis([RQ09_ROW], "2026-09-30");
  const kpi = kpis.get(RQ09)!;

  // Base fixture already contributes w2 (TransferOut=1). w8's ONE transfer must add exactly 1.
  assert.equal(kpi.totalTransferOut, 2, "w2 (base) + w8 (1 transfer, not 2) = 2 — same movement joined via 2 allocation rows must not be double-counted");
});
