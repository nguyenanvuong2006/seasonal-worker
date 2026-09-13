/**
 * WORKFORCE DATA MANAGEMENT — import-workforce-master.ts tests (mission
 * test matrix W1-W9, adapted to this system's real identity field: cccd,
 * not the mission's illustrative "workerCode"/"DR0001-D" — see this
 * module's own docblock and scopes.ts's docblock for why).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { loadModule, serverOnlyStub } from "../test-support/load-module.ts";
import { createFakeDb, makeTable, type FakeDb, type QueryCall } from "../test-support/fake-drizzle.ts";

const workforceDataImportBatches = makeTable("workforce_data_import_batches");
const workforceDataImportRows = makeTable("workforce_data_import_rows");

/** In-memory dw_data table for the fake pg client — enough to prove real UPSERT semantics (insert vs update, never touching untouched rows). */
type DwRow = { cccd: string; code: string | null; full_name: string; it_code: string | null };

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
        const cccd = params[9] as string; // 10th positional param, matches the VALUES(...) order in mergeWorkforceMasterChunk
        const existed = dwData.has(cccd);
        dwData.set(cccd, {
          cccd,
          code: params[0] as string | null,
          it_code: existed && dwData.get(cccd)!.it_code && !params[1] ? dwData.get(cccd)!.it_code : (params[1] as string | null),
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

/** Mirrors makeFieldPicker's fallback-legacy-names branch (metadata.ts) for the empty-defs case this test always uses — metadata.ts itself can't be dynamic-imported directly (it has top-level "server-only"/"@/db" imports that only resolve through loadModule's own stub chain). */
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
  assert.ok(result.invalidRows.some((r) => r.reason.includes("Họ tên")));
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
      if (call.root === "select") return [{ c: 0 }]; // no remaining PENDING rows after this chunk
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

test("W3/W4 — merge chunk: existing cccd is UPDATED (master fields change), an untouched existing cccd not present in the file is left completely alone", async () => {
  const pool = makeFakePool([
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
  assert.equal(pool.dwData.get("111111111111")?.full_name, "New Corrected Name");
  assert.equal(pool.dwData.get("111111111111")?.code, "NEW-CODE");
  // W4: a worker simply absent from the file must never be touched/deleted/altered.
  const untouched = pool.dwData.get("999999999999");
  assert.ok(untouched, "worker absent from the file must still exist — never inferred as resigned/deleted");
  assert.equal(untouched?.full_name, "Never In This File");
});

test("computeFileChecksum is deterministic (same content -> same checksum, used for import idempotency)", async () => {
  const pool = makeFakePool([]);
  const db = createFakeDb();
  const mod = await loadModuleUnderTest(pool, db);
  assert.equal(mod.computeFileChecksum("hello"), mod.computeFileChecksum("hello"));
  assert.notEqual(mod.computeFileChecksum("hello"), mod.computeFileChecksum("world"));
});
