import test from "node:test";
import assert from "node:assert/strict";
import {
  createFakeDb,
  drizzleStub,
  makeTable,
  argOf,
  condsOf,
  inArrayValues,
  sqlTexts,
  type FakeDb,
  type QueryCall,
} from "./test-support/fake-drizzle.ts";
import { loadModule, serverOnlyStub } from "./test-support/load-module.ts";

/* ============================================================
   KIỂM THỬ TẦNG DB — DANH SÁCH, LỌC, SẮP XẾP, IMPORT
   ------------------------------------------------------------
   Chạy trên ĐÚNG src/lib/recruitment-request.ts.

   Bao phủ:
     • Sắp xếp mặc định theo Expected Date, quá hạn lên đầu  (Yêu cầu #5)
     • Data Scope lọc theo department_id                      (Yêu cầu #15)
     • Import 100 dòng, trùng Request Code, transaction       (Yêu cầu #11, #17)
     • KPI hệ thống không bị Excel ghi đè                     (Yêu cầu #10)
   ============================================================ */

const schemaStub = {
  departments: makeTable("departments"),
  recruitmentRequests: makeTable("recruitment_requests"),
  planningPeriods: makeTable("planning_periods"),
  planningTargets: makeTable("planning_targets"),
  planningAllocations: makeTable("planning_allocations"),
  employmentSessions: makeTable("employment_sessions"),
  workerProfiles: makeTable("worker_profiles"),
  workforceMovements: makeTable("workforce_movements"),
};

function load(db: FakeDb) {
  const utils = loadModule(new URL("./recruitment-request-utils.ts", import.meta.url), { stubs: {} });
  const core = loadModule(new URL("./planning-recruitment-core.ts", import.meta.url), {
    stubs: {
      "./recruitment-request-columns.ts": loadModule(
        new URL("./recruitment-request-columns.ts", import.meta.url),
        { stubs: {} },
      ),
    },
  });
  return loadModule(new URL("./recruitment-request.ts", import.meta.url), {
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
      "@/lib/planning-recruitment-core": core,
      "@/lib/recruitment-request-utils": utils,
    },
    fallback(spec) {
      if (spec.includes("recruitment-request-utils")) return utils;
      throw new Error(`Unexpected require("${spec}")`);
    },
  });
}

/** Truy vấn danh sách chính (select trên recruitment_requests có orderBy). */
function listQuery(db: FakeDb): QueryCall {
  const q = db.calls.find(
    (c) => c.root === "select" && c.table === "recruitment_requests" && c.ops.some((o) => o.fn === "orderBy"),
  );
  assert.ok(q, "phải có truy vấn danh sách có orderBy");
  return q;
}

function orderByArgs(q: QueryCall): unknown[] {
  return q.ops.find((o) => o.fn === "orderBy")?.args ?? [];
}

/* ------------------------------------------------------------
   1. SẮP XẾP MẶC ĐỊNH (Yêu cầu #5)
   ------------------------------------------------------------ */

test("mặc định sắp xếp theo Expected Date gần → xa, KHÔNG theo ngày tạo", async () => {
  const db = createFakeDb({ respond: () => [] });
  const mod = load(db);

  await (mod.listRecruitmentRequests as (f: unknown) => Promise<unknown>)({});

  const args = orderByArgs(listQuery(db));
  assert.ok(args.length >= 2, "phải sắp xếp nhiều tầng");

  const first = args[0] as { op: string; text: string };
  assert.equal(first.op, "sql", "khoá đầu tiên là nhóm ưu tiên dạng CASE");
  const caseText = first.text.toLowerCase();
  assert.match(caseText, /case/);
  assert.match(caseText, /current_date/, "quá hạn được tính theo ngày hiện tại");
  assert.match(caseText, /coalesce/, "chỉ nhóm quá hạn khi còn thiếu người");
  assert.match(caseText, /not in \('completed', 'cancelled'\)/);

  const second = args[1] as { op: string; text: string };
  assert.match(second.text.toLowerCase(), /asc nulls last/, "trong nhóm: ngày cần nhân lực gần nhất trước");

  // KHÔNG được rơi về created_at như bản cũ.
  const allText = JSON.stringify(args).toLowerCase();
  assert.ok(!allText.includes("createdat"), "sắp xếp mặc định không được dựa vào createdAt");
});

