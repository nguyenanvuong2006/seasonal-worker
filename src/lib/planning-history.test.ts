import test from "node:test";
import assert from "node:assert/strict";
import {
  createFakeDb,
  drizzleStub,
  makeTable,
  argOf,
  condsOf,
  eqValue,
  type FakeDb,
  type QueryCall,
} from "./test-support/fake-drizzle.ts";
import { loadModule, serverOnlyStub } from "./test-support/load-module.ts";

/* ============================================================
   KIỂM THỬ TÍNH "CHỈ THÊM" CỦA LỊCH SỬ PHÂN BỔ (Yêu cầu #4)
   ------------------------------------------------------------
   Chạy trên ĐÚNG src/lib/planning.ts.

   Hai chỗ trước đây phá lịch sử:
     • reviseActivePeriod   : UPDATE planning_period_id của phân bổ cũ
                              → bản kế hoạch cũ mất sạch dấu vết.
     • autoAllocateInternship: DELETE phân bổ cũ trước khi tạo mới.

   Nay cả hai phải ĐÓNG phân bổ cũ (allocation_end_date) rồi MỞ phân
   bổ mới nối qua previous_allocation_id, và TUYỆT ĐỐI không được
   chạm vào employment_sessions / workforce_movements (Yêu cầu #9).
   ============================================================ */

const schemaStub = {
  departments: makeTable("departments"),
  employmentSessions: makeTable("employment_sessions"),
  planningAllocations: makeTable("planning_allocations"),
  planningPeriods: makeTable("planning_periods"),
  planningTargets: makeTable("planning_targets"),
  workerProfiles: makeTable("worker_profiles"),
  workforceMovements: makeTable("workforce_movements"),
};

function load(db: FakeDb) {
  return loadModule(new URL("./planning.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "drizzle-orm": drizzleStub,
      "@/db": { db },
      "@/db/schema": schemaStub,
      "@/lib/helpers": {
        todayStr: () => "2026-08-16",
        isMale: (g: string | null) => String(g ?? "").toUpperCase().startsWith("M"),
        isFemale: (g: string | null) => String(g ?? "").toUpperCase().startsWith("F"),
      },
      "@/lib/person-name": { normalizePersonName: (v: string) => v },
    },
    fallback(spec) {
      throw new Error(`Unexpected require("${spec}")`);
    },
  });
}

function allocWrites(db: FakeDb, root: string): QueryCall[] {
  return db.writesTo("planning_allocations").filter((c) => c.root === root);
}

function setValues(call: QueryCall): Record<string, unknown> {
  return (argOf(call, "set") ?? {}) as Record<string, unknown>;
}

function insertValues(call: QueryCall): Record<string, unknown> {
  return (argOf(call, "values") ?? {}) as Record<string, unknown>;
}

/* ------------------------------------------------------------
   1. reviseActivePeriod — tạo version mới KHÔNG được cướp phân bổ
   ------------------------------------------------------------ */

function reviseDb() {
  let selectIndex = 0;
  return createFakeDb({
    respond(call) {
      if (call.root === "select") {
        selectIndex += 1;
        // 1: kế hoạch cũ (khoá FOR UPDATE)
        if (selectIndex === 1) {
          return [
            {
              id: "period-old",
              status: "ACTIVE",
              startDate: "2026-01-01",
              endDate: "2026-12-31",
              version: 3,
              departmentId: "dept-A",
              section: "S1",
              groupName: "G1",
              location: "Đà Lạt",
              division: "Farm",
              requestType: "ORIGINAL",
              supplementIndex: 0,
              parentPeriodId: null,
            },
          ];
        }
        // 2: target cũ
        if (selectIndex === 2) return [{ demandMale: 5, demandFemale: 5, targetCount: 10, note: "cũ" }];
        // 3: các phân bổ đang mở của bản cũ
        return [
          { id: "alloc-1", employmentSessionId: "sess-1", allocationStartDate: "2026-02-01", recruitmentRequestId: "req-1" },
          { id: "alloc-2", employmentSessionId: "sess-2", allocationStartDate: null, recruitmentRequestId: null },
        ];
      }
      if (call.root === "insert" && call.table === "planning_periods") {
        return [{ id: "period-new", version: 4 }];
      }
      return undefined;
    },
  });
}

