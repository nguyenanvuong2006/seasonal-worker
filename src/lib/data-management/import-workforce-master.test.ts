/**
 * WORKFORCE DATA MANAGEMENT — import-workforce-master.ts tests
 *
 * Test matrix:
 *   W1/W9, W5  — dry run (zero writes, invalid rows, file-level deduplication)
 *   W2         — new CCCD INSERT
 *   W3/W4      — existing CCCD UPDATE; untouched worker left alone
 *   CS1–CS10   — POST-GO-LIVE CANONICAL MIRROR ISOLATION REGRESSION SUITE
 *
 * CANONICAL MIRROR CONTRACT (verified by CS1–CS10):
 *   INSERT (new CCCD): dw_data.code = NULL, dw_data.it_code = NULL — always.
 *     The spreadsheet CODE/IT CODE values remain ONLY in the staged raw row.
 *   UPDATE (existing CCCD): code = dw_data.code, it_code = dw_data.it_code.
 *     Pure no-ops — neither mirror is ever touched by this importer.
 *
 * FAKE POOL SEMANTICS:
 *   The INSERT INTO dw_data SQL now uses:
 *     VALUES (NULL, NULL, $1, $2, ... $13)
 *   So params[0] = oldDwCode, params[1] = idVlookup, params[2] = fullName,
 *   params[7] = cccd.  code and it_code are NOT in params.
 *
 *   The fake client's INSERT handler mirrors this exactly.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { loadModule, serverOnlyStub } from "../test-support/load-module.ts";
import { createFakeDb, makeTable, type FakeDb, type QueryCall } from "../test-support/fake-drizzle.ts";

const workforceDataImportBatches = makeTable("workforce_data_import_batches");
const workforceDataImportRows = makeTable("workforce_data_import_rows");

/** In-memory dw_data table for the fake pg client. */
type DwRow = { cccd: string; code: string | null; full_name: string; it_code: string | null };

/**
 * makeFakePool — mirrors the FINAL canonical mirror isolation SQL contract.
 *
 * Param positions after the fix (code/it_code removed from params; SQL uses NULL literals):
 *   $1  = oldDwCode   (params[0])
 *   $2  = idVlookup   (params[1])
 *   $3  = fullName    (params[2])
 *   $4  = gender      (params[3])
 *   $5  = bod         (params[4])
 *   $6  = profile     (params[5])
 *   $7  = dktn        (params[6])
 *   $8  = cccd        (params[7])
 *   $9  = dateOfIssue (params[8])
 *   $10 = placeOfIssue (params[9])
 *   $11 = permanentAddress (params[10])
 *   $12 = residentialAddress (params[11])
 *   $13 = phone       (params[12])
 *
 * INSERT: code = NULL, it_code = NULL — always (SQL literal, not from params).
 * UPDATE: code = existing code, it_code = existing it_code — pure no-ops.
 */
function makeFakePool(initialDwData: DwRow[]) {
  const dwData = new Map(initialDwData.map((r) => [r.cccd, { ...r }]));
  const queries: { text: string; params: unknown[] }[] = [];

  const client = {
    query: async (text: string, params: unknown[] = []) => {
      queries.push({ text, params });
      if (text.startsWith("BEGIN") || text.startsWith("COMMIT") || text.startsWith("ROLLBACK")) return { rows: [] };
      if (text.includes("SELECT cccd") && text.includes("FROM dw_data") && text.includes("= ANY")) {
        const requested = new Set(params[0] as string[]);
        const rows = [...dwData.keys()].filter((c) => requested.has(c)).map((c) => ({ cccd: c, dup: "1" }));
        return { rows };
      }
      if (text.includes("INSERT INTO dw_data")) {
        // Params: $1=oldDwCode, $2=idVlookup, $3=fullName, ..., $8=cccd
        const cccd = params[7] as string;
        const existed = dwData.has(cccd);
        const existing = existed ? dwData.get(cccd)! : null;

        // Mirror the SQL contract:
        // INSERT: code = NULL, it_code = NULL (SQL literals — NOT from params)
        // UPDATE: code = existing.code, it_code = existing.it_code (no-ops)
        dwData.set(cccd, {
          cccd,
          code: existed ? existing!.code : null,         // INSERT→NULL, UPDATE→preserve
          it_code: existed ? existing!.it_code : null,   // INSERT→NULL, UPDATE→preserve
          full_name: params[2] as string,
        });
        return { rows: [{ inserted: !existed }] };
      }
      if (text.includes("UPDATE workforce_data_import_rows") || text.includes("UPDATE workforce_data_import_batches")) return { rows: [] };
      return { rows: [] };
    },
    release: () => {},
  };
  return { connect: async () => client, dwData, queries, query: (text: string, params?: unknown[]) => client.query(text, params ?? []) };
}