test("nhóm ưu tiên khớp đúng thứ tự: quá hạn-chưa đủ (0) → sắp tới (1) → chưa có ngày (2)", async () => {
  const db = createFakeDb({ respond: () => [] });
  const mod = load(db);
  await (mod.listRecruitmentRequests as (f: unknown) => Promise<unknown>)({});

  const caseText = (orderByArgs(listQuery(db))[0] as { text: string }).text.replace(/\s+/g, " ").toLowerCase();
  const posOverdue = caseText.indexOf("then 0");
  const posNull = caseText.indexOf("then 2");
  const posElse = caseText.indexOf("else 1");

  assert.ok(posNull > -1 && posOverdue > -1 && posElse > -1, "phải có đủ 3 nhóm");
  // Yêu cầu chưa có ngày cần nhân lực bị đẩy xuống cuối cùng.
  assert.ok(posNull < posOverdue, "nhánh NULL kiểm tra trước để không lọt vào nhóm quá hạn");
});

test("người dùng đổi được sắp xếp, mặc định chỉ là mặc định", async () => {
  for (const [sortBy, expectCol] of [
    ["requestCode", "requestCode"],
    ["requestedDate", "requestedDate"],
    ["totalBalance", "totalBalance"],
  ] as const) {
    const db = createFakeDb({ respond: () => [] });
    const mod = load(db);
    await (mod.listRecruitmentRequests as (f: unknown) => Promise<unknown>)({ sortBy, sortDir: "desc" });

    const first = orderByArgs(listQuery(db))[0] as { op: string; inner: { __prop: string } };
    assert.equal(first.op, "desc", `${sortBy} phải theo chiều giảm dần khi yêu cầu`);
    assert.equal(first.inner.__prop, expectCol);
  }
});

test("sắp xếp theo Expected Date luôn đẩy ô trống xuống cuối", async () => {
  const db = createFakeDb({ respond: () => [] });
  const mod = load(db);
  await (mod.listRecruitmentRequests as (f: unknown) => Promise<unknown>)({
    sortBy: "expectedDate",
    sortDir: "asc",
  });

  const args = orderByArgs(listQuery(db));
  assert.match((args[0] as { text: string }).text.toLowerCase(), /is null/, "khoá phụ NULLS LAST");
  assert.equal((args[1] as { op: string }).op, "asc");
});

/* ------------------------------------------------------------
   2. DATA SCOPE (Yêu cầu #15)
   ------------------------------------------------------------ */

test("Data Scope lọc theo department_id (FK), không phải cột chữ department", async () => {
  const db = createFakeDb({ respond: () => [] });
  const mod = load(db);

  await (mod.listRecruitmentRequests as (f: unknown) => Promise<unknown>)({ scope: ["dept-A", "dept-B"] });

  const q = listQuery(db);
  assert.deepEqual(
    inArrayValues(q, "recruitment_requests.departmentId"),
    ["dept-A", "dept-B"],
    "phải so khớp bằng khoá ngoại department_id",
  );
  assert.equal(
    inArrayValues(q, "recruitment_requests.department"),
    undefined,
    "KHÔNG được so UUID với cột tên phòng ban dạng chữ",
  );
});

test("scope rỗng không thấy dữ liệu nào", async () => {
  const db = createFakeDb({ respond: () => [] });
  const mod = load(db);

  const res = (await (mod.listRecruitmentRequests as (f: unknown) => Promise<{ rows: unknown[]; total: number }>)({
    scope: [],
  })) as { rows: unknown[]; total: number };

  assert.equal(res.rows.length, 0);
  assert.equal(res.total, 0);
});

test("thống kê cũng bị giới hạn bởi Data Scope", async () => {
  const db = createFakeDb({ respond: () => [] });
  const mod = load(db);

  await (mod.getRecruitmentStats as (s: string[] | null) => Promise<unknown>)(["dept-A"]);

  const statQuery = db.calls.find((c) => c.table === "recruitment_requests") as QueryCall;
  assert.deepEqual(inArrayValues(statQuery, "recruitment_requests.departmentId"), ["dept-A"]);
});

/* ------------------------------------------------------------
   3. BỘ LỌC (Yêu cầu #12)
   ------------------------------------------------------------ */

