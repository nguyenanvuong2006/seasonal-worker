import test from "node:test";
import assert from "node:assert/strict";
import {
  createFakeDb,
  drizzleStub,
  makeTable,
  argOf,
  eqValue,
  inArrayValues,
  sqlTexts,
  type FakeDb,
  type QueryCall,
} from "./test-support/fake-drizzle.ts";
import { loadModule, serverOnlyStub } from "./test-support/load-module.ts";

/* ============================================================
   KIỂM THỬ TẦNG DB — HẾT HẠN YÊU CẦU & TÁI PHÂN BỔ DW
   ------------------------------------------------------------
   Chạy trên ĐÚNG src/lib/planning-reallocation.ts, với Drizzle và
   Postgres được thay bằng bản giả ghi lại mọi truy vấn.

   Trọng tâm là các quy tắc cứng của nghiệp vụ:
     • Yêu cầu hết hạn  ≠  DW nghỉ việc  (Yêu cầu #7, #9)
     • Hết hạn ⇒ EXPIRED, KHÔNG BAO GIỜ CANCELLED  (Yêu cầu #13)
     • Tái phân bổ giữ nguyên lịch sử, truy vết được  (Yêu cầu #4, #8)
     • Data Scope chặn ở SERVER  (Yêu cầu #15)
     • Cron chạy lại không sinh task trùng  (Yêu cầu #14)
   ============================================================ */

const TABLES = [
  "departments",
  "employment_sessions",
  "planning_allocations",
  "planning_tasks",
  "recruitment_requests",
  "request_allocations",
  "worker_profiles",
  "workforce_movements",
] as const;

const schemaStub = {
  departments: makeTable("departments"),
  employmentSessions: makeTable("employment_sessions"),
  planningAllocations: makeTable("planning_allocations"),
  planningTasks: makeTable("planning_tasks"),
  recruitmentRequests: makeTable("recruitment_requests"),
  requestAllocations: makeTable("request_allocations"),
  workerProfiles: makeTable("worker_profiles"),
  workforceMovements: makeTable("workforce_movements"),
};

/**
 * Phase 3B — F1/F2: `batchComputeRequestKpis()` (dùng bởi listReallocationTargets,
 * F2) và `resolveTotalRequestOf()`/`syncRequestAllocationOnPlanningMove()` (dùng
 * bởi reallocateDws's capacity preflight, F1) SONG được đọc từ "@/lib/workforce-
 * request" ở planning-reallocation.ts. Chỉ `batchComputeRequestKpis` cần một stub
 * test-controllable (công thức Balance thật đã có bộ test riêng đầy đủ ở
 * workforce-request-db.test.ts — file này chỉ cần chứng minh listReallocationTargets
 * ĐỌC ĐÚNG kết quả batch, không lấy cột DB tĩnh). `resolveTotalRequestOf` là công
 * thức thuần 3 dòng (workforce-request-kpi.ts) — lặp lại y hệt ở đây KHÔNG phải
 * business logic mới, chỉ là wiring test.
 */
function workforceRequestStub(opts: {
  requestKpis?: Map<string, { totalBalance: number }>;
  syncResult?: boolean;
} = {}) {
  return {
    resolveTotalRequestOf: (r: { maleRq: number; femaleRq: number; totalRequest: number }) =>
      r.maleRq > 0 || r.femaleRq > 0 ? r.maleRq + r.femaleRq : Math.max(0, r.totalRequest ?? 0),
    // Mặc định "true" (đồng bộ thành công) — khớp với capacity preflight THẬT
    // (planBatchAllocation, nạp không stub) đã xác nhận đủ chỉ tiêu cho các test
    // happy-path. Test riêng cho nhánh internal-consistency throw (F1 Option 1)
    // truyền syncResult:false để mô phỏng "sync bất ngờ từ chối dù preflight PASS".
    syncRequestAllocationOnPlanningMove: async () => opts.syncResult ?? true,
    batchComputeRequestKpis: async (rows: { id: string }[]) => {
      const map = new Map<string, { totalBalance: number }>();
      for (const r of rows) map.set(r.id, opts.requestKpis?.get(r.id) ?? { totalBalance: 0 });
      return map;
    },
  };
}

function load(db: FakeDb, opts: { requestKpis?: Map<string, { totalBalance: number }>; syncResult?: boolean } = {}) {
  return loadModule(new URL("./planning-reallocation.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "drizzle-orm": drizzleStub,
      "@/db": { db },
      "@/db/schema": schemaStub,
      "@/lib/helpers": {
        todayStr: () => "2026-08-16",
        isMale: (g: string | null) => String(g ?? "").toUpperCase().startsWith("M") || g === "Nam",
        isFemale: (g: string | null) => String(g ?? "").toUpperCase().startsWith("F") || g === "Nữ",
      },
      "@/lib/data-scope": {
        scopeAllowsDepartment: (scope: string[] | null, deptId: string | null) => {
          if (scope === null) return true;
          if (!deptId) return false;
          return scope.includes(deptId);
        },
      },
      "@/lib/planning-recruitment-core": corePassthrough(),
      // planAllocation()/planBatchAllocation()/classifyGender() là công thức THUẦN
      // (không import gì khác — xem docblock workforce-request-kpi.ts) — nạp THẬT
      // (không stub) để F1's capacity preflight chạy đúng logic production, không
      // phải bản chép tay.
      "@/lib/workforce-request-kpi": loadModule(new URL("./workforce-request-kpi.ts", import.meta.url), { stubs: {} }),
      // WORKFORCE REQUEST LINKAGE — batchComputeRequestKpis (Balance thật, đã có bộ
      // test riêng ở workforce-request-db.test.ts) và syncRequestAllocationOnPlanningMove
      // (đồng bộ request_allocations worker-level) đều stub no-op/test-controllable
      // để sandbox không cần nạp toàn bộ module DB.
      "@/lib/workforce-request": workforceRequestStub(opts),
    },
  });
}

/** Dùng lại đúng logic thuần của core (đã có test riêng), nạp qua vm. */
function corePassthrough() {
  return loadModule(new URL("./planning-recruitment-core.ts", import.meta.url), {
    stubs: {
      "./recruitment-request-columns.ts": loadModule(
        new URL("./recruitment-request-columns.ts", import.meta.url),
        { stubs: {} },
      ),
    },
  });
}

/** Bộ 20 phân bổ đang mở — dùng cho kịch bản chuyển hàng loạt. */
function makeAllocations(n: number, requestId: string) {
  return Array.from({ length: n }, (_, i) => ({
    id: `alloc-${i + 1}`,
    employmentSessionId: `sess-${i + 1}`,
    planningPeriodId: "period-old",
    recruitmentRequestId: requestId,
    allocationEndDate: null,
    allocationStartDate: "2026-06-01",
    workerId: `w-${i + 1}`,
    workerName: `DW ${i + 1}`,
    workerCccd: `0790000000${i}`,
    gender: i % 2 === 0 ? "Nam" : "Nữ",
    deptId: "dept-A",
  }));
}

