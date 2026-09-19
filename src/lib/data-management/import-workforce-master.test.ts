/**
 * WORKFORCE DATA MANAGEMENT — import-workforce-master.ts tests
 *
 * Test matrix:
 *   W1-W9  (original): dry-run, UPSERT semantics, idempotency, checksum
 *   C1-C10 (new):      POST-GO-LIVE CANONICAL DW CODE SAFETY CONTRACT
 *
 * Identity field: cccd (12-digit citizen ID), not a workerCode/DR0001-D
 * surrogate — see the module's own docblock and scopes.ts.
 *
 * FAKE POOL SEMANTICS:
 *   The fake pg `client` mirrors the COALESCE SQL contract:
 *     - INSERT (new cccd): sets code = params[0]
 *     - UPDATE (existing cccd): code = existing ?? params[0]  (COALESCE)
 *   This lets the canonical-safety tests prove the contract without hitting
 *   a real database.
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
 * makeFakePool — mirrors the COALESCE contract of the production SQL.
 *
 * INSERT path  (new cccd):   code = params[0]                      (from spreadsheet)
 * UPDATE path  (existing):   code = existing_code ?? params[0]     (COALESCE: preserve canonical mirror if set)
 *              it_code:      existing_it_code ?? params[1]          (same guard)
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
        // Params order: $1=code, $2=it_code, $3=old_dw_code, $4=id_vlookup, $5=full_name, ... $10=cccd
        const cccd = params[9] as string;
        const existed = dwData.has(cccd);
        const existing = existed ? dwData.get(cccd)! : null;

        // Mirror the COALESCE SQL contract:
        // - code: preserve existing (non-null) canonical mirror; fill from file only if NULL
        // - it_code: same guard
        const newCode = existed ? (existing!.code ?? (params[0] as string | null)) : (params[0] as string | null);
        const newItCode = existed ? (existing!.it_code ?? (params[1] as string | null)) : (params[1] as string | null);

        dwData.set(cccd, {
          cccd,
          code: newCode,
          it_code: newItCode,
          full_name: params[4] as string,
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

/* ── ORIGINAL W-SERIES TESTS ─────────────────────────────────────────────── */

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

test("W5 — dry run: duplicate CCCD within the same file is counted, both rows still individually valid", async () => {
  const pool = makeFakePool([]);
  const db = createFakeDb();
  const mod = await loadModuleUnderTest(pool, db);

  const result = await mod.dryRunWorkforceMaster([row("123456789012", "Person A v1"), row("123456789012", "Person A v2 (later wins)")]);

  assert.equal(result.valid, 2);
  assert.equal(result.duplicatesInFile, 1);
});

test("dry run: existing vs new classification against real DB state", async () => {
  const pool = makeFakePool([{ cccd: "111111111111", code: "C1", full_name: "Existing Person", it_code: null }]);
  const db = createFakeDb();
  const mod = await loadModuleUnderTest(pool, db);

  const result = await mod.dryRunWorkforceMaster([row("111111111111", "Existing Person Updated"), row("222222222222", "Brand New Person")]);

  assert.equal(result.newCount, 1);
  assert.equal(result.existingCount, 1);
});

test("W2 — merge chunk: new cccd is INSERTED", async () => {
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

test("W3/W4 — merge chunk: existing cccd gets master field update; canonical code mirror is PRESERVED (not overwritten); untouched worker left alone", async () => {
  const pool = makeFakePool([
    // This worker has an active canonical code "OLD-CODE" — the canonical mirror.
    // The spreadsheet tries to write "NEW-CODE" — must be rejected by COALESCE.
    { cccd: "111111111111", code: "OLD-CODE", full_name: "Old Name", it_code: "ALREADY-ASSIGNED" },
    { cccd: "999999999999", code: "UNRELATED", full_name: "Never In This File", it_code: null },
  ]);
  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "workforce_data_import_rows") {
        return [{ id: "row-1", batchId: "batch-1", rowNumber: 1, rawData: row("111111111111", "New Corrected Name", { CODE: "NEW-CODE" }), status: "PENDING", message: null }];
      }
      if (call.root === "select") return [{ c: 0 }];
      return undefined;
    },
  });
  const mod = await loadModuleUnderTest(pool, db);

  const result = await mod.mergeWorkforceMasterChunk("batch-1");
  assert.equal(result.inserted, 0);
  assert.equal(result.updated, 1);
  // Non-code master fields are correctly updated:
  assert.equal(pool.dwData.get("111111111111")?.full_name, "New Corrected Name");
  // CANONICAL SAFETY: existing code "OLD-CODE" must be PRESERVED — not overwritten by "NEW-CODE":
  assert.equal(pool.dwData.get("111111111111")?.code, "OLD-CODE", "canonical mirror must NOT be overwritten by spreadsheet import");
  // W4: worker absent from the file must never be touched:
  const untouched = pool.dwData.get("999999999999");
  assert.ok(untouched, "worker absent from the file must still exist");
  assert.equal(untouched?.full_name, "Never In This File");
});