test("lọc được theo lý do, khoảng ngày và tình trạng tuyển đủ", async () => {
  const db = createFakeDb({ respond: () => [] });
  const mod = load(db);

  await (mod.listRecruitmentRequests as (f: unknown) => Promise<unknown>)({
    reason: "Thay thế",
    requestedFrom: "2026-01-01",
    requestedTo: "2026-06-30",
    expectedFrom: "2026-02-01",
    expectedTo: "2026-12-31",
    fulfillment: "UNFILLED",
  });

  const conds = condsOf(listQuery(db));
  const find = (op: string, col: string) => conds.find((c) => c.op === op && "col" in c && c.col === col);

  assert.ok(find("eq", "recruitment_requests.reason"), "lọc theo Reason");
  assert.ok(find("gte", "recruitment_requests.requestedDate"), "lọc từ ngày yêu cầu");
  assert.ok(find("lte", "recruitment_requests.requestedDate"), "lọc đến ngày yêu cầu");
  assert.ok(find("gte", "recruitment_requests.expectedDate"), "lọc từ ngày cần nhân lực");
  assert.ok(find("lte", "recruitment_requests.expectedDate"), "lọc đến ngày cần nhân lực");

  const texts = sqlTexts(listQuery(db)).join(" | ").toLowerCase();
  assert.match(texts, /coalesce/, "tình trạng tuyển đủ tính trên total_balance");
});

test("UNFILLED và FILLED là hai điều kiện ngược nhau trên Total Balance", async () => {
  const unfilled = createFakeDb({ respond: () => [] });
  await (load(unfilled).listRecruitmentRequests as (f: unknown) => Promise<unknown>)({ fulfillment: "UNFILLED" });
  const filled = createFakeDb({ respond: () => [] });
  await (load(filled).listRecruitmentRequests as (f: unknown) => Promise<unknown>)({ fulfillment: "FILLED" });

  const u = sqlTexts(listQuery(unfilled)).join(" ");
  const f = sqlTexts(listQuery(filled)).join(" ");

  assert.ok(u.includes("> 0"), "chưa tuyển đủ: còn thiếu người");
  assert.ok(f.includes("= 0"), "đã tuyển đủ: không còn thiếu");
  assert.notEqual(u, f);
});

/* ------------------------------------------------------------
   4. IMPORT (Yêu cầu #10, #11, #17)
   ------------------------------------------------------------ */

function importSetup(existingCodes: Set<string>) {
  let inserted = 0;
  const db = createFakeDb({
    respond(call) {
      if (call.root === "select" && call.table === "recruitment_requests") {
        const code = condsOf(call).find((c) => c.op === "eq" && "col" in c && c.col === "recruitment_requests.requestCode");
        const val = code && "val" in code ? String(code.val) : "";
        return existingCodes.has(val) ? [{ id: `existing-${val}` }] : [];
      }
      if (call.root === "select" && call.table === "departments") return [{ id: "dept-A" }];
      if (call.root === "insert") {
        inserted += 1;
        return [{ id: `new-${inserted}` }];
      }
      return undefined;
    },
  });
  return { db, mod: load(db) };
}

function makeRows(n: number, prefix = "RQ-2026-") {
  return Array.from({ length: n }, (_, i) => ({
    "Request Code": `${prefix}${String(i + 1).padStart(3, "0")}`,
    Requester: `Nguyễn Văn ${i + 1}`,
    Department: "Farm A",
    Location: "Đà Lạt",
    Division: "Production",
    "Male Rq": "3",
    "Female Rq": "2",
    "Requested Date": "01/02/2026",
    "Expected Date": "15/03/2026",
    Status: "PENDING",
  }));
}

type ImportResult = { rowIndex: number; status: string; requestCode: string; message?: string };

test("dán 100 dòng từ Excel: tạo đủ 100 yêu cầu trong MỘT transaction", async () => {
  const { db, mod } = importSetup(new Set());
  const rows = makeRows(100);

  const results = (await (mod.importRecruitmentRequests as (
    r: unknown[],
    by: string,
    o?: unknown,
  ) => Promise<ImportResult[]>)(rows, "recruiter-1")) as ImportResult[];

  assert.equal(results.length, 100);
  assert.equal(results.filter((r) => r.status === "INSERTED").length, 100);
  assert.equal(results.filter((r) => r.status === "ERROR").length, 0);

  const inserts = db.writesTo("recruitment_requests").filter((c) => c.root === "insert");
  assert.equal(inserts.length, 100, "mỗi dòng hợp lệ tạo đúng 1 bản ghi");
  assert.equal(db.transactions, 1, "cả lô nằm trong một transaction duy nhất");
});

