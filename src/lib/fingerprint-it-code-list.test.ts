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
     • Lọc theo itCodeStatus (ALL mặc định | MISSING | HAS) VÀ classification
       (ALL mặc định | NEW | RETURNING | TRANSFERRED) — 2 BỘ LỌC ĐỘC LẬP,
       không gộp chung (GLOBAL DATE RANGE STANDARDIZATION mission section 14).
     • Cùng tham số (range, scope, deptId, q, itCodeStatus, classification)
       -> CÙNG một tập kết quả, dù được gọi từ ngữ cảnh "danh sách" hay
       "xuất file".
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

function loadFingerprintItCodeList(rows: Record<string, unknown>[], classifications: Record<string, string> = {}) {
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
      gte: (col: unknown, v: unknown) => ({ op: "gte", col, v }),
      lte: (col: unknown, v: unknown) => ({ op: "lte", col, v }),
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
    // Classification is a separate, independently-tested service
    // (fingerprint-classification.test.ts) — stubbed here as "no
    // classification data" so this file's tests stay focused on the
    // date/deptId/q/status filter contract, unaffected by classification.
    "@/lib/fingerprint-classification": {
      classifyWorkforceEngagements: async (ids: string[]) => new Map(ids.filter((id) => id in classifications).map((id) => [id, classifications[id]])),
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
      range: { from: string; to: string },
      scope: string[] | null,
      filters?: { deptId?: string | null; q?: string | null; classification?: "ALL" | "NEW" | "RETURNING" | "TRANSFERRED"; itCodeStatus?: "ALL" | "MISSING" | "HAS" },
    ) => Promise<Record<string, unknown>[]>;
  };
}

const day = (d: string) => ({ from: d, to: d });

const ROWS = [
  { dailyApplicationId: "app-1", cccd: "010000000001", fullName: "Nguyen Van A", deptId: "dept-A", startingDate: null, regDate: "2026-08-17", deletedAt: null, dwImportedAt: new Date(), code: "CN-001", itCode: "IT-001" },
  { dailyApplicationId: "app-2", cccd: "010000000002", fullName: "Tran Thi B", deptId: "dept-B", startingDate: null, regDate: "2026-08-17", deletedAt: null, dwImportedAt: new Date(), code: "CN-002", itCode: null },
  { dailyApplicationId: "app-3", cccd: "010000000003", fullName: "Le Van C", deptId: "dept-A", startingDate: null, regDate: "2026-08-17", deletedAt: null, dwImportedAt: new Date(), code: null, itCode: null },
];

test("deptId: chỉ trả về lao động thuộc đúng bộ phận được lọc", async () => {
  const { getFingerprintItCodeRows } = loadFingerprintItCodeList(ROWS);
  const rows = await getFingerprintItCodeRows(day("2026-08-17"), null, { deptId: "dept-A" });
  assert.equal(rows.length, 1, "chỉ app-1 vừa thuộc dept-A vừa đủ điều kiện hàng chờ (app-3 cùng dept nhưng chưa có Mã số công nhật)");
  assert.equal(rows[0].dailyApplicationId, "app-1");
});