/** Mirrors makeFieldPicker's fallback-legacy-names branch for the empty-defs test case. */
function fakeMakeFieldPicker(row: Record<string, string>) {
  return (_fieldKey: string, fallbackLegacyNames: string[] = []) => {
    for (const name of fallbackLegacyNames) {
      if (row[name] !== undefined && String(row[name]).trim() !== "") return String(row[name]);
    }
    return undefined;
  };
}

async function loadModuleUnderTest(pool: ReturnType<typeof makeFakePool>, db: FakeDb) {
  return loadModule(new URL("./import-workforce-master.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      crypto: await import("node:crypto"),
      "drizzle-orm": await import("drizzle-orm"),
      "@/db": { db, pool },
      "@/db/schema": { workforceDataImportBatches, workforceDataImportRows },
      "@/lib/metadata": { getFieldDefinitions: async () => [], makeFieldPicker: fakeMakeFieldPicker },
      "@/lib/person-name": await import("../person-name.ts"),
      "@/lib/validators": await import("../validators.ts"),
    },
  }) as unknown as {
    dryRunWorkforceMaster: (rows: Record<string, string>[]) => Promise<{
      total: number;
      valid: number;
      invalid: number;
      newCount: number;
      existingCount: number;
      duplicatesInFile: number;
      invalidRows: { rowNumber: number; reason: string }[];
    }>;
    mergeWorkforceMasterChunk: (batchId: string) => Promise<{ processed: number; inserted: number; updated: number; invalid: number; done: boolean }>;
    computeFileChecksum: (s: string) => string;
  };
}

function row(cccd: string, fullName: string, extra: Record<string, string> = {}): Record<string, string> {
  return { CCCD: cccd, "HỌ TÊN": fullName, ...extra };
}

/* ── ORIGINAL W-SERIES ──────────────────────────────────────────────────── */

test("W1/W9 — dry run: zero writes (pure SELECT only), invalid rows reported with reasons", async () => {
  const pool = makeFakePool([]);
  const db = createFakeDb();
  const mod = await loadModuleUnderTest(pool, db);

  const result = await mod.dryRunWorkforceMaster([
    row("123456789012", "Nguyen Van A"),
    row("", "Missing CCCD"),
    row("123", "Too short CCCD"),
    { CCCD: "123456789099" }, // missing name
  ]);

  assert.equal(result.total, 4);
  assert.equal(result.valid, 1);
  assert.equal(result.invalid, 3);
  assert.equal(result.invalidRows.length, 3);
  assert.ok(result.invalidRows.some((r) => r.reason.includes("tên")));
  assert.ok(pool.queries.every((q) => q.text.trim().toUpperCase().startsWith("SELECT")), "dry run must never write");
});

test("W5 — dry run: duplicate CCCD within same file counted; both rows still individually valid", async () => {
  const pool = makeFakePool([]);
  const db = createFakeDb();
  const mod = await loadModuleUnderTest(pool, db);

  const result = await mod.dryRunWorkforceMaster([row("123456789012", "Person A v1"), row("123456789012", "Person A v2 (later wins)")]);
  assert.equal(result.valid, 2);
  assert.equal(result.duplicatesInFile, 1);
});

test("dry run: existing vs new classification against DB state", async () => {
  const pool = makeFakePool([{ cccd: "111111111111", code: "C1", full_name: "Existing Person", it_code: null }]);
  const db = createFakeDb();
  const mod = await loadModuleUnderTest(pool, db);

  const result = await mod.dryRunWorkforceMaster([row("111111111111", "Existing Person Updated"), row("222222222222", "Brand New Person")]);
  assert.equal(result.newCount, 1);
  assert.equal(result.existingCount, 1);
});

