import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

/* ============================================================
   KIỂM THỬ src/lib/meal-list.ts — NGUỒN DÙNG CHUNG CHO
   GET /api/meal VÀ GET /api/meal/export.
   ------------------------------------------------------------
   Bao phủ (review PR #60 — blocker #4):
     • Lọc theo deptId (Data Scope áp dụng ở route, hàm này chỉ cần lọc
       đúng deptId được truyền vào).
     • Lọc theo q (tìm theo họ tên / Mã số công nhật / CCCD).
     • Cùng tham số (date, scope, deptId, q) -> CÙNG một tập kết quả,
       dù được gọi từ ngữ cảnh "danh sách" hay "xuất file" — vì cả hai
       route đều gọi qua ĐÚNG 1 hàm này (không có 2 nơi lọc khác nhau).
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

function loadMealList(rows: Record<string, unknown>[]) {
  const url = new URL("./meal-list.ts", import.meta.url);
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
      phone: col("phone"),
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
    "@/lib/daily-intake-workflow": {
      isEligibleForMealExport: (app: { dwImportedAt: unknown }, dw: { code: string | null }) =>
        app.dwImportedAt !== null && app.dwImportedAt !== undefined && typeof dw.code === "string" && dw.code.trim().length > 0,
    },
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
    getMealEligibleWorkers: (
      range: { from: string; to: string },
      scope: string[] | null,
      filters?: { deptId?: string | null; q?: string | null; status?: "ALL" | "ELIGIBLE" | "INELIGIBLE" },
    ) => Promise<Record<string, unknown>[]>;
  };
}

const day = (d: string) => ({ from: d, to: d });

const ROWS = [
  { dailyApplicationId: "app-1", cccd: "010000000001", fullName: "Nguyen Van A", phone: "0901", deptId: "dept-A", startingDate: null, regDate: "2026-08-17", deletedAt: null, dwImportedAt: new Date(), code: "CN-001" },
  { dailyApplicationId: "app-2", cccd: "010000000002", fullName: "Tran Thi B", phone: "0902", deptId: "dept-B", startingDate: null, regDate: "2026-08-17", deletedAt: null, dwImportedAt: new Date(), code: "CN-002" },
  { dailyApplicationId: "app-3", cccd: "010000000003", fullName: "Le Van C", phone: "0903", deptId: "dept-A", startingDate: null, regDate: "2026-08-17", deletedAt: null, dwImportedAt: null, code: null },
];

test("deptId: chỉ trả về lao động thuộc đúng bộ phận được lọc", async () => {
  const { getMealEligibleWorkers } = loadMealList(ROWS);
  const rows = await getMealEligibleWorkers(day("2026-08-17"), null, { deptId: "dept-A" });
  assert.equal(rows.length, 1, "chỉ app-1 vừa thuộc dept-A vừa đủ điều kiện (app-3 cùng dept nhưng chưa nhập DW)");
  assert.equal(rows[0].dailyApplicationId, "app-1");
});

test("q: tìm theo họ tên (không phân biệt hoa/thường)", async () => {
  const { getMealEligibleWorkers } = loadMealList(ROWS);
  const rows = await getMealEligibleWorkers(day("2026-08-17"), null, { q: "tran thi" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dailyApplicationId, "app-2");
});

test("q: tìm theo CCCD", async () => {
  const { getMealEligibleWorkers } = loadMealList(ROWS);
  const rows = await getMealEligibleWorkers(day("2026-08-17"), null, { q: "000002" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dailyApplicationId, "app-2");
});

test("q: tìm theo Mã số công nhật", async () => {
  const { getMealEligibleWorkers } = loadMealList(ROWS);
  const rows = await getMealEligibleWorkers(day("2026-08-17"), null, { q: "cn-001" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dailyApplicationId, "app-1");
});

test("BLOCKER #4: cùng (date, scope, deptId, q) -> list và export nhận CÙNG một tập kết quả", async () => {
  const { getMealEligibleWorkers } = loadMealList(ROWS);
  const listRows = await getMealEligibleWorkers(day("2026-08-17"), ["dept-A", "dept-B"], { deptId: null, q: "a" });
  const exportRows = await getMealEligibleWorkers(day("2026-08-17"), ["dept-A", "dept-B"], { deptId: null, q: "a" });
  const listIds = listRows.map((r) => r.dailyApplicationId).sort();
  const exportIds = exportRows.map((r) => r.dailyApplicationId).sort();
  assert.deepEqual(listIds, exportIds);
  assert.ok(listIds.length > 0);
});

test("status mặc định (không truyền) giữ ĐÚNG hành vi cũ: chỉ trả về hàng ĐỦ ĐIỀU KIỆN (ELIGIBLE)", async () => {
  const { getMealEligibleWorkers } = loadMealList(ROWS);
  const rows = await getMealEligibleWorkers(day("2026-08-17"), null);
  assert.equal(rows.length, 2, "app-1 và app-2 đã nhập DW + có Mã số công nhật; app-3 chưa nhập DW nên bị loại");
  assert.deepEqual(rows.map((r) => r.dailyApplicationId).sort(), ["app-1", "app-2"]);
});

test("status=ELIGIBLE: tường minh giống hệt hành vi mặc định", async () => {
  const { getMealEligibleWorkers } = loadMealList(ROWS);
  const rows = await getMealEligibleWorkers(day("2026-08-17"), null, { status: "ELIGIBLE" });
  assert.deepEqual(rows.map((r) => r.dailyApplicationId).sort(), ["app-1", "app-2"]);
});

test("status=INELIGIBLE: chỉ trả về hàng KHÔNG ĐỦ ĐIỀU KIỆN (đã nhập DW nhưng chưa có Mã số công nhật)", async () => {
  const rowsWithIneligible = [
    ...ROWS,
    { dailyApplicationId: "app-4", cccd: "010000000004", fullName: "Pham Van D", phone: "0904", deptId: "dept-A", startingDate: null, regDate: "2026-08-17", deletedAt: null, dwImportedAt: new Date(), code: null },
  ];
  const { getMealEligibleWorkers } = loadMealList(rowsWithIneligible);
  const rows = await getMealEligibleWorkers(day("2026-08-17"), null, { status: "INELIGIBLE" });
  assert.equal(rows.length, 1, "chỉ app-4 (đã nhập DW nhưng chưa có Mã số công nhật) — app-3 chưa nhập DW nên không nằm trong hàng chờ vận hành trong ngày");
  assert.equal(rows[0].dailyApplicationId, "app-4");
});

test("status=ALL: trả về mọi hàng đã nhập DW, bất kể ĐỦ ĐIỀU KIỆN hay không", async () => {
  const { getMealEligibleWorkers } = loadMealList(ROWS);
  const rows = await getMealEligibleWorkers(day("2026-08-17"), null, { status: "ALL" });
  assert.equal(rows.length, 2, "app-3 (chưa nhập DW) vẫn bị loại vì không nằm trong hàng chờ vận hành trong ngày");
});

/* ------------------------------------------------------------
   PHASE 6 — HISTORICAL DATA: ngày được chọn phải thực sự điều khiển
   truy vấn nghiệp vụ (eq(regDate, date)) — đổi ngày KHÔNG được vô tình
   trả về dữ liệu của ngày khác (vd. hôm nay).
   ------------------------------------------------------------ */