test("trùng Request Code: cập nhật thay vì tạo bản ghi thứ hai", async () => {
  const { db, mod } = importSetup(new Set(["RQ-2026-001", "RQ-2026-002"]));
  const rows = makeRows(5);

  const results = (await (mod.importRecruitmentRequests as (
    r: unknown[],
    by: string,
    o?: unknown,
  ) => Promise<ImportResult[]>)(rows, "recruiter-1", { updateDuplicates: true })) as ImportResult[];

  const inserts = db.writesTo("recruitment_requests").filter((c) => c.root === "insert");
  const updates = db.writesTo("recruitment_requests").filter((c) => c.root === "update");

  assert.equal(inserts.length, 3, "chỉ 3 mã mới được tạo");
  assert.equal(updates.length, 2, "2 mã đã tồn tại được cập nhật");
  assert.equal(results.length, 5);
  // Không bao giờ có bản ghi trùng mã.
  assert.equal(inserts.length + updates.length, 5);
});

test("trùng Request Code với chế độ bỏ qua: không ghi đè dữ liệu cũ", async () => {
  const { db, mod } = importSetup(new Set(["RQ-2026-001", "RQ-2026-002"]));
  const rows = makeRows(5);

  const results = (await (mod.importRecruitmentRequests as (
    r: unknown[],
    by: string,
    o?: unknown,
  ) => Promise<ImportResult[]>)(rows, "recruiter-1", { skipDuplicates: true })) as ImportResult[];

  assert.equal(results.filter((r) => r.status === "SKIPPED").length, 2);
  assert.equal(db.writesTo("recruitment_requests").filter((c) => c.root === "update").length, 0);
  assert.equal(db.writesTo("recruitment_requests").filter((c) => c.root === "insert").length, 3);
});

test("chạy lại cùng một file không sinh bản ghi trùng (idempotent)", async () => {
  const codes = new Set<string>();
  const { db, mod } = importSetup(codes);
  const rows = makeRows(10);

  await (mod.importRecruitmentRequests as (r: unknown[], by: string) => Promise<ImportResult[]>)(rows, "recruiter-1");
  const firstInserts = db.writesTo("recruitment_requests").filter((c) => c.root === "insert").length;
  assert.equal(firstInserts, 10);

  // Lần chạy thứ hai: các mã đã nằm trong DB.
  for (const r of rows) codes.add(r["Request Code"]);
  const second = importSetup(codes);
  await (second.mod.importRecruitmentRequests as (r: unknown[], by: string) => Promise<ImportResult[]>)(
    rows,
    "recruiter-1",
  );

  assert.equal(
    second.db.writesTo("recruitment_requests").filter((c) => c.root === "insert").length,
    0,
    "lần hai không tạo thêm bản ghi nào",
  );
});

test("mã lặp trong CHÍNH file chỉ nhận dòng đầu tiên", async () => {
  const { db, mod } = importSetup(new Set());
  const rows = [...makeRows(3), ...makeRows(3)]; // 3 mã, mỗi mã 2 lần

  const results = (await (mod.importRecruitmentRequests as (
    r: unknown[],
    by: string,
  ) => Promise<ImportResult[]>)(rows, "recruiter-1")) as ImportResult[];

  assert.equal(db.writesTo("recruitment_requests").filter((c) => c.root === "insert").length, 3);
  assert.equal(results.filter((r) => r.status === "SKIPPED").length, 3);
});