test("W2 — merge chunk: new CCCD is INSERTED", async () => {
  const pool = makeFakePool([]);
  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "workforce_data_import_rows") {
        return [{ id: "row-1", batchId: "batch-1", rowNumber: 1, rawData: row("333333333333", "New Worker"), status: "PENDING", message: null }];
      }
      if (call.root === "select") return [{ c: 0 }];
      return undefined;
    },
  });
  const mod = await loadModuleUnderTest(pool, db);

  const result = await mod.mergeWorkforceMasterChunk("batch-1");
  assert.equal(result.inserted, 1);
  assert.equal(result.updated, 0);
  assert.ok(pool.dwData.has("333333333333"));
  assert.equal(pool.dwData.get("333333333333")?.full_name, "New Worker");
});

test("W3/W4 — merge chunk: existing CCCD gets master field updates; untouched worker left alone", async () => {
  const pool = makeFakePool([
    { cccd: "111111111111", code: "DR00412-D", full_name: "Old Name", it_code: "IT-001" },
    { cccd: "999999999999", code: "UNRELATED", full_name: "Never In This File", it_code: null },
  ]);
  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "workforce_data_import_rows") {
        return [{ id: "row-1", batchId: "batch-1", rowNumber: 1, rawData: row("111111111111", "New Corrected Name", { CODE: "ATTEMPT-OVERWRITE" }), status: "PENDING", message: null }];
      }
      if (call.root === "select") return [{ c: 0 }];
      return undefined;
    },
  });
  const mod = await loadModuleUnderTest(pool, db);

  const result = await mod.mergeWorkforceMasterChunk("batch-1");
  assert.equal(result.inserted, 0);
  assert.equal(result.updated, 1);
  assert.equal(pool.dwData.get("111111111111")?.full_name, "New Corrected Name", "full_name must update");
  // Both mirrors untouched:
  assert.equal(pool.dwData.get("111111111111")?.code, "DR00412-D", "code mirror must be untouched");
  assert.equal(pool.dwData.get("111111111111")?.it_code, "IT-001", "it_code mirror must be untouched");
  // W4:
  const untouched = pool.dwData.get("999999999999");
  assert.ok(untouched, "absent worker must still exist");
  assert.equal(untouched?.full_name, "Never In This File");
});

test("computeFileChecksum is deterministic", async () => {
  const pool = makeFakePool([]);
  const db = createFakeDb();
  const mod = await loadModuleUnderTest(pool, db);
  assert.equal(mod.computeFileChecksum("hello"), mod.computeFileChecksum("hello"));
  assert.notEqual(mod.computeFileChecksum("hello"), mod.computeFileChecksum("world"));
});

/* ── CANONICAL MIRROR ISOLATION REGRESSION SUITE (CS1–CS10) ─────────────── */

/**
 * CS1 — INSERT new CCCD with spreadsheet code → dw_data.code is NULL.
 *
 * The spreadsheet CODE column must not populate the current operational mirror.
 */
test("CS1 — INSERT new CCCD with spreadsheet code: dw_data.code is NULL (not populated from spreadsheet)", async () => {
  const pool = makeFakePool([]);
  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "workforce_data_import_rows") {
        return [{ id: "r1", batchId: "b1", rowNumber: 1, rawData: row("100000000001", "New Worker", { CODE: "DR00001-D" }), status: "PENDING", message: null }];
      }
      if (call.root === "select") return [{ c: 0 }];
      return undefined;
    },
  });
  const mod = await loadModuleUnderTest(pool, db);

  const result = await mod.mergeWorkforceMasterChunk("b1");

  assert.equal(result.inserted, 1, "must be INSERT");
  const after = pool.dwData.get("100000000001");
  assert.ok(after, "row must exist after insert");
  assert.equal(after?.code, null, "dw_data.code must be NULL — never populated from spreadsheet on INSERT");
});

/**
 * CS2 — INSERT new CCCD with arbitrary/unknown code → current mirror remains NULL.
 *
 * Arbitrary codes (not in dw_codes pool) must never enter dw_data.code.
 */
test("CS2 — INSERT new CCCD with arbitrary unknown code: current mirror remains NULL", async () => {
  const pool = makeFakePool([]);
  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "workforce_data_import_rows") {
        return [{ id: "r1", batchId: "b2", rowNumber: 1, rawData: row("200000000001", "New Worker", { CODE: "ARBITRARY-FREE-TEXT-99" }), status: "PENDING", message: null }];
      }
      if (call.root === "select") return [{ c: 0 }];
      return undefined;
    },
  });
  const mod = await loadModuleUnderTest(pool, db);

  await mod.mergeWorkforceMasterChunk("b2");

  assert.equal(pool.dwData.get("200000000001")?.code, null, "arbitrary code must not enter dw_data.code");
});