/* ------------------------------------------------------------
   1. QUÉT HẾT HẠN
   ------------------------------------------------------------ */

test("yêu cầu hết hạn được đánh dấu EXPIRED, tuyệt đối không CANCELLED", async () => {
  const expired = [
    {
      id: "req-old",
      requestCode: "RQ-2026-001",
      status: "PROCESSING",
      endDate: "2026-08-01",
      department: "Farm A",
      departmentId: "dept-A",
      section: "Sec 1",
      groupName: "Grp 1",
      planningPeriodId: "period-old",
    },
  ];

  const db = createFakeDb({
    respond(call) {
      if (call.root === "select" && call.table === "recruitment_requests") return expired;
      if (call.root === "select" && call.table === "planning_allocations") return makeAllocations(3, "req-old");
      if (call.root === "insert") return [{ id: "task-1" }];
      return undefined;
    },
  });

  const mod = load(db);
  const result = (await (mod.scanExpiredRequestsAndCreateTasks as (t?: string) => Promise<Record<string, number>>)(
    "2026-08-16",
  )) as { markedExpired: number; tasksCreated: number };

  assert.equal(result.markedExpired, 1);

  const statusUpdate = db
    .writesTo("recruitment_requests")
    .find((c) => c.root === "update") as QueryCall;
  assert.ok(statusUpdate, "phải có lệnh update trạng thái yêu cầu");
  const setPayload = argOf(statusUpdate, "set") as { status?: string };
  assert.equal(setPayload.status, "EXPIRED");
  assert.notEqual(setPayload.status, "CANCELLED");
});

test("hết hạn KHÔNG ghi nghỉ việc: không đụng workforce_movements hay employment_sessions", async () => {
  const db = createFakeDb({
    respond(call) {
      if (call.root === "select" && call.table === "recruitment_requests") {
        return [
          {
            id: "req-old",
            requestCode: "RQ-2026-001",
            status: "PROCESSING",
            endDate: "2026-08-01",
            department: "Farm A",
            departmentId: "dept-A",
            section: null,
            groupName: null,
            planningPeriodId: "period-old",
          },
        ];
      }
      if (call.root === "select" && call.table === "planning_allocations") return makeAllocations(5, "req-old");
      if (call.root === "insert") return [{ id: "task-1" }];
      return undefined;
    },
  });

  const mod = load(db);
  await (mod.scanExpiredRequestsAndCreateTasks as (t?: string) => Promise<unknown>)("2026-08-16");

  // ĐÂY LÀ QUY TẮC CỨNG (#9): hết hạn yêu cầu không phải nghỉ việc.
  assert.equal(db.writesTo("workforce_movements").length, 0, "không được tạo bất kỳ workforce movement nào");
  assert.equal(db.writesTo("employment_sessions").length, 0, "không được đụng vào employment session của DW");
});

test("yêu cầu hết hạn còn DW đang phân bổ tạo ĐÚNG 1 task, kèm đủ thông tin cho Recruiter", async () => {
  const db = createFakeDb({
    respond(call) {
      if (call.root === "select" && call.table === "recruitment_requests") {
        return [
          {
            id: "req-old",
            requestCode: "RQ-2026-007",
            status: "PROCESSING",
            endDate: "2026-08-10",
            department: "Farm A",
            departmentId: "dept-A",
            section: "Sec 1",
            groupName: "Grp 2",
            planningPeriodId: "period-old",
          },
        ];
      }
      if (call.root === "select" && call.table === "planning_allocations") return makeAllocations(4, "req-old");
      if (call.root === "insert") return [{ id: "task-1" }];
      return undefined;
    },
  });

  const mod = load(db);
  const res = (await (mod.scanExpiredRequestsAndCreateTasks as (t?: string) => Promise<Record<string, number>>)(
    "2026-08-16",
  )) as { tasksCreated: number };

  assert.equal(res.tasksCreated, 1);

  const taskInserts = db.writesTo("planning_tasks").filter((c) => c.root === "insert");
  assert.equal(taskInserts.length, 1, "chỉ được tạo đúng 1 task");

  const values = argOf(taskInserts[0], "values") as {
    taskType: string;
    status: string;
    recruitmentRequestId: string;
    dueDate: string;
    detail: {
      requestCode: string;
      department: string;
      section: string;
      groupName: string;
      endDate: string;
      totalActiveAllocations: number;
      maleCount: number;
      femaleCount: number;
      workers: unknown[];
    };
  };

  assert.equal(values.taskType, "PLANNING_REALLOCATION_REQUIRED");
  assert.equal(values.status, "OPEN");
  assert.equal(values.recruitmentRequestId, "req-old");
  // Task phải hiện: mã yêu cầu cũ, Dept/Section/Group, End Date,
  // tổng phân bổ đang hoạt động, số nam/nữ, danh sách DW (Yêu cầu #7).
  assert.equal(values.detail.requestCode, "RQ-2026-007");
  assert.equal(values.detail.department, "Farm A");
  assert.equal(values.detail.section, "Sec 1");
  assert.equal(values.detail.groupName, "Grp 2");
  assert.equal(values.detail.endDate, "2026-08-10");
  assert.equal(values.detail.totalActiveAllocations, 4);
  assert.equal(values.detail.maleCount, 2);
  assert.equal(values.detail.femaleCount, 2);
  assert.equal(values.detail.workers.length, 4);
});

test("cron chạy lại nhiều lần không sinh task trùng (onConflictDoNothing + unique index)", async () => {
  const request = {
    id: "req-old",
    requestCode: "RQ-2026-001",
    status: "EXPIRED",
    endDate: "2026-08-01",
    department: "Farm A",
    departmentId: "dept-A",
    section: null,
    groupName: null,
    planningPeriodId: "period-old",
  };

  let insertAttempts = 0;
  const db = createFakeDb({
    respond(call) {
      if (call.root === "select" && call.table === "recruitment_requests") return [request];
      if (call.root === "select" && call.table === "planning_allocations") return makeAllocations(2, "req-old");
      if (call.root === "insert" && call.table === "planning_tasks") {
        insertAttempts += 1;
        // Lần đầu tạo được; các lần sau unique index chặn → mảng rỗng.
        return insertAttempts === 1 ? [{ id: "task-1" }] : [];
      }
      return undefined;
    },
  });

  const mod = load(db);
  const scan = mod.scanExpiredRequestsAndCreateTasks as (t?: string) => Promise<{ tasksCreated: number }>;

  const first = await scan("2026-08-16");
  const second = await scan("2026-08-16");
  const third = await scan("2026-08-16");

  assert.equal(first.tasksCreated, 1, "lần chạy đầu tạo 1 task");
  assert.equal(second.tasksCreated, 0, "chạy lại KHÔNG tạo thêm task");
  assert.equal(third.tasksCreated, 0, "chạy lần ba vẫn không tạo thêm");

  // Bảo vệ ở tầng ứng dụng phải luôn hiện diện, không chỉ dựa vào DB.
  const inserts = db.writesTo("planning_tasks").filter((c) => c.root === "insert");
  for (const ins of inserts) {
    assert.ok(
      ins.ops.some((o) => o.fn === "onConflictDoNothing"),
      "mọi insert task phải có onConflictDoNothing",
    );
  }

  // Yêu cầu đã EXPIRED sẵn thì không update trạng thái lại lần nữa.
  assert.equal(first.tasksCreated + second.tasksCreated + third.tasksCreated, 1);
});