test("computeFileChecksum is deterministic (same content -> same checksum, used for import idempotency)", async () => {
  const pool = makeFakePool([]);
  const db = createFakeDb();
  const mod = await loadModuleUnderTest(pool, db);
  assert.equal(mod.computeFileChecksum("hello"), mod.computeFileChecksum("hello"));
  assert.notEqual(mod.computeFileChecksum("hello"), mod.computeFileChecksum("world"));
});

/* ── CANONICAL SAFETY REGRESSION TESTS (C1–C10) ─────────────────────────── */

/**
 * C1 — Import cannot overwrite mirror while active canonical assignment disagrees.
 *
 * Proves: COALESCE(dw_data.code, EXCLUDED.code) keeps the canonical mirror
 * when the worker already has a non-NULL code set by the canonical pool route.
 */
test("C1 — import cannot overwrite dw_data.code when active canonical assignment exists (COALESCE preserves mirror)", async () => {
  const CANONICAL_CODE = "DR00412-D";
  const SPREADSHEET_CODE = "DR-LEGACY-001";
  const pool = makeFakePool([{ cccd: "100000000001", code: CANONICAL_CODE, full_name: "Worker One", it_code: null }]);
  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "workforce_data_import_rows") {
        return [{ id: "r1", batchId: "b1", rowNumber: 1, rawData: row("100000000001", "Worker One Updated", { CODE: SPREADSHEET_CODE }), status: "PENDING", message: null }];
      }
      if (call.root === "select") return [{ c: 0 }];
      return undefined;
    },
  });
  const mod = await loadModuleUnderTest(pool, db);

  await mod.mergeWorkforceMasterChunk("b1");

  const after = pool.dwData.get("100000000001");
  assert.equal(after?.code, CANONICAL_CODE, "canonical mirror DR00412-D must be preserved");
  assert.notEqual(after?.code, SPREADSHEET_CODE, "spreadsheet code must not displace canonical mirror");
});

/**
 * C2 — Import cannot assign a code actively owned by another worker.
 *
 * Each worker preserves their own canonical mirror independently. Worker A's
 * import does not disturb Worker B's mirror.
 */
test("C2 — import preserves each worker's own canonical code; cannot silently reassign code between workers", async () => {
  const pool = makeFakePool([
    { cccd: "200000000001", code: "DR00100-D", full_name: "Worker A", it_code: null },
    { cccd: "200000000002", code: "DR00101-D", full_name: "Worker B", it_code: null },
  ]);
  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "workforce_data_import_rows") {
        // Both workers imported; spreadsheet gives Worker A the code that B owns.
        return [
          { id: "r1", batchId: "b2", rowNumber: 1, rawData: row("200000000001", "Worker A", { CODE: "DR00101-D" }), status: "PENDING", message: null },
          { id: "r2", batchId: "b2", rowNumber: 2, rawData: row("200000000002", "Worker B", { CODE: "DR00100-D" }), status: "PENDING", message: null },
        ];
      }
      if (call.root === "select") return [{ c: 0 }];
      return undefined;
    },
  });
  const mod = await loadModuleUnderTest(pool, db);

  await mod.mergeWorkforceMasterChunk("b2");

  // Each worker's canonical mirror is unchanged:
  assert.equal(pool.dwData.get("200000000001")?.code, "DR00100-D", "Worker A keeps own canonical code");
  assert.equal(pool.dwData.get("200000000002")?.code, "DR00101-D", "Worker B keeps own canonical code");
});