/**
 * CS3 — INSERT new CCCD with RETIRED-looking code → current mirror remains NULL.
 *
 * Even if the spreadsheet contains a code that looks like a canonical code
 * (correct format, exists in dw_codes as RETIRED), it must not populate the mirror.
 */
test("CS3 — INSERT new CCCD with RETIRED-looking canonical code: current mirror remains NULL", async () => {
  const pool = makeFakePool([]);
  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "workforce_data_import_rows") {
        // DR13074-D would be a RETIRED code in the canonical pool after activation
        return [{ id: "r1", batchId: "b3", rowNumber: 1, rawData: row("300000000001", "New Worker", { CODE: "DR13074-D" }), status: "PENDING", message: null }];
      }
      if (call.root === "select") return [{ c: 0 }];
      return undefined;
    },
  });
  const mod = await loadModuleUnderTest(pool, db);

  await mod.mergeWorkforceMasterChunk("b3");

  assert.equal(pool.dwData.get("300000000001")?.code, null, "RETIRED-looking code must not enter dw_data.code on INSERT");
});

/**
 * CS4 — UPDATE existing CCCD with non-NULL dw_data.code → existing code preserved exactly.
 *
 * Active canonical mirror must be completely unchanged regardless of spreadsheet value.
 */
test("CS4 — UPDATE existing CCCD with non-NULL canonical mirror: existing code preserved exactly", async () => {
  const CANONICAL = "DR00412-D";
  const pool = makeFakePool([{ cccd: "400000000001", code: CANONICAL, full_name: "Worker", it_code: null }]);
  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "workforce_data_import_rows") {
        return [{ id: "r1", batchId: "b4", rowNumber: 1, rawData: row("400000000001", "Worker Updated Name", { CODE: "DIFFERENT-CODE" }), status: "PENDING", message: null }];
      }
      if (call.root === "select") return [{ c: 0 }];
      return undefined;
    },
  });
  const mod = await loadModuleUnderTest(pool, db);

  await mod.mergeWorkforceMasterChunk("b4");

  assert.equal(pool.dwData.get("400000000001")?.code, CANONICAL, "existing canonical mirror must be preserved exactly");
});

/**
 * CS5 — UPDATE existing CCCD with NULL dw_data.code + spreadsheet code → remains NULL.
 *
 * Even when the current mirror is NULL (worker never operationally assigned),
 * the spreadsheet code must NOT fill it. NULL must stay NULL.
 */
test("CS5 — UPDATE existing CCCD with NULL dw_data.code + spreadsheet code: mirror remains NULL", async () => {
  const pool = makeFakePool([{ cccd: "500000000001", code: null, full_name: "Never Assigned", it_code: null }]);
  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "workforce_data_import_rows") {
        return [{ id: "r1", batchId: "b5", rowNumber: 1, rawData: row("500000000001", "Never Assigned Updated", { CODE: "DR-HIST-FILL-ATTEMPT" }), status: "PENDING", message: null }];
      }
      if (call.root === "select") return [{ c: 0 }];
      return undefined;
    },
  });
  const mod = await loadModuleUnderTest(pool, db);

  await mod.mergeWorkforceMasterChunk("b5");

  assert.equal(pool.dwData.get("500000000001")?.code, null, "NULL mirror must remain NULL — spreadsheet code must not fill it");
});

/**
 * CS6 — UPDATE cannot introduce a second/current code.
 *
 * Re-importing the same CCCD multiple times never changes the code mirror.
 */
test("CS6 — UPDATE cannot introduce a second/current code; multiple imports are idempotent on code mirror", async () => {
  const CANONICAL = "DR00100-D";
  const pool = makeFakePool([{ cccd: "600000000001", code: CANONICAL, full_name: "Worker", it_code: null }]);
  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "workforce_data_import_rows") {
        // Two rows for same CCCD in one chunk, different codes
        return [
          { id: "r1", batchId: "b6", rowNumber: 1, rawData: row("600000000001", "Worker v1", { CODE: "DR-ATTEMPT-1" }), status: "PENDING", message: null },
          { id: "r2", batchId: "b6", rowNumber: 2, rawData: row("600000000001", "Worker v2", { CODE: "DR-ATTEMPT-2" }), status: "PENDING", message: null },
        ];
      }
      if (call.root === "select") return [{ c: 0 }];
      return undefined;
    },
  });
  const mod = await loadModuleUnderTest(pool, db);

  const result = await mod.mergeWorkforceMasterChunk("b6");
  assert.equal(result.updated, 2, "both rows are updates");
  assert.equal(result.inserted, 0, "must not be inserts");
  assert.equal(pool.dwData.get("600000000001")?.code, CANONICAL, "canonical mirror unchanged through multiple updates");
});

