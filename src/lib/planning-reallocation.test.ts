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
  "worker_profiles",
  "workforce_movements",
] as const;

const schemaStub = {
  departments: makeTable("departments"),
  employmentSessions: makeTable("employment_sessions"),
  planningAllocations: makeTable("planning_allocations"),
  planningTasks: makeTable("planning_tasks"),
  recruitmentRequests: makeTable("recruitment_requests"),
  workerProfiles: makeTable("worker_profiles"),
  workforceMovements: makeTable("workforce_movements"),
};

function load(db: FakeDb) {
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
      // WORKFORCE REQUEST LINKAGE — reallocateDws đồng bộ sang request_allocations
      // (worker-level source of truth). Stub no-op để sandbox không cần nạp toàn bộ
      // module DB; logic thuần của bộ máy phân bổ đã có test riêng ở
      // workforce-request.test.ts.
      "@/lib/workforce-request": { syncRequestAllocationOnPlanningMove: async () => false },
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

function reallocSetup(opts: {
  allocations: ReturnType<typeof makeAllocations>;
  fromReq?: Record<string, unknown> | undefined;
  toReq?: Record<string, unknown> | undefined;
  remainingAfter?: number;
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
        }
      : opts.toReq;

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
      if (call.root === "insert" && call.table === "planning_allocations") {
        newAllocSeq += 1;
        return [{ id: `new-alloc-${newAllocSeq}` }];
      }
      if (call.root === "update" && call.table === "planning_tasks") return { rowCount: 1 };
      return undefined;
    },
  });

  return { db, mod: load(db) };
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

/* Bảo vệ khỏi lỗi chính tả tên bảng trong chính bộ test này. */
test("harness giả lập bám đúng danh sách bảng thật", () => {
  const declared = Object.values(schemaStub).map((t) => (t as { __table: string }).__table);
  assert.deepEqual(declared.slice().sort(), [...TABLES].sort());
});