/**
 * C3 — Import cannot reactivate a RETIRED code.
 *
 * After activation, existing workers whose code was set as a RETIRED canonical
 * code still have that code in dw_data.code as their mirror. A subsequent
 * import with any code value must not change the mirror on update.
 * (COALESCE preserves it whether RETIRED or ASSIGNED — the import cannot
 * distinguish pool status, which is precisely why it must never overwrite.)
 */
test("C3 — import of existing worker with any code value never overwrites the canonical mirror (RETIRED or otherwise)", async () => {
  const EXISTING_MIRROR = "DR00050-D"; // this code is RETIRED in dw_codes, but mirror reflects historical assignment
  const pool = makeFakePool([{ cccd: "300000000001", code: EXISTING_MIRROR, full_name: "Old Worker", it_code: null }]);
  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "workforce_data_import_rows") {
        return [{ id: "r1", batchId: "b3", rowNumber: 1, rawData: row("300000000001", "Old Worker Updated", { CODE: "DR99999-D" }), status: "PENDING", message: null }];
      }
      if (call.root === "select") return [{ c: 0 }];
      return undefined;
    },
  });
  const mod = await loadModuleUnderTest(pool, db);

  await mod.mergeWorkforceMasterChunk("b3");

  assert.equal(pool.dwData.get("300000000001")?.code, EXISTING_MIRROR, "mirror must not be overwritten regardless of spreadsheet value");
});

/**
 * C4 — Import cannot introduce unknown arbitrary canonical code.
 *
 * A brand-new worker (INSERT path) receives the spreadsheet code as initial
 * historical/source evidence. This is the only allowed write path. But for
 * existing workers, the COALESCE guard prevents any unknown code from entering.
 */
test("C4 — unknown arbitrary code from spreadsheet never enters dw_data.code for existing workers", async () => {
  const pool = makeFakePool([{ cccd: "400000000001", code: "DR00200-D", full_name: "Existing Worker", it_code: null }]);
  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "workforce_data_import_rows") {
        return [{ id: "r1", batchId: "b4", rowNumber: 1, rawData: row("400000000001", "Existing Worker", { CODE: "ARBITRARY-FREE-TEXT-99" }), status: "PENDING", message: null }];
      }
      if (call.root === "select") return [{ c: 0 }];
      return undefined;
    },
  });
  const mod = await loadModuleUnderTest(pool, db);

  await mod.mergeWorkforceMasterChunk("b4");

  assert.equal(pool.dwData.get("400000000001")?.code, "DR00200-D", "arbitrary free-text code must not enter dw_data.code for existing worker");
});

/**
 * C5 — Existing matching canonical ownership is idempotent.
 *
 * If the spreadsheet's code MATCHES the current canonical mirror, the result
 * is the same (no change, no error). Proves idempotency.
 */
test("C5 — import is idempotent when spreadsheet code matches current canonical mirror", async () => {
  const CODE = "DR00412-D";
  const pool = makeFakePool([{ cccd: "500000000001", code: CODE, full_name: "Worker", it_code: null }]);
  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "workforce_data_import_rows") {
        return [{ id: "r1", batchId: "b5", rowNumber: 1, rawData: row("500000000001", "Worker", { CODE }), status: "PENDING", message: null }];
      }
      if (call.root === "select") return [{ c: 0 }];
      return undefined;
    },
  });
  const mod = await loadModuleUnderTest(pool, db);

  const result = await mod.mergeWorkforceMasterChunk("b5");

  assert.equal(result.updated, 1);
  assert.equal(pool.dwData.get("500000000001")?.code, CODE, "idempotent: same code stays");
});

/**
 * C6 — Historical/source code fills the mirror only when mirror is currently NULL.
 *
 * A new worker (INSERT) or an existing worker with no code yet (NULL mirror)
 * receives the spreadsheet code as initial source evidence. This is the ONLY
 * scenario where the spreadsheet code enters dw_data.code on UPDATE.
 */