test("yêu cầu hết hạn nhưng không còn DW nào thì tự đóng task, không tạo task mới", async () => {
  const db = createFakeDb({
    respond(call) {
      if (call.root === "select" && call.table === "recruitment_requests") {
        return [
          {
            id: "req-empty",
            requestCode: "RQ-2026-009",
            status: "PROCESSING",
            endDate: "2026-08-01",
            department: "Farm B",
            departmentId: "dept-B",
            section: null,
            groupName: null,
            planningPeriodId: null,
          },
        ];
      }
      if (call.root === "select" && call.table === "planning_allocations") return [];
      if (call.root === "update" && call.table === "planning_tasks") return { rowCount: 1 };
      return undefined;
    },
  });

  const mod = load(db);
  const res = (await (mod.scanExpiredRequestsAndCreateTasks as (t?: string) => Promise<Record<string, number>>)(
    "2026-08-16",
  )) as { tasksCreated: number; tasksAutoClosed: number };

  assert.equal(res.tasksCreated, 0);
  assert.equal(res.tasksAutoClosed, 1);
  assert.equal(db.writesTo("planning_tasks").filter((c) => c.root === "insert").length, 0);
});

/* ------------------------------------------------------------
   2. TÁI PHÂN BỔ
   ------------------------------------------------------------ */

type ReallocResult =
  | { ok: true; moved: number; newAllocationIds: string[]; taskClosed: boolean; resignationsCreated: 0 }
  | { ok: false; status: number; error: string };

/** ACTIVE request_allocations sẵn có tại yêu cầu ĐÍCH trước khi tái phân bổ. */
type DestActiveAlloc = { id: string; requestId: string; workerId: string; sessionId: string; gender: string | null };

function reallocSetup(opts: {
  allocations: ReturnType<typeof makeAllocations>;
  fromReq?: Record<string, unknown> | undefined;
  toReq?: Record<string, unknown> | undefined;
  remainingAfter?: number;
  /** Phase 3B — F1: ACTIVE request_allocations hiện có tại request đích, dùng cho capacity preflight. */
  destActiveAllocations?: DestActiveAlloc[];
  requestKpis?: Map<string, { totalBalance: number }>;
  syncResult?: boolean;
}) {
  const fromReq =
    opts.fromReq === undefined
      ? {
          id: "req-old",
          requestCode: "RQ-2026-001",
          status: "EXPIRED",
          endDate: "2026-08-01",
          departmentId: "dept-A",
          planningPeriodId: "period-old",
        }
      : opts.fromReq;
  const toReq =
    opts.toReq === undefined
      ? {
          id: "req-new",
          requestCode: "RQ-2026-050",
          status: "PENDING",
          endDate: "2026-12-31",
          departmentId: "dept-A",
          planningPeriodId: "period-new",
          // Mặc định RỘNG RÃI (không ai trong test cũ quan tâm capacity) — các test
          // capacity riêng (D1-D4) tự set toReq.maleRq/femaleRq/totalRequest chính xác.
          maleRq: 0,
          femaleRq: 0,
          totalRequest: 999,
        }
      : opts.toReq;
  const destActiveAllocations = opts.destActiveAllocations ?? [];

  let reqSelects = 0;
  let newAllocSeq = 0;

  const db = createFakeDb({
    respond(call) {
      if (call.root === "select" && call.table === "recruitment_requests") {
        reqSelects += 1;
        // Lần 1 = yêu cầu nguồn, lần 2 = yêu cầu đích.
        return reqSelects === 1 ? (fromReq ? [fromReq] : []) : toReq ? [toReq] : [];
      }
      if (call.root === "select" && call.table === "planning_allocations") {
        // Truy vấn đếm số phân bổ còn mở dùng count(*)
        if (sqlTexts(call).some((t) => t.includes("count(*)"))) {
          return [{ remaining: opts.remainingAfter ?? 0 }];
        }
        return opts.allocations;
      }
      // Phase 3B — F1: preflight đọc ACTIVE request_allocations tại request đích
      // (+ bất kỳ request nào của các worker được chọn) TRƯỚC khi ghi gì.
      if (call.root === "select" && call.table === "request_allocations") return destActiveAllocations;
      if (call.root === "insert" && call.table === "planning_allocations") {
        newAllocSeq += 1;
        return [{ id: `new-alloc-${newAllocSeq}` }];
      }
      if (call.root === "update" && call.table === "planning_tasks") return { rowCount: 1 };
      return undefined;
    },
  });

  return { db, mod: load(db, { requestKpis: opts.requestKpis, syncResult: opts.syncResult }) };
}

test("chuyển 20 DW sang yêu cầu mới: đủ 20, không ai bị đánh dấu nghỉ việc", async () => {
  const allocations = makeAllocations(20, "req-old");
  const { db, mod } = reallocSetup({ allocations });

  const res = (await (mod.reallocateDws as (i: unknown) => Promise<ReallocResult>)({
    fromRequestId: "req-old",
    toRequestId: "req-new",
    allocationIds: allocations.map((a) => a.id),
    actor: "recruiter-1",
    scope: null,
    today: "2026-08-16",
  })) as ReallocResult;

  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.moved, 20, "phải chuyển đủ 20 DW");
  assert.equal(res.newAllocationIds.length, 20);

  // QUY TẮC CỨNG #9 — không nghỉ việc, không quit date, không cờ inactive.
  assert.equal(res.resignationsCreated, 0);
  assert.equal(db.writesTo("workforce_movements").length, 0, "không tạo RESIGNATION");
  assert.equal(db.writesTo("employment_sessions").length, 0, "không set end_date cho DW");

  // Toàn bộ thao tác nằm trong MỘT transaction (Yêu cầu #8).
  assert.equal(db.transactions, 1);
});