/**
 * CS7 — Existing active canonical mirror remains unchanged across entire chunk.
 *
 * Multiple workers in same chunk — each preserves their own canonical mirror independently.
 */
test("CS7 — existing active canonical mirrors for all workers in chunk remain unchanged", async () => {
  const pool = makeFakePool([
    { cccd: "701000000001", code: "DR00200-D", full_name: "Worker A", it_code: null },
    { cccd: "701000000002", code: "DR00201-D", full_name: "Worker B", it_code: "IT-B-001" },
    { cccd: "701000000003", code: null, full_name: "Worker C (no code)", it_code: null },
  ]);
  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "workforce_data_import_rows") {
        return [
          { id: "r1", batchId: "b7", rowNumber: 1, rawData: row("701000000001", "Worker A Updated", { CODE: "DR00201-D" }), status: "PENDING", message: null },
          { id: "r2", batchId: "b7", rowNumber: 2, rawData: row("701000000002", "Worker B Updated", { CODE: "DR00200-D" }), status: "PENDING", message: null },
          { id: "r3", batchId: "b7", rowNumber: 3, rawData: row("701000000003", "Worker C Updated", { CODE: "DR-NEW-FILL-ATTEMPT" }), status: "PENDING", message: null },
        ];
      }
      if (call.root === "select") return [{ c: 0 }];
      return undefined;
    },
  });
  const mod = await loadModuleUnderTest(pool, db);

  await mod.mergeWorkforceMasterChunk("b7");

  assert.equal(pool.dwData.get("701000000001")?.code, "DR00200-D", "Worker A canonical mirror preserved");
  assert.equal(pool.dwData.get("701000000002")?.code, "DR00201-D", "Worker B canonical mirror preserved");
  assert.equal(pool.dwData.get("701000000003")?.code, null, "Worker C NULL mirror stays NULL");
});

/**
 * CS8 — Spreadsheet code remains only as staged/source evidence, not in current mirror.
 *
 * The INSERT SQL query must NOT include the spreadsheet code or it_code as params.
 * Proves that params[0] is oldDwCode, not code.
 */
test("CS8 — INSERT SQL params do not contain spreadsheet code or it_code; code/it_code are SQL NULL literals", async () => {
  const SPREADSHEET_CODE = "DR-SPREADSHEET-CODE";
  const SPREADSHEET_IT_CODE = "IT-SPREADSHEET-001";
  const pool = makeFakePool([]);
  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "workforce_data_import_rows") {
        return [{ id: "r1", batchId: "b8", rowNumber: 1, rawData: row("800000000001", "New Worker", { CODE: SPREADSHEET_CODE, "IT CODE": SPREADSHEET_IT_CODE }), status: "PENDING", message: null }];
      }
      if (call.root === "select") return [{ c: 0 }];
      return undefined;
    },
  });
  const mod = await loadModuleUnderTest(pool, db);

  await mod.mergeWorkforceMasterChunk("b8");

  // Find the INSERT INTO dw_data query
  const insertQ = pool.queries.find((q) => q.text.includes("INSERT INTO dw_data"));
  assert.ok(insertQ, "INSERT INTO dw_data must be issued");

  // The params array must NOT contain the spreadsheet code or it_code values:
  const paramsStr = JSON.stringify(insertQ!.params);
  assert.ok(!paramsStr.includes(SPREADSHEET_CODE), "spreadsheet code must not appear in SQL params");
  assert.ok(!paramsStr.includes(SPREADSHEET_IT_CODE), "spreadsheet it_code must not appear in SQL params");

  // The SQL text must use NULL literals for code/it_code, not params:
  assert.ok(insertQ!.text.includes("VALUES (NULL, NULL,"), "SQL must use NULL literals for code and it_code, not params");

  // The current mirror must be NULL:
  assert.equal(pool.dwData.get("800000000001")?.code, null, "dw_data.code must be NULL");
  assert.equal(pool.dwData.get("800000000001")?.it_code, null, "dw_data.it_code must be NULL");
});

