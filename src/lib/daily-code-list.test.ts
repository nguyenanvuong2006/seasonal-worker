import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

/* ============================================================
   KIỂM THỬ src/lib/daily-code-list.ts — NGUỒN DÙNG CHUNG CHO
   GET /api/administration/daily-code VÀ GET /api/administration/daily-code/export.
   ------------------------------------------------------------
   Theo đúng mẫu src/lib/meal-list.test.ts — bao phủ:
     • Lọc theo deptId (Data Scope áp dụng ở route, hàm này chỉ cần lọc
       đúng deptId được truyền vào).
     • Lọc theo q (tìm theo họ tên / CCCD / Mã số công nhật).
     • Lọc theo status (ALL mặc định | MISSING | DONE).
     • Cùng tham số (date, scope, deptId, q, status) -> CÙNG một tập kết
       quả, dù được gọi từ ngữ cảnh "danh sách" hay "xuất file".
   ============================================================ */

function evalCond(row: Record<string, unknown>, cond: { op: string; c?: unknown[]; col?: { __col: string }; v?: unknown } | null): boolean {
  if (!cond) return true;
  if (cond.op === "and") return (cond.c as typeof cond[]).every((c) => evalCond(row, c));
  if (cond.op === "eq") return row[cond.col!.__col] === cond.v;
  if (cond.op === "gte") return (row[cond.col!.__col] as string) >= (cond.v as string);
  if (cond.op === "lte") return (row[cond.col!.__col] as string) <= (cond.v as string);
  if (cond.op === "inArray") return (cond.v as unknown[]).includes(row[cond.col!.__col]);
  if (cond.op === "isNull") return row[cond.col!.__col] == null;
  if (cond.op === "isNotNull") return row[cond.col!.__col] != null;
  return true;
}

function makeChain(rows: Record<string, unknown>[]) {
  let cond: Parameters<typeof evalCond>[1] = null;
  const chain: Record<string, unknown> = {
    innerJoin: () => chain,
    leftJoin: () => chain,
    where: (c: typeof cond) => {
      cond = c;
      return chain;
    },
    orderBy: () => chain,
    then: (resolve: (v: unknown) => void) => resolve(rows.filter((r) => evalCond(r, cond))),
  };
  return chain;
}

