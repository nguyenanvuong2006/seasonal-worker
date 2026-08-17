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
      date: string,
      scope: string[] | null,
      filters?: { deptId?: string | null; q?: string | null },
    ) => Promise<Record<string, unknown>[]>;
  };
}

const ROWS = [
  { dailyApplicationId: "app-1", cccd: "010000000001", fullName: "Nguyen Van A", phone: "0901", deptId: "dept-A", startingDate: null, regDate: "2026-08-17", deletedAt: null, dwImportedAt: new Date(), code: "CN-001" },
  { dailyApplicationId: "app-2", cccd: "010000000002", fullName: "Tran Thi B", phone: "0902", deptId: "dept-B", startingDate: null, regDate: "2026-08-17", deletedAt: null, dwImportedAt: new Date(), code: "CN-002" },
  { dailyApplicationId: "app-3", cccd: "010000000003", fullName: "Le Van C", phone: "0903", deptId: "dept-A", startingDate: null, regDate: "2026-08-17", deletedAt: null, dwImportedAt: null, code: null },
];

test("deptId: chỉ trả về lao động thuộc đúng bộ phận được lọc", async () => {
  const { getMealEligibleWorkers } = loadMealList(ROWS);
  const rows = await getMealEligibleWorkers("2026-08-17", null, { deptId: "dept-A" });
  assert.equal(rows.length, 1, "chỉ app-1 vừa thuộc dept-A vừa đủ điều kiện (app-3 cùng dept nhưng chưa nhập DW)");
  assert.equal(rows[0].dailyApplicationId, "app-1");
});

test("q: tìm theo họ tên (không phân biệt hoa/thường)", async () => {
  const { getMealEligibleWorkers } = loadMealList(ROWS);
  const rows = await getMealEligibleWorkers("2026-08-17", null, { q: "tran thi" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dailyApplicationId, "app-2");
});

test("q: tìm theo CCCD", async () => {
  const { getMealEligibleWorkers } = loadMealList(ROWS);
  const rows = await getMealEligibleWorkers("2026-08-17", null, { q: "000002" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dailyApplicationId, "app-2");
});

test("q: tìm theo Mã số công nhật", async () => {
  const { getMealEligibleWorkers } = loadMealList(ROWS);
  const rows = await getMealEligibleWorkers("2026-08-17", null, { q: "cn-001" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dailyApplicationId, "app-1");
});

test("BLOCKER #4: cùng (date, scope, deptId, q) -> list và export nhận CÙNG một tập kết quả", async () => {
  const { getMealEligibleWorkers } = loadMealList(ROWS);
  const listRows = await getMealEligibleWorkers("2026-08-17", ["dept-A", "dept-B"], { deptId: null, q: "a" });
  const exportRows = await getMealEligibleWorkers("2026-08-17", ["dept-A", "dept-B"], { deptId: null, q: "a" });
  const listIds = listRows.map((r) => r.dailyApplicationId).sort();
  const exportIds = exportRows.map((r) => r.dailyApplicationId).sort();
  assert.deepEqual(listIds, exportIds);
  assert.ok(listIds.length > 0);
});