test("phân bổ cũ được ĐÓNG chứ không xoá — lịch sử vẫn truy vết được", async () => {
  const allocations = makeAllocations(3, "req-old");
  const { db, mod } = reallocSetup({ allocations });

  await (mod.reallocateDws as (i: unknown) => Promise<ReallocResult>)({
    fromRequestId: "req-old",
    toRequestId: "req-new",
    allocationIds: allocations.map((a) => a.id),
    actor: "recruiter-1",
    scope: null,
    today: "2026-08-16",
  });

  // Append-only: KHÔNG có DELETE nào (Yêu cầu #4).
  assert.equal(
    db.calls.filter((c) => c.root === "delete").length,
    0,
    "không được xoá bản ghi phân bổ cũ",
  );

  const closes = db.writesTo("planning_allocations").filter((c) => c.root === "update");
  assert.equal(closes.length, 3, "mỗi phân bổ cũ phải được đóng đúng 1 lần");

  for (const c of closes) {
    const set = argOf(c, "set") as { allocationEndDate?: string; reallocatedBy?: string; reallocatedAt?: Date };
    assert.equal(set.allocationEndDate, "2026-08-16", "phải ghi ngày kết thúc phân bổ");
    assert.equal(set.reallocatedBy, "recruiter-1", "phải ghi ai là người chuyển");
    assert.ok(set.reallocatedAt instanceof Date, "phải ghi thời điểm chuyển");
  }

  // Mỗi lệnh đóng nhắm đúng một allocation cũ.
  const targeted = closes.map((c) => eqValue(c, "planning_allocations.id"));
  assert.deepEqual(targeted.sort(), ["alloc-1", "alloc-2", "alloc-3"]);
});

test("phân bổ mới trỏ đúng yêu cầu đích và nối chuỗi previous_allocation_id", async () => {
  const allocations = makeAllocations(3, "req-old");
  const { db, mod } = reallocSetup({ allocations });

  await (mod.reallocateDws as (i: unknown) => Promise<ReallocResult>)({
    fromRequestId: "req-old",
    toRequestId: "req-new",
    allocationIds: allocations.map((a) => a.id),
    actor: "recruiter-1",
    scope: null,
    today: "2026-08-16",
  });

  const inserts = db.writesTo("planning_allocations").filter((c) => c.root === "insert");
  assert.equal(inserts.length, 3);

  inserts.forEach((ins, idx) => {
    const v = argOf(ins, "values") as {
      recruitmentRequestId: string;
      employmentSessionId: string;
      previousAllocationId: string;
      allocationStartDate: string;
      allocatedBy: string;
      planningPeriodId: string;
    };
    assert.equal(v.recruitmentRequestId, "req-new", "phân bổ mới phải thuộc yêu cầu đích");
    assert.equal(v.employmentSessionId, `sess-${idx + 1}`, "vẫn là đúng DW đó, phiên làm việc không đổi");
    assert.equal(v.previousAllocationId, `alloc-${idx + 1}`, "phải trỏ ngược về phân bổ cũ");
    assert.equal(v.allocationStartDate, "2026-08-16");
    assert.equal(v.allocatedBy, "recruiter-1");
    assert.equal(v.planningPeriodId, "period-new", "gắn theo kế hoạch của yêu cầu đích");
  });
});

test("chuyển hết DW thì task tái phân bổ tự động DONE", async () => {
  const allocations = makeAllocations(2, "req-old");
  const { db, mod } = reallocSetup({ allocations, remainingAfter: 0 });

  const res = (await (mod.reallocateDws as (i: unknown) => Promise<ReallocResult>)({
    fromRequestId: "req-old",
    toRequestId: "req-new",
    allocationIds: allocations.map((a) => a.id),
    actor: "recruiter-1",
    scope: null,
    today: "2026-08-16",
  })) as ReallocResult;

  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.taskClosed, true);

  const taskUpdate = db.writesTo("planning_tasks").find((c) => c.root === "update") as QueryCall;
  const set = argOf(taskUpdate, "set") as { status: string; resolvedBy: string };
  assert.equal(set.status, "DONE");
  assert.equal(set.resolvedBy, "recruiter-1");
});

test("còn DW chưa chuyển thì task vẫn MỞ", async () => {
  const allocations = makeAllocations(2, "req-old");
  const { db, mod } = reallocSetup({ allocations, remainingAfter: 5 });

  const res = (await (mod.reallocateDws as (i: unknown) => Promise<ReallocResult>)({
    fromRequestId: "req-old",
    toRequestId: "req-new",
    allocationIds: allocations.map((a) => a.id),
    actor: "recruiter-1",
    scope: null,
    today: "2026-08-16",
  })) as ReallocResult;

  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.taskClosed, false);
  assert.equal(db.writesTo("planning_tasks").filter((c) => c.root === "update").length, 0);
});

/* ------------------------------------------------------------
   2B. CAPACITY PREFLIGHT — TẤT CẢ-HOẶC-KHÔNG-GÌ (Phase 3B — F1)
   ------------------------------------------------------------
   planBatchAllocation()/planAllocation() được nạp THẬT (không stub —
   xem load()) nên các test dưới đây chạy trên đúng công thức canonical,
   không phải bản mô phỏng tay.
   ------------------------------------------------------------ */

test("D1 — đích còn ĐÚNG đủ chỉ tiêu cho cả lô: thành công, mọi worker được chuyển", async () => {
  const allocations = makeAllocations(2, "req-old");
  const { db, mod } = reallocSetup({
    allocations,
    toReq: {
      id: "req-new",
      requestCode: "RQ-X",
      status: "PENDING",
      endDate: "2026-12-31",
      departmentId: "dept-A",
      planningPeriodId: "p",
      maleRq: 1,
      femaleRq: 1,
      totalRequest: 2,
    },
    destActiveAllocations: [], // đích đang trống — còn đúng 2 chỗ cho 2 worker
  });

  const res = (await (mod.reallocateDws as (i: unknown) => Promise<ReallocResult>)({
    fromRequestId: "req-old",
    toRequestId: "req-new",
    allocationIds: allocations.map((a) => a.id),
    actor: "recruiter-1",
    scope: null,
    today: "2026-08-16",
  })) as ReallocResult;

  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.moved, 2);
  assert.equal(db.writesTo("planning_allocations").filter((c) => c.root === "insert").length, 2);
});

test("D2 — đích chỉ còn 1 chỗ nhưng chọn 2 worker: 409, ZERO writes (không move 1 người rồi fail người kia)", async () => {
  const allocations = makeAllocations(2, "req-old");
  const { db, mod } = reallocSetup({
    allocations,
    toReq: {
      id: "req-new",
      requestCode: "RQ-X",
      status: "PENDING",
      endDate: "2026-12-31",
      departmentId: "dept-A",
      planningPeriodId: "p",
      maleRq: 1,
      femaleRq: 0,
      totalRequest: 1,
    },
    destActiveAllocations: [], // target=1, current=0 -> còn đúng 1 chỗ, không đủ cho 2
  });

  const res = (await (mod.reallocateDws as (i: unknown) => Promise<ReallocResult>)({
    fromRequestId: "req-old",
    toRequestId: "req-new",
    allocationIds: allocations.map((a) => a.id),
    actor: "recruiter-1",
    scope: null,
    today: "2026-08-16",
  })) as ReallocResult;

  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.status, 409);
  assert.match(res.error, /không còn đủ chỉ tiêu/);
  assert.equal(db.writes.length, 0, "TẤT CẢ-HOẶC-KHÔNG-GÌ: không được move 1 người rồi bỏ dở người còn lại");
});