test("ngày lịch sử (10/08/2026, khác regDate của mọi hàng) -> zero rows, KHÔNG lẫn dữ liệu ngày khác", async () => {
  const { getMealEligibleWorkers } = loadMealList(ROWS);
  const rows = await getMealEligibleWorkers(day("2026-08-10"), null);
  assert.equal(rows.length, 0, "mọi hàng fixture có regDate=2026-08-17 — đổi ngày phải trả về rỗng, không phải dữ liệu của 2026-08-17");
});

test("đúng ngày regDate (2026-08-17) -> trả về đúng dữ liệu của ngày đó", async () => {
  const { getMealEligibleWorkers } = loadMealList(ROWS);
  const rows = await getMealEligibleWorkers(day("2026-08-17"), null);
  assert.ok(rows.length > 0);
});

test("KPI/list nhất quán: list và export cùng status=INELIGIBLE nhận CÙNG một tập kết quả", async () => {
  const rowsWithIneligible = [
    ...ROWS,
    { dailyApplicationId: "app-4", cccd: "010000000004", fullName: "Pham Van D", phone: "0904", deptId: "dept-A", startingDate: null, regDate: "2026-08-17", deletedAt: null, dwImportedAt: new Date(), code: null },
  ];
  const { getMealEligibleWorkers } = loadMealList(rowsWithIneligible);
  const listRows = await getMealEligibleWorkers(day("2026-08-17"), ["dept-A", "dept-B"], { status: "INELIGIBLE" });
  const exportRows = await getMealEligibleWorkers(day("2026-08-17"), ["dept-A", "dept-B"], { status: "INELIGIBLE" });
  assert.deepEqual(listRows.map((r) => r.dailyApplicationId).sort(), exportRows.map((r) => r.dailyApplicationId).sort());
});

/* ------------------------------------------------------------
   GLOBAL DATE RANGE STANDARDIZATION — B1-B6: khoảng nhiều ngày cho
   Báo cơm. Công thức đủ điều kiện (đã nhập DW VÀ có Mã số công nhật,
   KHÔNG yêu cầu IT CODE) không đổi — khoảng ngày chỉ đổi TẬP hồ sơ
   được xét, không đổi CÔNG THỨC đủ điều kiện.
   ------------------------------------------------------------ */