function loadDailyCodeList(rows: Record<string, unknown>[]) {
  const url = new URL("./daily-code-list.ts", import.meta.url);
  const source = readFileSync(url, "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;

  const dbStub = {
    select: () => ({
      from: () => makeChain(rows),
    }),
  };

  const col = (name: string) => ({ __col: name });
  const schemaStub = {
    dailyApplications: {
      __table: "daily_applications",
      id: col("dailyApplicationId"),
      cccd: col("cccd"),
      fullName: col("fullName"),
      deptId: col("deptId"),
      startingDate: col("startingDate"),
      regDate: col("regDate"),
      deletedAt: col("deletedAt"),
      dwImportedAt: col("dwImportedAt"),
      dwId: col("dwId"),
    },
    dwData: { __table: "dw_data", id: col("dwDataId"), code: col("code") },
    departments: { __table: "departments", deptName: col("deptName"), groupName: col("groupName"), id: col("deptTableId") },
  };

  const stubs: Record<string, unknown> = {
    "server-only": {},
    "drizzle-orm": {
      and: (...c: unknown[]) => ({ op: "and", c }),
      desc: (col: unknown) => ({ op: "desc", col }),
      eq: (col: unknown, v: unknown) => ({ op: "eq", col, v }),
      gte: (col: unknown, v: unknown) => ({ op: "gte", col, v }),
      lte: (col: unknown, v: unknown) => ({ op: "lte", col, v }),
      inArray: (col: unknown, v: unknown) => ({ op: "inArray", col, v }),
      isNotNull: (col: unknown) => ({ op: "isNotNull", col }),
      isNull: (col: unknown) => ({ op: "isNull", col }),
    },
    "@/db": { db: dbStub },
    "@/db/schema": schemaStub,
  };

  const moduleObj = { exports: {} as Record<string, unknown> };
  const requireShim = (specifier: string): unknown => {
    if (specifier in stubs) return stubs[specifier];
    throw new Error(`Unexpected require("${specifier}")`);
  };
  const context = vm.createContext({
    module: moduleObj,
    exports: moduleObj.exports,
    require: requireShim,
    console,
    process,
    Date,
    Promise,
    JSON,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Set,
    Map,
    Error,
    TypeError,
    RangeError,
    isNaN,
    parseInt,
    parseFloat,
    URL,
  });
  vm.runInContext(js, context);

  return moduleObj.exports as {
    getDailyCodeRows: (
      range: { from: string; to: string },
      scope: string[] | null,
      filters?: { deptId?: string | null; q?: string | null; status?: "ALL" | "MISSING" | "DONE" },
    ) => Promise<Record<string, unknown>[]>;
  };
}

const day = (d: string) => ({ from: d, to: d });

const ROWS = [
  { dailyApplicationId: "app-1", cccd: "010000000001", fullName: "Nguyen Van A", deptId: "dept-A", startingDate: null, regDate: "2026-08-17", deletedAt: null, dwImportedAt: new Date(), code: "CN-001" },
  { dailyApplicationId: "app-2", cccd: "010000000002", fullName: "Tran Thi B", deptId: "dept-B", startingDate: null, regDate: "2026-08-17", deletedAt: null, dwImportedAt: new Date(), code: null },
  { dailyApplicationId: "app-3", cccd: "010000000003", fullName: "Le Van C", deptId: "dept-A", startingDate: null, regDate: "2026-08-17", deletedAt: null, dwImportedAt: null, code: null },
];

test("deptId: chỉ trả về lao động thuộc đúng bộ phận được lọc", async () => {
  const { getDailyCodeRows } = loadDailyCodeList(ROWS);
  const rows = await getDailyCodeRows(day("2026-08-17"), null, { deptId: "dept-A" });
  assert.equal(rows.length, 1, "chỉ app-1 vừa thuộc dept-A vừa đã nhập DW (app-3 cùng dept nhưng chưa nhập DW)");
  assert.equal(rows[0].dailyApplicationId, "app-1");
});

test("q: tìm theo họ tên (không phân biệt hoa/thường)", async () => {
  const { getDailyCodeRows } = loadDailyCodeList(ROWS);
  const rows = await getDailyCodeRows(day("2026-08-17"), null, { q: "tran thi" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dailyApplicationId, "app-2");
});

test("q: tìm theo CCCD", async () => {
  const { getDailyCodeRows } = loadDailyCodeList(ROWS);
  const rows = await getDailyCodeRows(day("2026-08-17"), null, { q: "000002" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dailyApplicationId, "app-2");
});

test("status=MISSING: chỉ trả về hàng chưa có mã số công nhật (trong số đã nhập DW)", async () => {
  const { getDailyCodeRows } = loadDailyCodeList(ROWS);
  const rows = await getDailyCodeRows(day("2026-08-17"), null, { status: "MISSING" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dailyApplicationId, "app-2");
});

test("status=DONE: chỉ trả về hàng đã có mã số công nhật", async () => {
  const { getDailyCodeRows } = loadDailyCodeList(ROWS);
  const rows = await getDailyCodeRows(day("2026-08-17"), null, { status: "DONE" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dailyApplicationId, "app-1");
});

test("status=ALL (mặc định): trả về mọi hàng đã nhập DW, bất kể mã số công nhật", async () => {
  const { getDailyCodeRows } = loadDailyCodeList(ROWS);
  const rows = await getDailyCodeRows(day("2026-08-17"), null);
  assert.equal(rows.length, 2, "app-3 (chưa nhập DW) vẫn bị loại — nhưng app-1 (DONE) và app-2 (MISSING) đều có mặt");
});

test("kết hợp deptId + status: 2 bộ lọc cùng áp dụng, không bộ nào ghi đè bộ kia", async () => {
  const { getDailyCodeRows } = loadDailyCodeList(ROWS);
  const rows = await getDailyCodeRows(day("2026-08-17"), null, { deptId: "dept-B", status: "MISSING" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dailyApplicationId, "app-2");
});

test("list và export nhận CÙNG một tập kết quả với cùng (date, scope, deptId, q, status)", async () => {
  const { getDailyCodeRows } = loadDailyCodeList(ROWS);
  const listRows = await getDailyCodeRows(day("2026-08-17"), ["dept-A", "dept-B"], { status: "ALL", q: "a" });
  const exportRows = await getDailyCodeRows(day("2026-08-17"), ["dept-A", "dept-B"], { status: "ALL", q: "a" });
  const listIds = listRows.map((r) => r.dailyApplicationId).sort();
  const exportIds = exportRows.map((r) => r.dailyApplicationId).sort();
  assert.deepEqual(listIds, exportIds);
  assert.ok(listIds.length > 0);
});

test("scope=[] (không có bộ phận nào) -> zero rows, không cần query", async () => {
  const { getDailyCodeRows } = loadDailyCodeList(ROWS);
  const rows = await getDailyCodeRows(day("2026-08-17"), []);
  assert.equal(rows.length, 0);
});

/* ------------------------------------------------------------
   PHASE 6 — HISTORICAL DATA: ngày được chọn phải thực sự điều khiển
   truy vấn nghiệp vụ (eq(regDate, date)) — đổi ngày KHÔNG được vô tình
   trả về dữ liệu của ngày khác (vd. hôm nay).
   ------------------------------------------------------------ */
test("ngày lịch sử (10/08/2026, khác regDate của mọi hàng) -> zero rows, KHÔNG lẫn dữ liệu ngày khác", async () => {
  const { getDailyCodeRows } = loadDailyCodeList(ROWS);
  const rows = await getDailyCodeRows(day("2026-08-10"), null);
  assert.equal(rows.length, 0, "mọi hàng fixture có regDate=2026-08-17 — đổi ngày phải trả về rỗng, không phải dữ liệu của 2026-08-17");
});

test("đúng ngày regDate (2026-08-17) -> trả về đúng dữ liệu của ngày đó", async () => {
  const { getDailyCodeRows } = loadDailyCodeList(ROWS);
  const rows = await getDailyCodeRows(day("2026-08-17"), null);
  assert.ok(rows.length > 0);
});

/* ------------------------------------------------------------
   GLOBAL DATE RANGE STANDARDIZATION — M1-M3: khoảng nhiều ngày
   (from != to) phải gộp đúng các hàng nằm trong khoảng, loại đúng
   các hàng nằm ngoài khoảng, và biên (from/to) phải bao gồm (inclusive).
   ------------------------------------------------------------ */
const MULTI_DAY_ROWS = [
  { dailyApplicationId: "app-1", cccd: "010000000001", fullName: "Nguyen Van A", deptId: "dept-A", startingDate: null, regDate: "2026-09-01", deletedAt: null, dwImportedAt: new Date(), code: "CN-001" },
  { dailyApplicationId: "app-2", cccd: "010000000002", fullName: "Tran Thi B", deptId: "dept-A", startingDate: null, regDate: "2026-09-05", deletedAt: null, dwImportedAt: new Date(), code: null },
  { dailyApplicationId: "app-3", cccd: "010000000003", fullName: "Le Van C", deptId: "dept-A", startingDate: null, regDate: "2026-09-13", deletedAt: null, dwImportedAt: new Date(), code: "CN-003" },
  { dailyApplicationId: "app-4-outside", cccd: "010000000004", fullName: "Pham Van D", deptId: "dept-A", startingDate: null, regDate: "2026-09-14", deletedAt: null, dwImportedAt: new Date(), code: null },
  { dailyApplicationId: "app-5-outside", cccd: "010000000005", fullName: "Hoang Thi E", deptId: "dept-A", startingDate: null, regDate: "2026-08-31", deletedAt: null, dwImportedAt: new Date(), code: null },
];

test("M1: khoảng nhiều ngày (from=2026-09-01, to=2026-09-13) trả về mọi hàng trong khoảng, loại hàng ngoài khoảng", async () => {
  const { getDailyCodeRows } = loadDailyCodeList(MULTI_DAY_ROWS);
  const rows = await getDailyCodeRows({ from: "2026-09-01", to: "2026-09-13" }, null);
  const ids = rows.map((r) => r.dailyApplicationId).sort();
  assert.deepEqual(ids, ["app-1", "app-2", "app-3"]);
});

test("M1b: biên from/to là inclusive (đúng ngày from và đúng ngày to đều được tính)", async () => {
  const { getDailyCodeRows } = loadDailyCodeList(MULTI_DAY_ROWS);
  const rows = await getDailyCodeRows({ from: "2026-09-01", to: "2026-09-01" }, null);
  assert.deepEqual(rows.map((r) => r.dailyApplicationId), ["app-1"]);
  const rowsTo = await getDailyCodeRows({ from: "2026-09-13", to: "2026-09-13" }, null);
  assert.deepEqual(rowsTo.map((r) => r.dailyApplicationId), ["app-3"]);
});

test("M2: kết hợp khoảng ngày + status=MISSING: cả hai bộ lọc cùng áp dụng", async () => {
  const { getDailyCodeRows } = loadDailyCodeList(MULTI_DAY_ROWS);
  const rows = await getDailyCodeRows({ from: "2026-09-01", to: "2026-09-13" }, null, { status: "MISSING" });
  assert.deepEqual(rows.map((r) => r.dailyApplicationId), ["app-2"]);
});

test("M3: khoảng ngày không chứa hàng nào -> zero rows, không lẫn dữ liệu ngoài khoảng", async () => {
  const { getDailyCodeRows } = loadDailyCodeList(MULTI_DAY_ROWS);
  const rows = await getDailyCodeRows({ from: "2026-09-15", to: "2026-09-20" }, null);
  assert.equal(rows.length, 0);
});

test("list và export nhận CÙNG một tập kết quả với cùng khoảng ngày nhiều ngày", async () => {
  const { getDailyCodeRows } = loadDailyCodeList(MULTI_DAY_ROWS);
  const listRows = await getDailyCodeRows({ from: "2026-09-01", to: "2026-09-13" }, null, { status: "ALL" });
  const exportRows = await getDailyCodeRows({ from: "2026-09-01", to: "2026-09-13" }, null, { status: "ALL" });
  assert.deepEqual(listRows.map((r) => r.dailyApplicationId).sort(), exportRows.map((r) => r.dailyApplicationId).sort());
});