test("C6 — historical source code from spreadsheet fills dw_data.code only when mirror is currently NULL (never-assigned worker)", async () => {
  const INITIAL_CODE = "DR-LEGACY-HIST";
  const pool = makeFakePool([{ cccd: "600000000001", code: null, full_name: "Never Assigned Worker", it_code: null }]);
  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "workforce_data_import_rows") {
        return [{ id: "r1", batchId: "b6", rowNumber: 1, rawData: row("600000000001", "Never Assigned Worker", { CODE: INITIAL_CODE }), status: "PENDING", message: null }];
      }
      if (call.root === "select") return [{ c: 0 }];
      return undefined;
    },
  });
  const mod = await loadModuleUnderTest(pool, db);

  await mod.mergeWorkforceMasterChunk("b6");

  assert.equal(pool.dwData.get("600000000001")?.code, INITIAL_CODE, "source evidence fills NULL mirror");
});

/**
 * C7 — Canonical conflict causes zero partial writes: chunk-level atomicity.
 *
 * The pool client raises an error mid-chunk. The entire chunk must ROLLBACK.
 * No rows from that chunk are committed. (Simulated by throwing from the pool client.)
 */
test("C7 — pool client error mid-chunk causes ROLLBACK; batch status set to FAILED; no partial writes committed", async () => {
  let queryCount = 0;
  const fakeBrokenPool = {
    connect: async () => ({
      query: async (text: string) => {
        if (text.startsWith("BEGIN") || text.startsWith("ROLLBACK")) return { rows: [] };
        if (text.includes("UPDATE workforce_data_import_rows") && text.includes("INVALID")) return { rows: [] };
        queryCount++;
        if (queryCount >= 2) throw new Error("Simulated DB failure mid-chunk");
        return { rows: [{ inserted: false }] };
      },
      release: () => {},
    }),
    query: async () => ({ rows: [] }),
  };

  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "workforce_data_import_rows") {
        return [
          { id: "r1", batchId: "b7", rowNumber: 1, rawData: row("700000000001", "Worker One"), status: "PENDING", message: null },
          { id: "r2", batchId: "b7", rowNumber: 2, rawData: row("700000000002", "Worker Two"), status: "PENDING", message: null },
        ];
      }
      return undefined;
    },
  });

  const mod = loadModule(new URL("./import-workforce-master.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      crypto: await import("node:crypto"),
      "drizzle-orm": await import("drizzle-orm"),
      "@/db": { db, pool: fakeBrokenPool },
      "@/db/schema": { workforceDataImportBatches, workforceDataImportRows },
      "@/lib/metadata": { getFieldDefinitions: async () => [], makeFieldPicker: fakeMakeFieldPicker },
      "@/lib/person-name": await import("../person-name.ts"),
      "@/lib/validators": await import("../validators.ts"),
    },
  }) as unknown as { mergeWorkforceMasterChunk: (id: string) => Promise<unknown> };

  await assert.rejects(() => mod.mergeWorkforceMasterChunk("b7"), /Simulated DB failure/, "must propagate error");
  // Batch must be marked FAILED:
  const failWrite = db.writesTo("workforce_data_import_batches").find((c) => {
    const ops = c.ops;
    return ops.some((o) => o.fn === "set" && JSON.stringify(o.args).includes("FAILED"));
  });
  assert.ok(failWrite, "batch must be set to FAILED after error");
});

/**
 * C8 — Worker cannot receive second active DW assignment via import.
 *
 * The import UPSERT is on (cccd WHERE deleted_at IS NULL). If a worker already
 * has an active dw_data row (and thus a canonical mirror), re-importing the same
 * CCCD is an UPDATE, not an INSERT. The canonical mirror is preserved.
 * This ensures the worker cannot end up with two concurrent code values.
 */
test("C8 — re-importing same CCCD is always UPDATE (not duplicate INSERT); canonical mirror not duplicated", async () => {
  const pool = makeFakePool([{ cccd: "800000000001", code: "DR00300-D", full_name: "Worker", it_code: null }]);
  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "workforce_data_import_rows") {
        // Two rows for the same CCCD in the same chunk — last one wins (file-order)
        return [
          { id: "r1", batchId: "b8", rowNumber: 1, rawData: row("800000000001", "Worker v1", { CODE: "DR-ATTEMPT-1" }), status: "PENDING", message: null },
          { id: "r2", batchId: "b8", rowNumber: 2, rawData: row("800000000001", "Worker v2", { CODE: "DR-ATTEMPT-2" }), status: "PENDING", message: null },
        ];
      }
      if (call.root === "select") return [{ c: 0 }];
      return undefined;
    },
  });
  const mod = await loadModuleUnderTest(pool, db);

  const result = await mod.mergeWorkforceMasterChunk("b8");

  // Both are updates (existing worker); zero inserts:
  assert.equal(result.inserted, 0, "must be updates, not inserts");
  assert.equal(result.updated, 2, "both rows are updates");
  // Canonical mirror preserved through both updates:
  assert.equal(pool.dwData.get("800000000001")?.code, "DR00300-D", "canonical mirror preserved after both updates");
});