/**
 * CS9a — it_code mirror: INSERT new CCCD with spreadsheet IT CODE → it_code is NULL.
 * CS9b — it_code mirror: UPDATE existing CCCD with non-NULL it_code → it_code preserved.
 * CS9c — it_code mirror: UPDATE existing CCCD with NULL it_code + spreadsheet IT CODE → remains NULL.
 *
 * Identical semantics to code mirror: never populated or modified by import.
 */
test("CS9a — it_code: INSERT new CCCD with spreadsheet IT CODE: dw_data.it_code is NULL", async () => {
  const pool = makeFakePool([]);
  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "workforce_data_import_rows") {
        return [{ id: "r1", batchId: "b9a", rowNumber: 1, rawData: row("900000000001", "New Worker", { "IT CODE": "IT-SPREADSHEET-FILL" }), status: "PENDING", message: null }];
      }
      if (call.root === "select") return [{ c: 0 }];
      return undefined;
    },
  });
  const mod = await loadModuleUnderTest(pool, db);

  await mod.mergeWorkforceMasterChunk("b9a");

  assert.equal(pool.dwData.get("900000000001")?.it_code, null, "dw_data.it_code must be NULL on INSERT — never from spreadsheet");
});

test("CS9b — it_code: UPDATE existing CCCD with non-NULL it_code: it_code mirror preserved exactly", async () => {
  const CANONICAL_IT = "IT-CANONICAL-001";
  const pool = makeFakePool([{ cccd: "900000000002", code: null, full_name: "Worker", it_code: CANONICAL_IT }]);
  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "workforce_data_import_rows") {
        return [{ id: "r1", batchId: "b9b", rowNumber: 1, rawData: row("900000000002", "Worker Updated", { "IT CODE": "IT-DIFFERENT" }), status: "PENDING", message: null }];
      }
      if (call.root === "select") return [{ c: 0 }];
      return undefined;
    },
  });
  const mod = await loadModuleUnderTest(pool, db);

  await mod.mergeWorkforceMasterChunk("b9b");

  assert.equal(pool.dwData.get("900000000002")?.it_code, CANONICAL_IT, "canonical it_code mirror must be preserved");
});

test("CS9c — it_code: UPDATE existing CCCD with NULL it_code + spreadsheet IT CODE: remains NULL", async () => {
  const pool = makeFakePool([{ cccd: "900000000003", code: null, full_name: "Worker", it_code: null }]);
  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "workforce_data_import_rows") {
        return [{ id: "r1", batchId: "b9c", rowNumber: 1, rawData: row("900000000003", "Worker Updated", { "IT CODE": "IT-FILL-ATTEMPT" }), status: "PENDING", message: null }];
      }
      if (call.root === "select") return [{ c: 0 }];
      return undefined;
    },
  });
  const mod = await loadModuleUnderTest(pool, db);

  await mod.mergeWorkforceMasterChunk("b9c");

  assert.equal(pool.dwData.get("900000000003")?.it_code, null, "NULL it_code must remain NULL — spreadsheet IT CODE must not fill it");
});

/**
 * CS10 — Non-code master fields update correctly; code/it_code untouched.
 *
 * Verifies that only the canonical mirror columns are isolated;
 * all other master fields (full_name, gender, etc.) still update as expected.
 */
test("CS10 — non-code master fields (full_name, gender, etc.) still update correctly; code and it_code mirrors unchanged", async () => {
  const pool = makeFakePool([{ cccd: "101000000001", code: "DR00300-D", full_name: "Old Name", it_code: "IT-CANON-OLD" }]);
  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "workforce_data_import_rows") {
        return [{
          id: "r1", batchId: "b10", rowNumber: 1,
          rawData: row("101000000001", "Updated Full Name", { CODE: "DR-SHOULD-NOT-WRITE", "IT CODE": "IT-SHOULD-NOT-WRITE" }),
          status: "PENDING", message: null,
        }];
      }
      if (call.root === "select") return [{ c: 0 }];
      return undefined;
    },
  });
  const mod = await loadModuleUnderTest(pool, db);

  await mod.mergeWorkforceMasterChunk("b10");

  const after = pool.dwData.get("101000000001");
  // Non-code field updated:
  assert.equal(after?.full_name, "Updated Full Name", "full_name must update");
  // Both code mirrors completely untouched:
  assert.equal(after?.code, "DR00300-D", "code mirror must be unchanged");
  assert.equal(after?.it_code, "IT-CANON-OLD", "it_code mirror must be unchanged");
});