test("Excel KHÔNG ghi đè KPI hệ thống: Balance và Total Request luôn được tính lại", async () => {
  const { db, mod } = importSetup(new Set());
  const rows = [
    {
      "Request Code": "RQ-KPI-001",
      Requester: "Trần Thị B",
      Department: "Farm A",
      "Male Rq": "10",
      "Female Rq": "5",
      "Male Recruited": "4",
      "Female Recruited": "1",
      "Male Quit": "1",
      "Female Quit": "0",
      // Các con số bịa đặt trong file — PHẢI bị bỏ qua.
      "Total Request": "999",
      "Male Balance": "888",
      "Female Balance": "777",
      "Total Balance": "666",
      "Recruited vs Expected": "555",
    },
  ];

  await (mod.importRecruitmentRequests as (r: unknown[], by: string) => Promise<ImportResult[]>)(rows, "recruiter-1");

  const ins = db.writesTo("recruitment_requests").find((c) => c.root === "insert") as QueryCall;
  const v = argOf(ins, "values") as Record<string, number>;

  // Total Request = Male Rq + Female Rq = 15, không phải 999.
  assert.equal(v.totalRequest, 15);
  // Balance = Rq - Recruited + Quit
  assert.equal(v.maleBalance, 10 - 4 + 1);
  assert.equal(v.femaleBalance, 5 - 1 + 0);
  assert.equal(v.totalBalance, 7 + 4);
  assert.notEqual(v.totalBalance, 666);
  assert.notEqual(v.recruitedVsExpected, 555);
});

test("import ghi department_id để Data Scope hoạt động, đồng thời giữ 6 trường ngày tách biệt", async () => {
  const { db, mod } = importSetup(new Set());
  const rows = [
    {
      "Request Code": "RQ-DATE-001",
      Requester: "Lê C",
      Location: "Đà Lạt",
      Division: "Production",
      Department: "Farm A",
      Section: "Sec 1",
      Group: "Grp 1",
      "Requested Date": "01/02/2026",
      "Expected Date": "15/03/2026",
      "Starting Date": "20/03/2026",
      "End Date": "30/06/2026",
      "Offered Date": "10/03/2026",
      "Completed Date": "18/03/2026",
    },
  ];

  await (mod.importRecruitmentRequests as (r: unknown[], by: string) => Promise<ImportResult[]>)(rows, "recruiter-1");

  const ins = db.writesTo("recruitment_requests").find((c) => c.root === "insert") as QueryCall;
  const v = argOf(ins, "values") as Record<string, unknown>;

  assert.equal(v.departmentId, "dept-A", "phải phân giải tên phòng ban thành khoá ngoại");

  // Sáu trường ngày ĐỘC LẬP, không dùng chung một cột (Yêu cầu #6).
  assert.equal(v.requestedDate, "2026-02-01");
  assert.equal(v.expectedDate, "2026-03-15");
  assert.equal(v.startingDate, "2026-03-20");
  assert.equal(v.endDate, "2026-06-30");
  assert.equal(v.offeredDate, "2026-03-10");
  assert.equal(v.completedDate, "2026-03-18");

  const distinct = new Set([v.requestedDate, v.expectedDate, v.startingDate, v.endDate, v.offeredDate, v.completedDate]);
  assert.equal(distinct.size, 6, "sáu ngày phải được lưu riêng biệt");
});

test("dòng thiếu Request Code bị báo lỗi nhưng không làm hỏng cả lô", async () => {
  const { db, mod } = importSetup(new Set());
  const rows = [...makeRows(2), { "Request Code": "  ", Requester: "X", Department: "Farm A" }, ...makeRows(1, "RQ-B-")];

  const results = (await (mod.importRecruitmentRequests as (
    r: unknown[],
    by: string,
  ) => Promise<ImportResult[]>)(rows, "recruiter-1")) as ImportResult[];

  assert.equal(results.filter((r) => r.status === "ERROR").length, 1);
  assert.equal(db.writesTo("recruitment_requests").filter((c) => c.root === "insert").length, 3);
});

test("xoá yêu cầu là xoá mềm — lịch sử không bao giờ bị DELETE", async () => {
  const db = createFakeDb({ respond: () => ({ rowCount: 2 }) });
  const mod = load(db);

  await (mod.softDeleteRecruitmentRequests as (ids: string[], by: string) => Promise<unknown>)(
    ["r1", "r2"],
    "admin-1",
  );

  assert.equal(db.calls.filter((c) => c.root === "delete").length, 0, "không được dùng DELETE");
  const upd = db.writesTo("recruitment_requests").find((c) => c.root === "update") as QueryCall;
  const set = argOf(upd, "set") as { deletedAt?: unknown };
  assert.ok(set.deletedAt, "chỉ đánh dấu deleted_at");
});