test("sửa kế hoạch ACTIVE: phân bổ cũ được ĐÓNG, không bị cướp sang version mới", async () => {
  const db = reviseDb();
  const mod = load(db);
  await (mod.reviseActivePeriod as (a: string, b: unknown, c: string) => Promise<unknown>)(
    "period-old",
    { demandMale: 6 },
    "recruiter1",
  );

  const updates = allocWrites(db, "update");
  assert.equal(updates.length, 2, "mỗi phân bổ đang mở phải được đóng riêng");

  for (const u of updates) {
    const set = setValues(u);
    assert.equal(set.allocationEndDate, "2026-08-16", "phải ghi ngày đóng phân bổ");
    assert.equal(set.reallocatedBy, "recruiter1");
    assert.ok(set.reallocatedAt instanceof Date, "phải ghi mốc thời gian chuyển");
    assert.ok(
      !("planningPeriodId" in set),
      "KHÔNG được UPDATE planning_period_id — làm vậy là xoá lịch sử của bản kế hoạch cũ",
    );
  }
});

test("sửa kế hoạch ACTIVE: phân bổ mới nối chuỗi previous_allocation_id sang version mới", async () => {
  const db = reviseDb();
  const mod = load(db);
  await (mod.reviseActivePeriod as (a: string, b: unknown, c: string) => Promise<unknown>)(
    "period-old",
    {},
    "recruiter1",
  );

  const inserts = allocWrites(db, "insert");
  assert.equal(inserts.length, 2);

  const first = insertValues(inserts[0]);
  assert.equal(first.planningPeriodId, "period-new", "phân bổ mới trỏ tới bản version mới");
  assert.equal(first.previousAllocationId, "alloc-1", "nối được về phân bổ cũ để truy vết");
  assert.equal(first.employmentSessionId, "sess-1");
  assert.equal(first.allocationStartDate, "2026-02-01", "giữ nguyên ngày bắt đầu phân bổ gốc");
  assert.equal(first.recruitmentRequestId, "req-1", "giữ liên kết tới yêu cầu tuyển dụng");

  const second = insertValues(inserts[1]);
  assert.equal(second.previousAllocationId, "alloc-2");
  assert.equal(second.allocationStartDate, "2026-08-16", "thiếu ngày gốc thì lấy hôm nay");
});

test("sửa kế hoạch KHÔNG bao giờ xoá dòng phân bổ và không đụng tới trạng thái làm việc", async () => {
  const db = reviseDb();
  const mod = load(db);
  await (mod.reviseActivePeriod as (a: string, b: unknown, c: string) => Promise<unknown>)(
    "period-old",
    {},
    "recruiter1",
  );

  assert.equal(
    db.writes.filter((c) => c.root === "delete").length,
    0,
    "append-only: không có DELETE nào trong toàn bộ luồng",
  );
  assert.equal(db.writesTo("workforce_movements").length, 0, "đóng phân bổ KHÔNG phải nghỉ việc");
  assert.equal(db.writesTo("employment_sessions").length, 0, "DW vẫn đang làm việc bình thường");
  assert.equal(db.transactions, 1, "toàn bộ thao tác nằm trong MỘT transaction");
});

/* ------------------------------------------------------------
   2. autoAllocateInternship — không DELETE phân bổ cũ nữa
   ------------------------------------------------------------ */

function autoAllocDb(openAllocations: Record<string, unknown>[]) {
  let n = 0;
  return createFakeDb({
    respond(call) {
      if (call.root !== "select") return undefined;
      n += 1;
      // 1: kế hoạch ACTIVE ứng viên
      if (n === 1) {
        return [
          {
            id: "period-A",
            startDate: "2026-01-01",
            endDate: "2026-12-31",
            requestType: "ORIGINAL",
            supplementIndex: 0,
            demandMale: 10,
            demandFemale: 10,
            targetCount: 20,
          },
        ];
      }
      // 2: giới tính của phiên làm việc
      if (n === 2) return [{ workerId: "worker-1", gender: "Nam" }];
      // 3: số đã phân bổ theo kế hoạch
      if (n === 3) return [];
      // 4: phân bổ đang mở của chính phiên này
      return openAllocations;
    },
  });
}