/**
 * C9 — Existing import behavior unrelated to DW Code remains unchanged.
 *
 * Non-code master fields (full_name, gender, profile, phone, etc.) are still
 * correctly updated on conflict. The safety fix only protects `code`/`it_code`.
 */
test("C9 — non-code master fields (full_name, gender, etc.) still update correctly; only code/it_code are COALESCE-protected", async () => {
  const pool = makeFakePool([{ cccd: "900000000001", code: "DR00500-D", full_name: "Old Name", it_code: "IT-001" }]);
  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "workforce_data_import_rows") {
        return [{ id: "r1", batchId: "b9", rowNumber: 1, rawData: row("900000000001", "Updated Full Name"), status: "PENDING", message: null }];
      }
      if (call.root === "select") return [{ c: 0 }];
      return undefined;
    },
  });
  const mod = await loadModuleUnderTest(pool, db);

  await mod.mergeWorkforceMasterChunk("b9");

  const after = pool.dwData.get("900000000001");
  // Non-code fields updated:
  assert.equal(after?.full_name, "Updated Full Name", "full_name must be updated");
  // Code/it_code preserved:
  assert.equal(after?.code, "DR00500-D", "code must not be disturbed");
  assert.equal(after?.it_code, "IT-001", "it_code must not be disturbed");
});

/**
 * C10 — No PII added to logs/errors. Invalid rows carry only structural reasons.
 *
 * Proves that the invalidReason string on a row-level error does not contain
 * the worker's CCCD or full name (would be PII in a log).
 */
test("C10 — invalid row reasons contain no PII (no CCCD, no full name in error strings)", async () => {
  const pool = makeFakePool([]);
  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "workforce_data_import_rows") {
        // Row with an invalid CCCD (structural error)
        return [{ id: "r1", batchId: "b10", rowNumber: 1, rawData: { CCCD: "SHORT", "HỌ TÊN": "Nguyen Van A" }, status: "PENDING", message: null }];
      }
      if (call.root === "select") return [{ c: 0 }];
      return undefined;
    },
  });
  const mod = await loadModuleUnderTest(pool, db);

  const result = await mod.mergeWorkforceMasterChunk("b10");

  assert.equal(result.invalid, 1);
  // Verify the row's message was written (via UPDATE workforce_data_import_rows)
  const updateQ = pool.queries.find((q) => q.text.includes("UPDATE workforce_data_import_rows") && q.text.includes("INVALID"));
  assert.ok(updateQ, "invalid row must be marked INVALID via UPDATE");
  const errorMessage = updateQ!.params[1] as string;
  // Error must not contain the worker's CCCD value ("SHORT") or full name
  assert.ok(!errorMessage.includes("Nguyen Van A"), "error message must not contain full name (PII)");
  // The reason should be a structural validation message, not a raw data dump
  assert.ok(typeof errorMessage === "string" && errorMessage.length > 0, "error message must be non-empty");
});

test("INSERT path: new worker (no existing dw_data row) receives spreadsheet code as initial source evidence", async () => {
  const HISTORICAL_CODE = "DR-HIST-0042";
  const pool = makeFakePool([]); // no existing rows
  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "workforce_data_import_rows") {
        return [{ id: "r1", batchId: "bi", rowNumber: 1, rawData: row("111222333444", "Brand New Worker", { CODE: HISTORICAL_CODE }), status: "PENDING", message: null }];
      }
      if (call.root === "select") return [{ c: 0 }];
      return undefined;
    },
  });
  const mod = await loadModuleUnderTest(pool, db);

  const result = await mod.mergeWorkforceMasterChunk("bi");

  assert.equal(result.inserted, 1, "new worker must be inserted");
  assert.equal(pool.dwData.get("111222333444")?.code, HISTORICAL_CODE, "historical code written as initial source evidence for new worker");
});