test("D3 — đích đã full từ trước (current = target): 409, ZERO writes", async () => {
  const allocations = makeAllocations(1, "req-old");
  const { db, mod } = reallocSetup({
    allocations,
    toReq: {
      id: "req-new",
      requestCode: "RQ-X",
      status: "PENDING",
      endDate: "2026-12-31",
      departmentId: "dept-A",
      planningPeriodId: "p",
      maleRq: 1,
      femaleRq: 0,
      totalRequest: 1,
    },
    destActiveAllocations: [
      { id: "existing-1", requestId: "req-new", workerId: "w-other", sessionId: "sess-other", gender: "Nam" },
    ],
  });

  const res = (await (mod.reallocateDws as (i: unknown) => Promise<ReallocResult>)({
    fromRequestId: "req-old",
    toRequestId: "req-new",
    allocationIds: allocations.map((a) => a.id),
    actor: "recruiter-1",
    scope: null,
    today: "2026-08-16",
  })) as ReallocResult;

  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.status, 409);
  assert.equal(db.writes.length, 0);
});

test("D4 — batch có worker TRÙNG với 1 chỗ trống duy nhất: hai independent-check giả định KHÔNG được cùng PASS", async () => {
  // Đích chỉ còn 1 chỗ (target=1, current=0). Batch chọn 3 worker cùng lúc — nếu
  // preflight đọc "current" MỘT LẦN rồi kiểm từng worker độc lập trên snapshot đó
  // (bug được mô tả trong yêu cầu), cả 3 sẽ "current=0 < target=1" và CÙNG PASS.
  // planBatchAllocation() phải gấp (fold) tuần tự và từ chối cả batch.
  const allocations = makeAllocations(3, "req-old");
  const { db, mod } = reallocSetup({
    allocations,
    toReq: {
      id: "req-new",
      requestCode: "RQ-X",
      status: "PENDING",
      endDate: "2026-12-31",
      departmentId: "dept-A",
      planningPeriodId: "p",
      maleRq: 1,
      femaleRq: 0,
      totalRequest: 1,
    },
    destActiveAllocations: [],
  });

  const res = (await (mod.reallocateDws as (i: unknown) => Promise<ReallocResult>)({
    fromRequestId: "req-old",
    toRequestId: "req-new",
    allocationIds: allocations.map((a) => a.id),
    actor: "recruiter-1",
    scope: null,
    today: "2026-08-16",
  })) as ReallocResult;

  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.status, 409);
  assert.equal(db.writes.length, 0, "batch 3 worker vào 1 chỗ trống phải bị từ chối TOÀN BỘ, không phải 1/3");
});

test("worker đã có ACTIVE request_allocations đúng tại đích từ trước (tàn dư desync cũ) -> NOOP hợp lệ, không throw", async () => {
  const allocations = makeAllocations(1, "req-old");
  const { db, mod } = reallocSetup({
    allocations,
    toReq: {
      id: "req-new",
      requestCode: "RQ-X",
      status: "PENDING",
      endDate: "2026-12-31",
      departmentId: "dept-A",
      planningPeriodId: "p",
      maleRq: 5,
      femaleRq: 5,
      totalRequest: 10,
    },
    // worker w-1 (allocations[0]) đã có request_allocations ACTIVE TẠI req-new từ
    // trước — mô phỏng tàn dư desync Planning/Request cũ (chính bug F1 đang sửa).
    destActiveAllocations: [
      { id: "existing-w1", requestId: "req-new", workerId: "w-1", sessionId: "sess-1", gender: "Nam" },
    ],
    syncResult: false, // sync() thật sự trả false cho case NOOP — đây là hành vi ĐÚNG
  });

  const res = (await (mod.reallocateDws as (i: unknown) => Promise<ReallocResult>)({
    fromRequestId: "req-old",
    toRequestId: "req-new",
    allocationIds: allocations.map((a) => a.id),
    actor: "recruiter-1",
    scope: null,
    today: "2026-08-16",
  })) as ReallocResult;

  assert.equal(res.ok, true, "NOOP (đã đúng vị trí) không phải REJECTED — preflight phải phân biệt được hai trường hợp");
});

test("internal consistency guard: preflight PASS nhưng sync() bất ngờ trả REJECTED (không phải NOOP) -> throw, KHÔNG commit trạng thái lệch", async () => {
  const allocations = makeAllocations(1, "req-old");
  const { mod } = reallocSetup({
    allocations,
    toReq: {
      id: "req-new",
      requestCode: "RQ-X",
      status: "PENDING",
      endDate: "2026-12-31",
      departmentId: "dept-A",
      planningPeriodId: "p",
      maleRq: 5,
      femaleRq: 5,
      totalRequest: 10,
    },
    destActiveAllocations: [], // đích trống -> preflight dự đoán ALLOCATE (không phải NOOP)
    syncResult: false, // nhưng sync() (đã stub) lại trả false -> bất nhất nội bộ
  });

  await assert.rejects(
    (mod.reallocateDws as (i: unknown) => Promise<ReallocResult>)({
      fromRequestId: "req-old",
      toRequestId: "req-new",
      allocationIds: allocations.map((a) => a.id),
      actor: "recruiter-1",
      scope: null,
      today: "2026-08-16",
    }),
    /internal consistency error/,
    "sync() trả false sau khi preflight dự đoán ALLOCATE phải throw để rollback, không được commit im lặng",
  );
});

/* ------------------------------------------------------------
   C — LỊCH SỬ RQ09 KHÔNG BỊ ẢNH HƯỞNG BỞI REALLOCATE SAU KHI ĐÓNG
   ------------------------------------------------------------
   Đóng băng lịch sử (resolveDefaultAsOf()/requestWindow()) HOÀN TOÀN
   thuộc về workforce-request.ts và đọc DUY NHẤT recruitment_requests.
   endDate — Phase 3B không chạm file đó. Test này chứng minh CHÍNH XÁC
   điều reallocateDws() có thể (nhưng không được phép) làm sai: ghi đè
   recruitment_requests của yêu cầu NGUỒN. Kết hợp với "Scenario C" đã
   có ở workforce-request-db.test.ts (chứng minh MỘT allocation bị đóng
   SAU asOf đóng băng của request vẫn được tính là Current khi đọc TẠI
   asOf đó — đúng cơ chế mà lệnh ĐÓNG allocation của reallocateDws() tạo
   ra), hai test hợp lại chứng minh đầy đủ: "tái phân bổ sau khi RQ09
   đóng KHÔNG làm hỏng snapshot lịch sử của RQ09".
   ------------------------------------------------------------ */
