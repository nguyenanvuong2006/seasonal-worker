/**
 * WORKFORCE DATA MANAGEMENT — import-fingerprint.ts tests (mission test
 * matrix F1-F5, F8-F9). "IT Code" reconciliation is by cccd only (mission
 * section 20's prohibition on name/row-number/phone matching) — see this
 * module's own docblock.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { loadModule, serverOnlyStub } from "../test-support/load-module.ts";
import { createFakeDb, makeTable, type FakeDb, type QueryCall } from "../test-support/fake-drizzle.ts";

const workforceDataImportBatches = makeTable("workforce_data_import_batches");
const workforceDataImportRows = makeTable("workforce_data_import_rows");

type DwRow = { id: string; cccd: string; code: string | null; it_code: string | null };

function makeFakePool(
  initialDwData: DwRow[],
  interceptor?: (text: string, params: unknown[]) => Promise<{ rows: any[] } | void>
) {
  const dwData = new Map(initialDwData.map((r) => [r.cccd, { ...r }]));
  const workerProfileUpdates: { cccd: string; itCode: string }[] = [];
  const queries: { text: string; params: unknown[] }[] = [];

  const handleQuery = async (text: string, params: unknown[] = []) => {
    queries.push({ text, params });
    if (interceptor) {
      const intercepted = await interceptor(text, params);
      if (intercepted) return intercepted;
    }
    if (text.startsWith("BEGIN") || text.startsWith("COMMIT") || text.startsWith("ROLLBACK")) return { rows: [] };
    if (text.includes("SELECT cccd, code, it_code FROM dw_data") && text.includes("= ANY")) {
      const requested = new Set(params[0] as string[]);
      const rows = [...dwData.values()].filter((r) => requested.has(r.cccd));
      return { rows };
    }
    if (text.includes("SELECT id, code, it_code FROM dw_data WHERE cccd")) {
      const row = dwData.get(params[0] as string);
      return { rows: row ? [row] : [] };
    }
    if (text.includes("UPDATE dw_data SET it_code")) {
      const [id, itCode] = params as [string, string, string];
      for (const [cccd, row] of dwData) {
        if (row.id === id) dwData.set(cccd, { ...row, it_code: itCode });
      }
      return { rows: [] };
    }
    if (text.includes("UPDATE worker_profiles SET fingerprint_code")) {
      const [cccd, itCode] = params as [string, string];
      workerProfileUpdates.push({ cccd, itCode });
      return { rows: [] };
    }
    if (text.includes("UPDATE daily_applications SET it_code")) return { rows: [] };
    if (text.includes("UPDATE workforce_data_import_rows") || text.includes("UPDATE workforce_data_import_batches")) return { rows: [] };
    return { rows: [] };
  };

  const client = {
    query: handleQuery,
    release: () => {},
  };
  return { connect: async () => client, dwData, workerProfileUpdates, queries, query: handleQuery };
}

async function loadModuleUnderTest(pool: ReturnType<typeof makeFakePool>, db: FakeDb) {
  return loadModule(new URL("./import-fingerprint.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      crypto: await import("node:crypto"),
      "drizzle-orm": await import("drizzle-orm"),
      "@/db": { db, pool },
      "@/db/schema": { workforceDataImportBatches, workforceDataImportRows },
      "@/lib/validators": await import("../validators.ts"),
    },
  }) as unknown as {
    dryRunFingerprint: (rows: Record<string, string>[]) => Promise<{
      total: number;
      matched: number;
      unmatched: number;
      duplicateWorker: number;
      duplicateFingerprint: number;
      invalidCode: number;
      rows: { rowNumber: number; cccd: string | null; status: string; reason: string | null }[];
    }>;
    mergeFingerprintChunk: (batchId: string, actor: string) => Promise<{ processed: number; matched: number; unmatched: number; duplicate: number; done: boolean }>;
  };
}

function row(cccd: string, itCode: string): Record<string, string> {
  return { CCCD: cccd, "IT CODE": itCode };
}

test("F1 — exact CCCD match against dw_data (already has Mã số công nhật) -> MATCHED", async () => {
  const pool = makeFakePool([{ id: "dw-1", cccd: "111111111111", code: "DC001", it_code: null }]);
  const db = createFakeDb();
  const mod = await loadModuleUnderTest(pool, db);

  const result = await mod.dryRunFingerprint([row("111111111111", "IT-999")]);
  assert.equal(result.matched, 1);
  assert.equal(result.rows[0].status, "MATCHED");
});

test("F2 — CCCD with surrounding whitespace is normalized before matching", async () => {
  const pool = makeFakePool([{ id: "dw-1", cccd: "111111111111", code: "DC001", it_code: null }]);
  const db = createFakeDb();
  const mod = await loadModuleUnderTest(pool, db);

  const result = await mod.dryRunFingerprint([{ CCCD: "  111111111111  ", "IT CODE": "IT-999" }]);
  assert.equal(result.matched, 1);
});

test("F3 — UNMATCHED: no dw_data row for that CCCD, and separately, a dw_data row that exists but has no Mã số công nhật yet", async () => {
  const pool = makeFakePool([{ id: "dw-1", cccd: "222222222222", code: null, it_code: null }]);
  const db = createFakeDb();
  const mod = await loadModuleUnderTest(pool, db);

  const result = await mod.dryRunFingerprint([row("111111111111", "IT-1"), row("222222222222", "IT-2")]);
  assert.equal(result.unmatched, 2);
  assert.ok(result.rows[0].reason?.includes("Không tìm thấy"));
  assert.ok(result.rows[1].reason?.includes("Mã số công nhật"));
});

test("F4 — DUPLICATE_WORKER: same CCCD appears twice in the file", async () => {
  const pool = makeFakePool([{ id: "dw-1", cccd: "111111111111", code: "DC001", it_code: null }]);
  const db = createFakeDb();
  const mod = await loadModuleUnderTest(pool, db);

  const result = await mod.dryRunFingerprint([row("111111111111", "IT-1"), row("111111111111", "IT-2")]);
  assert.equal(result.duplicateWorker, 2);
});

test("F5 — DUPLICATE_FINGERPRINT: same IT Code assigned to two different CCCDs in the file", async () => {
  const pool = makeFakePool([
    { id: "dw-1", cccd: "111111111111", code: "DC001", it_code: null },
    { id: "dw-2", cccd: "222222222222", code: "DC002", it_code: null },
  ]);
  const db = createFakeDb();
  const mod = await loadModuleUnderTest(pool, db);

  const result = await mod.dryRunFingerprint([row("111111111111", "SAME-CODE"), row("222222222222", "SAME-CODE")]);
  assert.equal(result.duplicateFingerprint, 2);
});

test("F5b — DUPLICATE_FINGERPRINT: file's IT Code conflicts with a DIFFERENT code already on that worker in dw_data", async () => {
  const pool = makeFakePool([{ id: "dw-1", cccd: "111111111111", code: "DC001", it_code: "OLD-CODE" }]);
  const db = createFakeDb();
  const mod = await loadModuleUnderTest(pool, db);

  const result = await mod.dryRunFingerprint([row("111111111111", "NEW-CODE")]);
  assert.equal(result.duplicateFingerprint, 1);
});

test("merge: MATCHED row is isolated from dw_data.it_code — preserves current mirror and raw staging evidence only", async () => {
  const pool = makeFakePool([{ id: "dw-1", cccd: "111111111111", code: "DC001", it_code: null }]);
  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "workforce_data_import_rows") {
        return [{ id: "row-1", batchId: "batch-1", rowNumber: 1, rawData: row("111111111111", "NEW-IT-CODE"), status: "PENDING", message: null }];
      }
      if (call.root === "select") return [{ c: 0 }];
      return undefined;
    },
  });
  const mod = await loadModuleUnderTest(pool, db);

  const result = await mod.mergeFingerprintChunk("batch-1", "fp_staff_1");
  assert.equal(result.matched, 1);
  // Current mirror in dw_data MUST NOT be populated from fingerprint import (Option A: evidence only)
  assert.equal(pool.dwData.get("111111111111")?.it_code, null, "dw_data.it_code must remain untouched");
  assert.equal(pool.workerProfileUpdates.length, 0, "worker_profiles.fingerprint_code must not be directly updated");

  // No raw UPDATE dw_data SET it_code in executed queries
  assert.ok(
    pool.queries.every((q) => !q.text.includes("UPDATE dw_data SET it_code")),
    "must never execute raw UPDATE dw_data SET it_code"
  );
  // F8 — fingerprint import must never create/reference Employment.
  assert.ok(pool.queries.every((q) => !q.text.includes("employment_sessions")), "fingerprint merge must never touch employment_sessions");
});

test("merge: conflicting IT code fails closed as DUPLICATE and preserves current mirror", async () => {
  const pool = makeFakePool([{ id: "dw-1", cccd: "111111111111", code: "DC001", it_code: "EXISTING-IT-CODE" }]);
  const rowUpdates: { id: string; status: string; message?: string }[] = [];
  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "workforce_data_import_rows") {
        return [{ id: "row-1", batchId: "batch-1", rowNumber: 1, rawData: row("111111111111", "DIFFERENT-IT-CODE"), status: "PENDING", message: null }];
      }
      if (call.root === "select") return [{ c: 0 }];
      return undefined;
    },
  });
  const mod = await loadModuleUnderTest(pool, db);

  const result = await mod.mergeFingerprintChunk("batch-1", "fp_staff_1");
  assert.equal(result.duplicate, 1);
  assert.equal(result.matched, 0);
  assert.equal(pool.dwData.get("111111111111")?.it_code, "EXISTING-IT-CODE", "existing IT code is untouched");
});

test("merge: database error rolls back transaction and marks batch FAILED", async () => {
  const pool = makeFakePool(
    [{ id: "dw-1", cccd: "111111111111", code: "DC001", it_code: null }],
    async (text: string) => {
      if (text.includes("UPDATE workforce_data_import_rows SET status = 'MATCHED'")) {
        throw new Error("DB Connection Lost");
      }
    }
  );

  const batchUpdates: any[] = [];
  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "workforce_data_import_rows") {
        return [{ id: "row-1", batchId: "batch-1", rowNumber: 1, rawData: row("111111111111", "NEW-IT-CODE"), status: "PENDING", message: null }];
      }
      if (call.root === "update" && call.table === "workforce_data_import_batches") {
        batchUpdates.push(call);
        return [{ id: "batch-1" }];
      }
      return undefined;
    },
  });
  const mod = await loadModuleUnderTest(pool, db);

  await assert.rejects(
    () => mod.mergeFingerprintChunk("batch-1", "fp_staff_1"),
    /DB Connection Lost/
  );
  assert.ok(pool.queries.some((q) => q.text.includes("ROLLBACK")), "must execute ROLLBACK on error");
});

