import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

/* ============================================================
   KIỂM THỬ src/lib/fingerprint-it-code-list.ts — NGUỒN DÙNG CHUNG
   CHO GET /api/fingerprint/it-code VÀ GET /api/fingerprint/it-code/export.
   ------------------------------------------------------------
   Theo đúng mẫu src/lib/meal-list.test.ts / daily-code-list.test.ts:
     • Lọc theo deptId (Data Scope áp dụng ở route).
     • Lọc theo q (tìm theo họ tên / CCCD / Mã số công nhật / IT CODE).
     • Lọc theo status (ALL mặc định | MISSING | DONE).
     • Cùng tham số (date, scope, deptId, q, status) -> CÙNG một tập kết
       quả, dù được gọi từ ngữ cảnh "danh sách" hay "xuất file".
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

function loadFingerprintItCodeList(rows: Record<string, unknown>[]) {
  const url = new URL("./fingerprint-it-code-list.ts", import.meta.url);
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
    dwData: { __table: "dw_data", id: col("dwDataId"), code: col("code"), itCode: col("itCode"), itCodeUpdatedAt: col("itCodeUpdatedAt"), itCodeUpdatedBy: col("itCodeUpdatedBy") },
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
      isEligibleForFingerprintQueue: (app: { dwImportedAt: unknown }, dw: { code: string | null }) =>
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
    getFingerprintItCodeRows: (
      date: string,
      scope: string[] | null,
      filters?: { deptId?: string | null; q?: string | null; status?: "ALL" | "MISSING" | "DONE" },
    ) => Promise<Record<string, unknown>[]>;
  };
}

const ROWS = [
  { dailyApplicationId: "app-1", cccd: "010000000001", fullName: "Nguyen Van A", deptId: "dept-A", startingDate: null, regDate: "2026-08-17", deletedAt: null, dwImportedAt: new Date(), code: "CN-001", itCode: "IT-001" },
  { dailyApplicationId: "app-2", cccd: "010000000002", fullName: "Tran Thi B", deptId: "dept-B", startingDate: null, regDate: "2026-08-17", deletedAt: null, dwImportedAt: new Date(), code: "CN-002", itCode: null },
  { dailyApplicationId: "app-3", cccd: "010000000003", fullName: "Le Van C", deptId: "dept-A", startingDate: null, regDate: "2026-08-17", deletedAt: null, dwImportedAt: new Date(), code: null, itCode: null },
];

test("deptId: chỉ trả về lao động thuộc đúng bộ phận được lọc", async () => {
  const { getFingerprintItCodeRows } = loadFingerprintItCodeList(ROWS);
  const rows = await getFingerprintItCodeRows("2026-08-17", null, { deptId: "dept-A" });
  assert.equal(rows.length, 1, "chỉ app-1 vừa thuộc dept-A vừa đủ điều kiện hàng chờ (app-3 cùng dept nhưng chưa có Mã số công nhật)");
  assert.equal(rows[0].dailyApplicationId, "app-1");
});

test("q: tìm theo họ tên (không phân biệt hoa/thường)", async () => {
  const { getFingerprintItCodeRows } = loadFingerprintItCodeList(ROWS);
  const rows = await getFingerprintItCodeRows("2026-08-17", null, { q: "tran thi" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dailyApplicationId, "app-2");
});

test("q: tìm theo CCCD", async () => {
  const { getFingerprintItCodeRows } = loadFingerprintItCodeList(ROWS);
  const rows = await getFingerprintItCodeRows("2026-08-17", null, { q: "000002" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dailyApplicationId, "app-2");
});

test("q: tìm theo IT CODE", async () => {
  const { getFingerprintItCodeRows } = loadFingerprintItCodeList(ROWS);
  const rows = await getFingerprintItCodeRows("2026-08-17", null, { q: "it-001" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dailyApplicationId, "app-1");
});

test("status=MISSING: chỉ trả về hàng chưa có IT CODE (trong số đủ điều kiện hàng chờ)", async () => {
  const { getFingerprintItCodeRows } = loadFingerprintItCodeList(ROWS);
  const rows = await getFingerprintItCodeRows("2026-08-17", null, { status: "MISSING" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dailyApplicationId, "app-2");
});

test("status=DONE: chỉ trả về hàng đã có IT CODE", async () => {
  const { getFingerprintItCodeRows } = loadFingerprintItCodeList(ROWS);
  const rows = await getFingerprintItCodeRows("2026-08-17", null, { status: "DONE" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dailyApplicationId, "app-1");
});

test("status=ALL (mặc định): trả về mọi hàng đủ điều kiện hàng chờ, bất kể IT CODE", async () => {
  const { getFingerprintItCodeRows } = loadFingerprintItCodeList(ROWS);
  const rows = await getFingerprintItCodeRows("2026-08-17", null);
  assert.equal(rows.length, 2, "app-3 (chưa có Mã số công nhật -> chưa đủ điều kiện hàng chờ) vẫn bị loại — app-1 (DONE) và app-2 (MISSING) đều có mặt");
});

test("kết hợp deptId + status: 2 bộ lọc cùng áp dụng, không bộ nào ghi đè bộ kia", async () => {
  const { getFingerprintItCodeRows } = loadFingerprintItCodeList(ROWS);
  const rows = await getFingerprintItCodeRows("2026-08-17", null, { deptId: "dept-B", status: "MISSING" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dailyApplicationId, "app-2");
});

test("list và export nhận CÙNG một tập kết quả với cùng (date, scope, deptId, q, status)", async () => {
  const { getFingerprintItCodeRows } = loadFingerprintItCodeList(ROWS);
  const listRows = await getFingerprintItCodeRows("2026-08-17", ["dept-A", "dept-B"], { status: "ALL", q: "a" });
  const exportRows = await getFingerprintItCodeRows("2026-08-17", ["dept-A", "dept-B"], { status: "ALL", q: "a" });
  const listIds = listRows.map((r) => r.dailyApplicationId).sort();
  const exportIds = exportRows.map((r) => r.dailyApplicationId).sort();
  assert.deepEqual(listIds, exportIds);
  assert.ok(listIds.length > 0);
});

test("scope=[] (không có bộ phận nào) -> zero rows, không cần query", async () => {
  const { getFingerprintItCodeRows } = loadFingerprintItCodeList(ROWS);
  const rows = await getFingerprintItCodeRows("2026-08-17", []);
  assert.equal(rows.length, 0);
});

/* ------------------------------------------------------------
   PHASE 6 — HISTORICAL DATA: ngày được chọn phải thực sự điều khiển
   truy vấn nghiệp vụ (eq(regDate, date)) — đổi ngày KHÔNG được vô tình
   trả về dữ liệu của ngày khác (vd. hôm nay).
   ------------------------------------------------------------ */
test("ngày lịch sử (10/08/2026, khác regDate của mọi hàng) -> zero rows, KHÔNG lẫn dữ liệu ngày khác", async () => {
  const { getFingerprintItCodeRows } = loadFingerprintItCodeList(ROWS);
  const rows = await getFingerprintItCodeRows("2026-08-10", null);
  assert.equal(rows.length, 0, "mọi hàng fixture có regDate=2026-08-17 — đổi ngày phải trả về rỗng, không phải dữ liệu của 2026-08-17");
});

test("đúng ngày regDate (2026-08-17) -> trả về đúng dữ liệu của ngày đó", async () => {
  const { getFingerprintItCodeRows } = loadFingerprintItCodeList(ROWS);
  const rows = await getFingerprintItCodeRows("2026-08-17", null);
  assert.ok(rows.length > 0);
});