test("C — reallocateDws() KHÔNG BAO GIỜ ghi vào recruitment_requests (không thể ghi đè endDate/status của RQ nguồn đã đóng)", async () => {
  const allocations = makeAllocations(2, "req-old");
  // RQ09 (nguồn) đã đóng từ trước (endDate quá khứ so với "today" của thao tác).
  const { db, mod } = reallocSetup({
    allocations,
    fromReq: {
      id: "req-old",
      requestCode: "RQ09",
      status: "EXPIRED",
      endDate: "2026-08-01", // đã đóng — đây chính là mốc asOf lịch sử của RQ09
      departmentId: "dept-A",
      planningPeriodId: "period-old",
    },
  });

  const res = (await (mod.reallocateDws as (i: unknown) => Promise<ReallocResult>)({
    fromRequestId: "req-old",
    toRequestId: "req-new",
    allocationIds: allocations.map((a) => a.id),
    actor: "recruiter-1",
    scope: null,
    today: "2026-08-16", // SAU khi RQ09 đã đóng (2026-08-01) — đúng kịch bản "chuyển sau khi đóng"
  })) as ReallocResult;

  assert.equal(res.ok, true);
  // Bằng chứng cấu trúc: KHÔNG có bất kỳ write nào vào recruitment_requests — nghĩa
  // là recruitment_requests.endDate của RQ09 (mốc asOf lịch sử duy nhất mà
  // resolveDefaultAsOf()/requestWindow() đọc) không thể bị thao tác này đổi.
  assert.equal(
    db.writesTo("recruitment_requests").length,
    0,
    "reallocateDws() không được phép ghi recruitment_requests — RQ09 lịch sử phải bất biến",
  );
  // request_allocations của RQ09 chỉ bị ĐÓNG (endedAt = ngày thao tác, SAU asOf đóng
  // băng 2026-08-01) — không XOÁ, không UPDATE tại chỗ requestId của bản ghi cũ.
  const requestAllocInserts = db.writesTo("request_allocations").filter((c) => c.root === "insert");
  const requestAllocUpdates = db.writesTo("request_allocations").filter((c) => c.root === "update");
  assert.equal(db.calls.filter((c) => c.root === "delete" && c.table === "request_allocations").length, 0);
  // (syncRequestAllocationOnPlanningMove là stub no-op ở test file này — hành vi ghi
  // request_allocations thật đã được chứng minh append-only ở workforce-request-db.test.ts;
  // ở đây chỉ xác nhận reallocateDws() KHÔNG tự ý ghi trực tiếp bảng này ngoài qua sync().)
  assert.equal(requestAllocInserts.length, 0, "reallocateDws() không tự ý insert request_allocations ngoài qua sync()");
  assert.equal(requestAllocUpdates.length, 0, "reallocateDws() không tự ý update request_allocations ngoài qua sync()");
});

/* ------------------------------------------------------------
   3. DATA SCOPE & KIỂM TRA ĐẦU VÀO
   ------------------------------------------------------------ */

test("Data Scope chặn ở server: ngoài phạm vi trả 404 và KHÔNG ghi gì", async () => {
  const allocations = makeAllocations(2, "req-old");
  const { db, mod } = reallocSetup({ allocations });

  const res = (await (mod.reallocateDws as (i: unknown) => Promise<ReallocResult>)({
    fromRequestId: "req-old",
    toRequestId: "req-new",
    allocationIds: allocations.map((a) => a.id),
    actor: "dept-manager-1",
    scope: ["dept-Z"], // không chứa dept-A
    today: "2026-08-16",
  })) as ReallocResult;

  assert.equal(res.ok, false);
  if (res.ok) return;
  // 404 chứ không phải 403 — không tiết lộ sự tồn tại của bản ghi ngoài phạm vi.
  assert.equal(res.status, 404);
  assert.equal(db.writes.length, 0, "bị chặn phạm vi thì không được ghi bất cứ thứ gì");
});

test("E2 — yêu cầu ĐÍCH ngoài Data Scope (nguồn trong scope): 404 và KHÔNG ghi gì (Phase 3A audit — re-verify riêng phía đích)", async () => {
  const allocations = makeAllocations(2, "req-old");
  const { db, mod } = reallocSetup({
    allocations,
    // fromReq mặc định departmentId=dept-A (trong scope).
    toReq: {
      id: "req-new",
      requestCode: "RQ-X",
      status: "PENDING",
      endDate: "2026-12-31",
      departmentId: "dept-Z", // KHÔNG trong scope
      planningPeriodId: "p",
      maleRq: 0,
      femaleRq: 0,
      totalRequest: 999,
    },
  });

  const res = (await (mod.reallocateDws as (i: unknown) => Promise<ReallocResult>)({
    fromRequestId: "req-old",
    toRequestId: "req-new",
    allocationIds: allocations.map((a) => a.id),
    actor: "recruiter-1",
    scope: ["dept-A"], // chứa nguồn, KHÔNG chứa đích
    today: "2026-08-16",
  })) as ReallocResult;

  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.status, 404, "không tiết lộ sự tồn tại của yêu cầu đích ngoài scope");
  assert.equal(db.writes.length, 0, "chặn phía đích thì cũng không được ghi bất cứ thứ gì (kể cả phân bổ nguồn)");
});

test("không cho chuyển sang yêu cầu đích đã hết hạn hoặc đã đóng", async () => {
  const allocations = makeAllocations(1, "req-old");

  const expiredTarget = reallocSetup({
    allocations,
    toReq: {
      id: "req-new",
      requestCode: "RQ-X",
      status: "PENDING",
      endDate: "2026-01-01", // đã qua
      departmentId: "dept-A",
      planningPeriodId: "p",
    },
  });
  const r1 = (await (expiredTarget.mod.reallocateDws as (i: unknown) => Promise<ReallocResult>)({
    fromRequestId: "req-old",
    toRequestId: "req-new",
    allocationIds: ["alloc-1"],
    actor: "recruiter-1",
    scope: null,
    today: "2026-08-16",
  })) as ReallocResult;
  assert.equal(r1.ok, false);
  if (!r1.ok) assert.equal(r1.status, 409);
  assert.equal(expiredTarget.db.writes.length, 0);

  const closedTarget = reallocSetup({
    allocations,
    toReq: {
      id: "req-new",
      requestCode: "RQ-X",
      status: "COMPLETED",
      endDate: "2026-12-31",
      departmentId: "dept-A",
      planningPeriodId: "p",
    },
  });
  const r2 = (await (closedTarget.mod.reallocateDws as (i: unknown) => Promise<ReallocResult>)({
    fromRequestId: "req-old",
    toRequestId: "req-new",
    allocationIds: ["alloc-1"],
    actor: "recruiter-1",
    scope: null,
    today: "2026-08-16",
  })) as ReallocResult;
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.equal(r2.status, 409);
  assert.equal(closedTarget.db.writes.length, 0);
});