const MULTI_DAY_ROWS = [
  { dailyApplicationId: "app-1", cccd: "010000000001", fullName: "Nguyen Van A", phone: "0901", deptId: "dept-A", startingDate: null, regDate: "2026-09-01", deletedAt: null, dwImportedAt: new Date(), code: "CN-001" },
  { dailyApplicationId: "app-2", cccd: "010000000002", fullName: "Tran Thi B", phone: "0902", deptId: "dept-A", startingDate: null, regDate: "2026-09-07", deletedAt: null, dwImportedAt: new Date(), code: null },
  { dailyApplicationId: "app-3", cccd: "010000000003", fullName: "Le Van C", phone: "0903", deptId: "dept-A", startingDate: null, regDate: "2026-09-13", deletedAt: null, dwImportedAt: new Date(), code: "CN-003" },
  { dailyApplicationId: "app-4-outside", cccd: "010000000004", fullName: "Pham Van D", phone: "0904", deptId: "dept-A", startingDate: null, regDate: "2026-09-14", deletedAt: null, dwImportedAt: new Date(), code: "CN-004" },
];

test("B1: khoảng nhiều ngày trả về đúng hồ sơ trong khoảng, loại hồ sơ ngoài khoảng", async () => {
  const { getMealEligibleWorkers } = loadMealList(MULTI_DAY_ROWS);
  const rows = await getMealEligibleWorkers({ from: "2026-09-01", to: "2026-09-13" }, null, { status: "ALL" });
  assert.deepEqual(rows.map((r) => r.dailyApplicationId).sort(), ["app-1", "app-2", "app-3"]);
});

test("B2: công thức ĐỦ ĐIỀU KIỆN không đổi khi mở rộng thành khoảng ngày (vẫn cần đã nhập DW + có Mã số công nhật)", async () => {
  const { getMealEligibleWorkers } = loadMealList(MULTI_DAY_ROWS);
  const rows = await getMealEligibleWorkers({ from: "2026-09-01", to: "2026-09-13" }, null, { status: "ELIGIBLE" });
  assert.deepEqual(rows.map((r) => r.dailyApplicationId).sort(), ["app-1", "app-3"], "app-2 chưa có Mã số công nhật nên vẫn không đủ điều kiện, dù nằm trong khoảng");
});

test("B3: IT CODE không nằm trong fixture/công thức — Báo cơm không bị ảnh hưởng bởi IT Code khi mở rộng khoảng ngày", async () => {
  const { getMealEligibleWorkers } = loadMealList(MULTI_DAY_ROWS);
  const rows = await getMealEligibleWorkers({ from: "2026-09-01", to: "2026-09-13" }, null, { status: "ELIGIBLE" });
  for (const r of rows) assert.ok(!("itCode" in r), "MealEligibleRow không có trường itCode — IT Code không liên quan đến Báo cơm");
});

test("B4: đếm đúng TOÀN BỘ khoảng ngày đã chọn, không chỉ 1 ngày trong khoảng", async () => {
  const { getMealEligibleWorkers } = loadMealList(MULTI_DAY_ROWS);
  const rows = await getMealEligibleWorkers({ from: "2026-09-01", to: "2026-09-13" }, null, { status: "ALL" });
  assert.equal(rows.length, 3, "phải đếm đủ cả 3 ngày có hồ sơ trong khoảng, không dừng lại ở ngày đầu/cuối");
});

test("B5: list và export nhận CÙNG một tập kết quả với cùng khoảng ngày nhiều ngày", async () => {
  const { getMealEligibleWorkers } = loadMealList(MULTI_DAY_ROWS);
  const listRows = await getMealEligibleWorkers({ from: "2026-09-01", to: "2026-09-13" }, null, { status: "ALL" });
  const exportRows = await getMealEligibleWorkers({ from: "2026-09-01", to: "2026-09-13" }, null, { status: "ALL" });
  assert.deepEqual(listRows.map((r) => r.dailyApplicationId).sort(), exportRows.map((r) => r.dailyApplicationId).sort());
});

test("B6: mỗi hồ sơ (dailyApplicationId) là 1 đơn vị dedup riêng biệt — không gộp 2 ngày khác nhau của cùng 1 CCCD thành 1", async () => {
  const sameCccdTwoDays = [
    { dailyApplicationId: "app-day1", cccd: "010000000009", fullName: "Vo Thi F", phone: "0909", deptId: "dept-A", startingDate: null, regDate: "2026-09-10", deletedAt: null, dwImportedAt: new Date(), code: "CN-009" },
    { dailyApplicationId: "app-day2", cccd: "010000000009", fullName: "Vo Thi F", phone: "0909", deptId: "dept-A", startingDate: null, regDate: "2026-09-12", deletedAt: null, dwImportedAt: new Date(), code: "CN-009" },
  ];
  const { getMealEligibleWorkers } = loadMealList(sameCccdTwoDays);
  const rows = await getMealEligibleWorkers({ from: "2026-09-01", to: "2026-09-13" }, null, { status: "ELIGIBLE" });
  assert.equal(rows.length, 2, "2 daily_applications rows riêng biệt (2 lượt đăng ký thật trong 2 ngày khác nhau) — dedup key là dailyApplicationId, không phải cccd");
});