test("phân bổ tự động: phân bổ cũ được đóng chứ KHÔNG bị DELETE", async () => {
  const db = autoAllocDb([
    { id: "alloc-old", planningPeriodId: "period-Z", allocationStartDate: "2026-03-01" },
  ]);
  const mod = load(db);
  const chosen = await (
    mod.autoAllocateInternship as (a: string, b: string, c?: string | null, d?: string) => Promise<string | null>
  )("sess-1", "dept-A", "2026-06-01", "recruiter1");

  assert.equal(chosen, "period-A");
  assert.equal(allocWrites(db, "delete").length, 0, "TUYỆT ĐỐI không DELETE lịch sử phân bổ");

  const [closed] = allocWrites(db, "update");
  assert.ok(closed, "phải có lệnh đóng phân bổ cũ");
  assert.equal(setValues(closed).allocationEndDate, "2026-08-16");
  assert.equal(eqValue(closed, "planning_allocations.id"), "alloc-old");

  const [created] = allocWrites(db, "insert");
  const values = insertValues(created);
  assert.equal(values.planningPeriodId, "period-A");
  assert.equal(values.previousAllocationId, "alloc-old", "chuỗi lịch sử phải nối liền");
  assert.equal(values.allocationStartDate, "2026-06-01", "lấy ngày nhận việc làm ngày bắt đầu phân bổ");
});

test("phân bổ tự động là idempotent: đã ở đúng kế hoạch thì không ghi gì thêm", async () => {
  const db = autoAllocDb([
    { id: "alloc-current", planningPeriodId: "period-A", allocationStartDate: "2026-03-01" },
  ]);
  const mod = load(db);
  const chosen = await (
    mod.autoAllocateInternship as (a: string, b: string, c?: string | null, d?: string) => Promise<string | null>
  )("sess-1", "dept-A", "2026-06-01", "recruiter1");

  assert.equal(chosen, "period-A");
  assert.equal(db.writes.length, 0, "chạy lại không được sinh thêm dòng phân bổ trùng");
});

test("phân bổ tự động: chỉ đếm phân bổ ĐANG MỞ khi tính chỉ tiêu còn trống", async () => {
  const db = autoAllocDb([]);
  const mod = load(db);
  await (
    mod.autoAllocateInternship as (a: string, b: string, c?: string | null, d?: string) => Promise<string | null>
  )("sess-1", "dept-A", null, "recruiter1");

  // Truy vấn đếm phân bổ (select thứ 3) phải loại dòng lịch sử đã đóng.
  const countQuery = db.calls.filter(
    (c) => c.root === "select" && c.table === "planning_allocations",
  )[0];
  assert.ok(countQuery, "phải có truy vấn đếm phân bổ");
  const nulls = condsOf(countQuery).filter(
    (c) => c.op === "isNull" && (c as { col: string }).col === "planning_allocations.allocationEndDate",
  );
  assert.equal(nulls.length, 1, "phải lọc allocation_end_date IS NULL để không đếm trùng lịch sử");
});

/* ------------------------------------------------------------
   3. Chỉ số kế hoạch cũng chỉ tính phân bổ đang mở
   ------------------------------------------------------------ */

test("chỉ số kế hoạch bỏ qua dòng phân bổ đã đóng, nên không đếm một DW hai lần", async () => {
  const db = createFakeDb({ respond: () => [] });
  const mod = load(db);
  await (mod.batchComputePlanningMetrics as (ids: string[]) => Promise<unknown>)(["period-A"]);

  const allocQueries = db.calls.filter(
    (c) => c.root === "select" && c.table === "planning_allocations",
  );
  assert.ok(allocQueries.length >= 2, "phải có truy vấn đếm phân bổ và truy vấn đếm nghỉ việc");

  for (const q of allocQueries) {
    const hasOpenFilter = condsOf(q).some(
      (c) => c.op === "isNull" && (c as { col: string }).col === "planning_allocations.allocationEndDate",
    );
    assert.ok(hasOpenFilter, "mọi truy vấn thống kê phải giới hạn ở phân bổ đang mở");
  }
});