test("phân bổ đã chuyển trước đó không bị chuyển lần hai", async () => {
  const allocations = makeAllocations(2, "req-old");
  allocations[1].allocationEndDate = "2026-07-01" as unknown as null; // đã đóng
  const { db, mod } = reallocSetup({ allocations });

  const res = (await (mod.reallocateDws as (i: unknown) => Promise<ReallocResult>)({
    fromRequestId: "req-old",
    toRequestId: "req-new",
    allocationIds: ["alloc-1", "alloc-2"],
    actor: "recruiter-1",
    scope: null,
    today: "2026-08-16",
  })) as ReallocResult;

  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.status, 409);
  assert.equal(db.writes.length, 0, "cả lô bị từ chối, không chuyển một phần");
});

test("phân bổ không thuộc yêu cầu nguồn bị từ chối cả lô", async () => {
  const allocations = makeAllocations(2, "req-old");
  allocations[1].recruitmentRequestId = "req-somewhere-else";
  const { db, mod } = reallocSetup({ allocations });

  const res = (await (mod.reallocateDws as (i: unknown) => Promise<ReallocResult>)({
    fromRequestId: "req-old",
    toRequestId: "req-new",
    allocationIds: ["alloc-1", "alloc-2"],
    actor: "recruiter-1",
    scope: null,
    today: "2026-08-16",
  })) as ReallocResult;

  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.status, 409);
  assert.equal(db.writes.length, 0);
});

/* ------------------------------------------------------------
   4. TRUY VẤN THEO DATA SCOPE
   ------------------------------------------------------------ */

test("scope rỗng không thấy task nào và không truy vấn DB", async () => {
  const db = createFakeDb();
  const mod = load(db);

  // Mảng trả về sinh trong realm của vm nên deepEqual tham chiếu sẽ lệch —
  // kiểm tra độ dài là đủ và đúng ý nghĩa.
  const tasks = await (mod.listReallocationTasks as (s: string[] | null) => Promise<unknown[]>)([]);
  assert.equal(tasks.length, 0);

  const targets = await (mod.listReallocationTargets as (s: string[] | null) => Promise<unknown[]>)([]);
  assert.equal(targets.length, 0);

  assert.equal(db.calls.length, 0, "scope rỗng thì chặn sớm, khỏi chạm DB");
});

test("scope giới hạn được áp bằng department_id, không phải tên phòng ban dạng chữ", async () => {
  const db = createFakeDb({ respond: () => [] });
  const mod = load(db);

  await (mod.listReallocationTasks as (s: string[] | null) => Promise<unknown[]>)(["dept-A", "dept-B"]);
  const taskQuery = db.calls.find((c) => c.table === "planning_tasks") as QueryCall;
  assert.deepEqual(inArrayValues(taskQuery, "planning_tasks.departmentId"), ["dept-A", "dept-B"]);

  await (mod.listReallocationTargets as (s: string[] | null) => Promise<unknown[]>)(["dept-A"]);
  const targetQuery = db.calls.find((c) => c.table === "recruitment_requests") as QueryCall;
  assert.deepEqual(inArrayValues(targetQuery, "recruitment_requests.departmentId"), ["dept-A"]);
});

test("chỉ gợi ý yêu cầu đích còn hiệu lực trong cùng phạm vi", async () => {
  const db = createFakeDb({ respond: () => [] });
  const mod = load(db);

  await (mod.listReallocationTargets as (s: string[] | null, o: unknown) => Promise<unknown[]>)(null, {
    excludeRequestId: "req-old",
    today: "2026-08-16",
  });

  const q = db.calls.find((c) => c.table === "recruitment_requests") as QueryCall;
  const texts = sqlTexts(q).join(" | ");
  assert.match(texts, /PENDING/, "chỉ nhận yêu cầu đang mở");
  assert.match(texts, /PROCESSING/);
  assert.match(texts, /is null or/, "phải cho phép yêu cầu chưa đặt End Date");
  assert.ok(
    sqlTexts(q).some((t) => t.includes("<>")),
    "phải loại trừ chính yêu cầu nguồn",
  );
});

/* ------------------------------------------------------------
   TEST A / F (Phase 3B — F2): "còn thiếu X" ở dropdown đích PHẢI lấy
   canonical allocation-scoped KPI (batchComputeRequestKpis), KHÔNG
   lấy cột tĩnh recruitment_requests.totalBalance — kể cả khi 1
   department có nhiều request đang mở cùng lúc (Phase 3A §3 Case A).
   ------------------------------------------------------------ */
test("A/F — RQ09 (target 5/current 5) và RQ10 (target 3/current 2) cùng department: dropdown lấy canonical balance, KHÔNG lấy persisted totalBalance (cố tình set sai)", async () => {
  const rows = [
    {
      id: "rq09",
      requestCode: "RQ-2026-009",
      department: "Farm A",
      departmentId: "dept-A",
      section: null,
      groupName: null,
      expectedDate: "2026-09-10",
      endDate: null,
      status: "PENDING",
      // Persisted legacy — CỐ TÌNH set sai (department-scoped, không phải allocation-scoped).
      totalBalance: 666,
      maleRq: 3,
      femaleRq: 2,
      totalRequest: 5,
      requestedDate: "2026-09-01",
      createdAt: new Date("2026-09-01"),
    },
    {
      id: "rq10",
      requestCode: "RQ-2026-010",
      department: "Farm A",
      departmentId: "dept-A",
      section: null,
      groupName: null,
      expectedDate: "2026-09-12",
      endDate: null,
      status: "PENDING",
      totalBalance: 666, // cũng sai — department-scoped engine trả cùng số cho cả 2 RQ
      maleRq: 2,
      femaleRq: 1,
      totalRequest: 3,
      requestedDate: "2026-09-01",
      createdAt: new Date("2026-09-01"),
    },
  ];
  const db = createFakeDb({
    respond(call) {
      if (call.table === "recruitment_requests") return rows;
      return undefined;
    },
  });
  // Canonical (allocation-scoped): RQ09 balance=0 (target 5, current 5), RQ10 balance=1 (target 3, current 2).
  const requestKpis = new Map([
    ["rq09", { totalBalance: 0 }],
    ["rq10", { totalBalance: 1 }],
  ]);
  const mod = load(db, { requestKpis });

  const targets = (await (mod.listReallocationTargets as (s: string[] | null) => Promise<{ id: string; totalBalance: number }[]>)(
    null,
  )) as { id: string; totalBalance: number }[];

  const rq09 = targets.find((t) => t.id === "rq09");
  const rq10 = targets.find((t) => t.id === "rq10");
  assert.ok(rq09 && rq10, "cả 2 request cùng department phải xuất hiện");
  assert.equal(rq09!.totalBalance, 0, "RQ09 phải dùng canonical (0), KHÔNG phải persisted totalBalance (666)");
  assert.equal(rq10!.totalBalance, 1, "RQ10 phải dùng canonical (1), KHÔNG phải persisted totalBalance (666) — chứng minh KHÔNG dùng department-wide balance chung cho 2 request");
  assert.notEqual(rq09!.totalBalance, 666);
  assert.notEqual(rq10!.totalBalance, 666);
});