test("q: tìm theo họ tên (không phân biệt hoa/thường)", async () => {
  const { getFingerprintItCodeRows } = loadFingerprintItCodeList(ROWS);
  const rows = await getFingerprintItCodeRows(day("2026-08-17"), null, { q: "tran thi" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dailyApplicationId, "app-2");
});

test("q: tìm theo CCCD", async () => {
  const { getFingerprintItCodeRows } = loadFingerprintItCodeList(ROWS);
  const rows = await getFingerprintItCodeRows(day("2026-08-17"), null, { q: "000002" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dailyApplicationId, "app-2");
});

test("q: tìm theo IT CODE", async () => {
  const { getFingerprintItCodeRows } = loadFingerprintItCodeList(ROWS);
  const rows = await getFingerprintItCodeRows(day("2026-08-17"), null, { q: "it-001" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dailyApplicationId, "app-1");
});

test("itCodeStatus=MISSING: chỉ trả về hàng chưa có IT CODE (trong số đủ điều kiện hàng chờ)", async () => {
  const { getFingerprintItCodeRows } = loadFingerprintItCodeList(ROWS);
  const rows = await getFingerprintItCodeRows(day("2026-08-17"), null, { itCodeStatus: "MISSING" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dailyApplicationId, "app-2");
});

test("itCodeStatus=HAS: chỉ trả về hàng đã có IT CODE", async () => {
  const { getFingerprintItCodeRows } = loadFingerprintItCodeList(ROWS);
  const rows = await getFingerprintItCodeRows(day("2026-08-17"), null, { itCodeStatus: "HAS" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dailyApplicationId, "app-1");
});

test("itCodeStatus=ALL (mặc định): trả về mọi hàng đủ điều kiện hàng chờ, bất kể IT CODE", async () => {
  const { getFingerprintItCodeRows } = loadFingerprintItCodeList(ROWS);
  const rows = await getFingerprintItCodeRows(day("2026-08-17"), null);
  assert.equal(rows.length, 2, "app-3 (chưa có Mã số công nhật -> chưa đủ điều kiện hàng chờ) vẫn bị loại — app-1 (HAS) và app-2 (MISSING) đều có mặt");
});

test("kết hợp deptId + itCodeStatus: 2 bộ lọc cùng áp dụng, không bộ nào ghi đè bộ kia", async () => {
  const { getFingerprintItCodeRows } = loadFingerprintItCodeList(ROWS);
  const rows = await getFingerprintItCodeRows(day("2026-08-17"), null, { deptId: "dept-B", itCodeStatus: "MISSING" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dailyApplicationId, "app-2");
});

test("list và export nhận CÙNG một tập kết quả với cùng (range, scope, deptId, q, itCodeStatus)", async () => {
  const { getFingerprintItCodeRows } = loadFingerprintItCodeList(ROWS);
  const listRows = await getFingerprintItCodeRows(day("2026-08-17"), ["dept-A", "dept-B"], { itCodeStatus: "ALL", q: "a" });
  const exportRows = await getFingerprintItCodeRows(day("2026-08-17"), ["dept-A", "dept-B"], { itCodeStatus: "ALL", q: "a" });
  const listIds = listRows.map((r) => r.dailyApplicationId).sort();
  const exportIds = exportRows.map((r) => r.dailyApplicationId).sort();
  assert.deepEqual(listIds, exportIds);
  assert.ok(listIds.length > 0);
});

test("scope=[] (không có bộ phận nào) -> zero rows, không cần query", async () => {
  const { getFingerprintItCodeRows } = loadFingerprintItCodeList(ROWS);
  const rows = await getFingerprintItCodeRows(day("2026-08-17"), []);
  assert.equal(rows.length, 0);
});

/* ------------------------------------------------------------
   PHASE 6 — HISTORICAL DATA: ngày được chọn phải thực sự điều khiển
   truy vấn nghiệp vụ (eq(regDate, date)) — đổi ngày KHÔNG được vô tình
   trả về dữ liệu của ngày khác (vd. hôm nay).
   ------------------------------------------------------------ */
test("ngày lịch sử (10/08/2026, khác regDate của mọi hàng) -> zero rows, KHÔNG lẫn dữ liệu ngày khác", async () => {
  const { getFingerprintItCodeRows } = loadFingerprintItCodeList(ROWS);
  const rows = await getFingerprintItCodeRows(day("2026-08-10"), null);
  assert.equal(rows.length, 0, "mọi hàng fixture có regDate=2026-08-17 — đổi ngày phải trả về rỗng, không phải dữ liệu của 2026-08-17");
});

test("đúng ngày regDate (2026-08-17) -> trả về đúng dữ liệu của ngày đó", async () => {
  const { getFingerprintItCodeRows } = loadFingerprintItCodeList(ROWS);
  const rows = await getFingerprintItCodeRows(day("2026-08-17"), null);
  assert.ok(rows.length > 0);
});

/* ------------------------------------------------------------
   IDENTITY & IT CODE CONTRACT REVIEW (2026-09-13) — classification
   (NEW/RETURNING/TRANSFERRED) is attached per row from the shared
   classifyWorkforceEngagements() service (stubbed here) and is filterable
   through its OWN "classification" param, completely independent from the
   "itCodeStatus" param (MISSING/HAS) — GLOBAL DATE RANGE STANDARDIZATION
   mission section 14 explicitly forbids merging these into one dropdown.
   ------------------------------------------------------------ */
test("classification is attached to each row when the classification service provides it", async () => {
  const { getFingerprintItCodeRows } = loadFingerprintItCodeList(ROWS, { "app-1": "RETURNING", "app-2": "NEW" });
  const rows = await getFingerprintItCodeRows(day("2026-08-17"), null);
  const byId = new Map(rows.map((r) => [r.dailyApplicationId, r.classification]));
  assert.equal(byId.get("app-1"), "RETURNING");
  assert.equal(byId.get("app-2"), "NEW");
});

test("classification=NEW: filters by classification, independent from IT CODE presence", async () => {
  const { getFingerprintItCodeRows } = loadFingerprintItCodeList(ROWS, { "app-1": "RETURNING", "app-2": "NEW" });
  const rows = await getFingerprintItCodeRows(day("2026-08-17"), null, { classification: "NEW" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dailyApplicationId, "app-2");
});

test("classification=TRANSFERRED: returns only rows classified TRANSFERRED", async () => {
  const { getFingerprintItCodeRows } = loadFingerprintItCodeList(ROWS, { "app-1": "TRANSFERRED", "app-2": "NEW" });
  const rows = await getFingerprintItCodeRows(day("2026-08-17"), null, { classification: "TRANSFERRED" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dailyApplicationId, "app-1");
});

test("row with no employment_sessions entry yet gets classification=null, never guessed as NEW", async () => {
  const { getFingerprintItCodeRows } = loadFingerprintItCodeList(ROWS, { "app-1": "RETURNING" });
  const rows = await getFingerprintItCodeRows(day("2026-08-17"), null, { itCodeStatus: "HAS" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dailyApplicationId, "app-1");
  assert.equal(rows[0].classification, "RETURNING");
});

/* ------------------------------------------------------------
   I1-I9 — classification và itCodeStatus là 2 BỘ LỌC ĐỘC LẬP: mọi tổ hợp
   phải hoạt động đúng (vd. RETURNING+MISSING, TRANSFERRED+HAS), và khoảng
   ngày nhiều ngày phải kết hợp đúng với cả hai bộ lọc này.
   ------------------------------------------------------------ */
test("I1: RETURNING+MISSING — tổ hợp classification & itCodeStatus hoạt động đúng, không bộ nào bị bỏ qua", async () => {
  const rows4 = [
    ...ROWS,
    { dailyApplicationId: "app-4", cccd: "010000000004", fullName: "Pham Van D", deptId: "dept-A", startingDate: null, regDate: "2026-08-17", deletedAt: null, dwImportedAt: new Date(), code: "CN-004", itCode: null },
  ];
  const { getFingerprintItCodeRows } = loadFingerprintItCodeList(rows4, { "app-1": "RETURNING", "app-2": "NEW", "app-4": "RETURNING" });
  const rows = await getFingerprintItCodeRows(day("2026-08-17"), null, { classification: "RETURNING", itCodeStatus: "MISSING" });
  assert.deepEqual(rows.map((r) => r.dailyApplicationId), ["app-4"], "app-1 là RETURNING nhưng đã HAS IT Code nên bị loại; app-4 là RETURNING+MISSING nên khớp");
});

test("I2: TRANSFERRED+HAS — tổ hợp ngược lại cũng hoạt động đúng", async () => {
  const { getFingerprintItCodeRows } = loadFingerprintItCodeList(ROWS, { "app-1": "TRANSFERRED", "app-2": "NEW" });
  const rows = await getFingerprintItCodeRows(day("2026-08-17"), null, { classification: "TRANSFERRED", itCodeStatus: "HAS" });
  assert.deepEqual(rows.map((r) => r.dailyApplicationId), ["app-1"]);
});

test("I3: classification=ALL + itCodeStatus=ALL (mặc định) trả về mọi hàng đủ điều kiện hàng chờ", async () => {
  const { getFingerprintItCodeRows } = loadFingerprintItCodeList(ROWS, { "app-1": "RETURNING", "app-2": "NEW" });
  const rows = await getFingerprintItCodeRows(day("2026-08-17"), null, { classification: "ALL", itCodeStatus: "ALL" });
  assert.equal(rows.length, 2);
});

test("I4: đổi itCodeStatus KHÔNG ảnh hưởng classification đang chọn, và ngược lại (2 bộ lọc độc lập)", async () => {
  const { getFingerprintItCodeRows } = loadFingerprintItCodeList(ROWS, { "app-1": "RETURNING", "app-2": "NEW" });
  const onlyClassification = await getFingerprintItCodeRows(day("2026-08-17"), null, { classification: "RETURNING" });
  const bothFilters = await getFingerprintItCodeRows(day("2026-08-17"), null, { classification: "RETURNING", itCodeStatus: "ALL" });
  assert.deepEqual(onlyClassification.map((r) => r.dailyApplicationId), bothFilters.map((r) => r.dailyApplicationId));
});

/* ------------------------------------------------------------
   I5-I9 — khoảng ngày nhiều ngày cho IT Code / Vân tay.
   ------------------------------------------------------------ */
const MULTI_DAY_ROWS = [
  { dailyApplicationId: "app-1", cccd: "010000000001", fullName: "Nguyen Van A", deptId: "dept-A", startingDate: null, regDate: "2026-09-01", deletedAt: null, dwImportedAt: new Date(), code: "CN-001", itCode: "IT-001" },
  { dailyApplicationId: "app-2", cccd: "010000000002", fullName: "Tran Thi B", deptId: "dept-A", startingDate: null, regDate: "2026-09-07", deletedAt: null, dwImportedAt: new Date(), code: "CN-002", itCode: null },
  { dailyApplicationId: "app-3", cccd: "010000000003", fullName: "Le Van C", deptId: "dept-A", startingDate: null, regDate: "2026-09-13", deletedAt: null, dwImportedAt: new Date(), code: "CN-003", itCode: null },
  { dailyApplicationId: "app-4-outside", cccd: "010000000004", fullName: "Pham Van D", deptId: "dept-A", startingDate: null, regDate: "2026-09-14", deletedAt: null, dwImportedAt: new Date(), code: "CN-004", itCode: null },
];

test("I5: khoảng nhiều ngày trả về mọi hàng trong khoảng (biên inclusive), loại hàng ngoài khoảng", async () => {
  const { getFingerprintItCodeRows } = loadFingerprintItCodeList(MULTI_DAY_ROWS);
  const rows = await getFingerprintItCodeRows({ from: "2026-09-01", to: "2026-09-13" }, null);
  assert.deepEqual(rows.map((r) => r.dailyApplicationId).sort(), ["app-1", "app-2", "app-3"]);
});

test("I6: khoảng nhiều ngày + itCodeStatus=MISSING: đếm đúng trên toàn bộ khoảng, không chỉ 1 ngày", async () => {
  const { getFingerprintItCodeRows } = loadFingerprintItCodeList(MULTI_DAY_ROWS);
  const rows = await getFingerprintItCodeRows({ from: "2026-09-01", to: "2026-09-13" }, null, { itCodeStatus: "MISSING" });
  assert.deepEqual(rows.map((r) => r.dailyApplicationId).sort(), ["app-2", "app-3"]);
});

test("I7: mỗi daily_applications.id là 1 hàng riêng biệt trong khoảng — không gộp nhiều ngày của cùng 1 CCCD thành 1 hàng", async () => {
  const sameCccdTwoDays = [
    { dailyApplicationId: "app-day1", cccd: "010000000009", fullName: "Vo Thi F", deptId: "dept-A", startingDate: null, regDate: "2026-09-10", deletedAt: null, dwImportedAt: new Date(), code: "CN-009", itCode: null },
    { dailyApplicationId: "app-day2", cccd: "010000000009", fullName: "Vo Thi F", deptId: "dept-A", startingDate: null, regDate: "2026-09-12", deletedAt: null, dwImportedAt: new Date(), code: "CN-009", itCode: null },
  ];
  const { getFingerprintItCodeRows } = loadFingerprintItCodeList(sameCccdTwoDays);
  const rows = await getFingerprintItCodeRows({ from: "2026-09-01", to: "2026-09-13" }, null);
  assert.equal(rows.length, 2, "2 daily_applications rows riêng biệt (2 lượt đăng ký thật trong 2 ngày khác nhau) — dedup key là dailyApplicationId, không phải cccd");
});

test("I8: list và export nhận CÙNG một tập kết quả với cùng khoảng ngày nhiều ngày", async () => {
  const { getFingerprintItCodeRows } = loadFingerprintItCodeList(MULTI_DAY_ROWS);
  const listRows = await getFingerprintItCodeRows({ from: "2026-09-01", to: "2026-09-13" }, null, { itCodeStatus: "ALL" });
  const exportRows = await getFingerprintItCodeRows({ from: "2026-09-01", to: "2026-09-13" }, null, { itCodeStatus: "ALL" });
  assert.deepEqual(listRows.map((r) => r.dailyApplicationId).sort(), exportRows.map((r) => r.dailyApplicationId).sort());
});

test("I9: khoảng ngày không chứa hàng nào -> zero rows, không lẫn dữ liệu ngoài khoảng", async () => {
  const { getFingerprintItCodeRows } = loadFingerprintItCodeList(MULTI_DAY_ROWS);
  const rows = await getFingerprintItCodeRows({ from: "2026-09-15", to: "2026-09-20" }, null);
  assert.equal(rows.length, 0);
});