test("chỉ lấy phân bổ đang mở của DW còn làm việc", async () => {
  const db = createFakeDb({ respond: () => [] });
  const mod = load(db);

  await (mod.listOpenAllocationsForRequest as (id: string) => Promise<unknown[]>)("req-old");
  const q = db.calls.find((c) => c.table === "planning_allocations") as QueryCall;

  assert.equal(eqValue(q, "planning_allocations.recruitmentRequestId"), "req-old");
  assert.equal(eqValue(q, "employment_sessions.status"), "APPROVED");

  const nullChecks = q.ops
    .flatMap((o) => o.args)
    .flatMap((a) => (a && typeof a === "object" && "parts" in a ? (a as { parts: unknown[] }).parts : [a]))
    .filter((c): c is { op: string; col: string } => !!c && typeof c === "object" && "op" in c)
    .filter((c) => c.op === "isNull")
    .map((c) => c.col);

  assert.ok(nullChecks.includes("planning_allocations.allocationEndDate"), "chỉ phân bổ chưa đóng");
  assert.ok(nullChecks.includes("employment_sessions.endDate"), "chỉ DW chưa kết thúc phiên làm việc");
});

test("đếm nghỉ việc chỉ tính workforce_movements loại RESIGNATION", async () => {
  const db = createFakeDb({
    respond(call) {
      if (call.table === "workforce_movements") return [{ n: 0 }];
      return undefined;
    },
  });
  const mod = load(db);

  const n = await (mod.countResignationsForRequest as (id: string) => Promise<number>)("req-old");
  assert.equal(n, 0);

  const q = db.calls.find((c) => c.table === "workforce_movements") as QueryCall;
  assert.ok(
    sqlTexts(q).some((t) => t.includes("resignation")),
    "chỉ RESIGNATION mới là nghỉ việc thật (Yêu cầu #9)",
  );
});

test("lịch sử phân bổ của một DW trả về đủ chuỗi truy vết", async () => {
  const db = createFakeDb({ respond: () => [] });
  const mod = load(db);

  await (mod.getAllocationHistory as (id: string) => Promise<unknown[]>)("sess-1");
  const q = db.calls.find((c) => c.table === "planning_allocations") as QueryCall;

  const selected = q.ops[0].args[0] as Record<string, unknown>;
  for (const field of [
    "allocationStartDate",
    "allocationEndDate",
    "previousAllocationId",
    "allocatedBy",
    "reallocatedBy",
    "reallocatedAt",
    "requestCode",
  ]) {
    assert.ok(field in selected, `lịch sử phải có trường ${field}`);
  }
  assert.equal(eqValue(q, "planning_allocations.employmentSessionId"), "sess-1");
});

/* ------------------------------------------------------------
   G — RETRY/DOUBLE-CLICK Ở TẦNG STATEFUL (không chỉ fixture tĩnh)
   ------------------------------------------------------------
   Khác với "phân bổ đã chuyển trước đó không bị chuyển lần hai" (đã có,
   fixture khởi tạo SẴN allocationEndDate khác null): test này mô phỏng
   ĐÚNG chuỗi sự kiện thật — gọi reallocateDws() 2 lần với CÙNG allocationIds,
   lần 2 phải thấy trạng thái DO LẦN 1 GHI (stateful), không phải fixture
   tĩnh soạn sẵn.
   ------------------------------------------------------------ */
test("G — double-submit thật sự (2 lần gọi liên tiếp, cùng allocationIds): lần 2 KHÔNG tạo thêm bản ghi", async () => {
  const allocation = makeAllocations(1, "req-old")[0];
  let closedInDb = false; // trạng thái allocationEndDate THẬT SỰ, mutate bởi lần gọi 1

  const fromReq = {
    id: "req-old",
    requestCode: "RQ-2026-001",
    status: "EXPIRED",
    endDate: "2026-08-01",
    departmentId: "dept-A",
    planningPeriodId: "period-old",
  };
  const toReq = {
    id: "req-new",
    requestCode: "RQ-2026-050",
    status: "PENDING",
    endDate: "2026-12-31",
    departmentId: "dept-A",
    planningPeriodId: "period-new",
    maleRq: 0,
    femaleRq: 0,
    totalRequest: 999,
  };

  let reqSelects = 0;
  const writeCounts = { planningInsert: 0, planningUpdate: 0 };
  const db = createFakeDb({
    respond(call) {
      if (call.root === "select" && call.table === "recruitment_requests") {
        reqSelects += 1;
        return reqSelects % 2 === 1 ? [fromReq] : [toReq];
      }
      if (call.root === "select" && call.table === "planning_allocations") {
        if (sqlTexts(call).some((t) => t.includes("count(*)"))) return [{ remaining: closedInDb ? 0 : 1 }];
        // Lần 2: allocationEndDate đã được lần 1 SET (stateful) -> validate loop từ chối.
        return [{ ...allocation, allocationEndDate: closedInDb ? "2026-08-16" : null }];
      }
      if (call.root === "select" && call.table === "request_allocations") return [];
      if (call.root === "insert" && call.table === "planning_allocations") {
        writeCounts.planningInsert += 1;
        closedInDb = true; // lần 1 vừa đóng allocation cũ thật sự
        return [{ id: "new-alloc-1" }];
      }
      if (call.root === "update" && call.table === "planning_allocations") {
        writeCounts.planningUpdate += 1;
      }
      if (call.root === "update" && call.table === "planning_tasks") return { rowCount: 1 };
      return undefined;
    },
  });
  const mod = load(db, { syncResult: true });

  const input = {
    fromRequestId: "req-old",
    toRequestId: "req-new",
    allocationIds: [allocation.id],
    actor: "recruiter-1",
    scope: null,
    today: "2026-08-16",
  };

  const first = (await (mod.reallocateDws as (i: unknown) => Promise<ReallocResult>)(input)) as ReallocResult;
  assert.equal(first.ok, true, "lần 1 phải thành công");

  const second = (await (mod.reallocateDws as (i: unknown) => Promise<ReallocResult>)(input)) as ReallocResult;
  assert.equal(second.ok, false, "lần 2 (double-submit) phải bị từ chối, không tạo bản ghi mới");
  if (!second.ok) assert.equal(second.status, 409);

  assert.equal(writeCounts.planningInsert, 1, "chỉ đúng 1 planning_allocations mới được tạo, không phải 2");
  assert.equal(writeCounts.planningUpdate, 1, "chỉ đúng 1 lệnh đóng allocation cũ, không phải 2");
});

/* Bảo vệ khỏi lỗi chính tả tên bảng trong chính bộ test này. */
test("harness giả lập bám đúng danh sách bảng thật", () => {
  const declared = Object.values(schemaStub).map((t) => (t as { __table: string }).__table);
  assert.deepEqual(declared.slice().sort(), [...TABLES].sort());
});
