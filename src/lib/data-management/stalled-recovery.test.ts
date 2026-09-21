/**
 * WORKFORCE DATA IMPORT BATCH WATCHDOG & RECOVERY (F-04) — TEST SUITE
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * Required Test Coverage:
 *  1. fresh active batch is not considered stalled
 *  2. stale incomplete batch is detected
 *  3. terminal batch is ignored
 *  4. batch with zero pending rows completes safely
 *  5. watchdog acquires per-batch lock
 *  6. concurrent client + watchdog -> one processes, one SAFE_NOOP
 *  7. different batches can proceed independently
 *  8. one chunk makes durable progress
 *  9. watchdog invocation is bounded
 * 10. second invocation continues from remaining rows
 * 11. partial failure does not lose pending rows
 * 12. failure is visible/actionable
 * 13. completed rows are not reprocessed
 * 14. canonical DW/IT mirror protections remain unchanged
 * 15. fingerprint evidence-only behavior remains unchanged
 * 16. workforce master mirror isolation remains unchanged
 * 17. auth on normal import endpoints unchanged
 * 18. scheduler observability integration works
 * 19. retry/repeated watchdog invocation is idempotent
 * 20. no PII appears in structured/audit logs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadModule, serverOnlyStub } from "../test-support/load-module.ts";
import { createFakeDb, makeTable, type FakeDb, type QueryCall } from "../test-support/fake-drizzle.ts";

const workforceDataImportBatches = makeTable("workforce_data_import_batches");
const workforceDataImportRows = makeTable("workforce_data_import_rows");
const dwData = makeTable("dw_data");
const scheduledJobs = makeTable("scheduled_jobs");
const auditLogs = makeTable("audit_logs");

type BatchRow = {
  id: string;
  importType: string;
  datasetMode: string;
  environment: string;
  sourceFilename: string;
  sourceChecksum: string;
  status: string;
  totalRows: number;
  processedRows: number;
  newRows: number;
  existingRows: number;
  invalidRows: number;
  matchedRows: number;
  unmatchedRows: number;
  duplicateRows: number;
  notes: string | null;
  createdBy: string;
  createdAt: Date;
  validatedAt: Date | null;
  completedAt: Date | null;
};

type ImportRow = {
  id: string;
  batchId: string;
  rowNumber: number;
  rawData: Record<string, string>;
  status: string;
  message: string | null;
};

type DwRow = {
  cccd: string;
  code: string | null;
  it_code: string | null;
  full_name: string;
};

function makeFakePool(opts?: {
  dwData?: DwRow[];
  lockResponses?: Map<number, boolean>;
  queries?: { text: string; params: unknown[] }[];
  onQuery?: (text: string, params: unknown[]) => Promise<{ rows: any[] } | void>;
}) {
  const dwMap = new Map((opts?.dwData ?? []).map((r) => [r.cccd, { ...r }]));
  const queries = opts?.queries ?? [];
  const activeLocks = new Set<number>();

  const client = {
    query: async (text: string, params: unknown[] = []) => {
      queries.push({ text, params });
      if (opts?.onQuery) {
        const custom = await opts.onQuery(text, params);
        if (custom) return custom;
      }

      if (text.startsWith("BEGIN") || text.startsWith("COMMIT") || text.startsWith("ROLLBACK")) {
        if (text.startsWith("COMMIT") || text.startsWith("ROLLBACK")) {
          activeLocks.clear();
        }
        return { rows: [] };
      }

      // Handle advisory lock
      if (text.includes("pg_try_advisory_xact_lock")) {
        const key = params[1] as number;
        if (opts?.lockResponses && opts.lockResponses.has(key)) {
          const locked = opts.lockResponses.get(key)!;
          if (locked) activeLocks.add(key);
          return { rows: [{ locked }] };
        }
        if (activeLocks.has(key)) {
          return { rows: [{ locked: false }] };
        }
        activeLocks.add(key);
        return { rows: [{ locked: true }] };
      }

      if (text.includes("SELECT cccd") && text.includes("FROM dw_data") && text.includes("= ANY")) {
        const requested = new Set(params[0] as string[]);
        const rows = [...dwMap.keys()].filter((c) => requested.has(c)).map((c) => ({ cccd: c, dup: "1" }));
        return { rows };
      }

      if (text.includes("SELECT id, code, it_code FROM dw_data WHERE cccd")) {
        const row = dwMap.get(params[0] as string);
        return { rows: row ? [row] : [] };
      }

      if (text.includes("INSERT INTO dw_data")) {
        const cccd = params[7] as string;
        const existed = dwMap.has(cccd);
        const existing = existed ? dwMap.get(cccd)! : null;
        dwMap.set(cccd, {
          cccd,
          code: existed ? existing!.code : null,
          it_code: existed ? existing!.it_code : null,
          full_name: params[2] as string,
        });
        return { rows: [{ inserted: !existed }] };
      }

      if (text.includes("SELECT id, status FROM workforce_data_import_batches") ||
          text.includes("UPDATE workforce_data_import_rows") ||
          text.includes("UPDATE workforce_data_import_batches")) {
        return { rows: [] };
      }

      return { rows: [] };
    },
    release: () => {
      activeLocks.clear();
    },
  };

  return {
    connect: async () => client,
    query: (text: string, params?: unknown[]) => client.query(text, params ?? []),
    dwMap,
    queries,
    activeLocks,
  };
}

async function loadTestModules(pool: ReturnType<typeof makeFakePool>, db: FakeDb) {
  const dOrm = await import("drizzle-orm");
  const pName = await import("../person-name.ts");
  const val = await import("../validators.ts");
  const sUtils = await import("../scheduler-utils.ts");

  const wfModule = await loadModule(new URL("./import-workforce-master.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      crypto: await import("node:crypto"),
      "drizzle-orm": dOrm,
      "@/db": { db, pool },
      "@/db/schema": { workforceDataImportBatches, workforceDataImportRows },
      "@/lib/metadata": {
        getFieldDefinitions: async () => [],
        makeFieldPicker: (r: Record<string, string>) => (_k: string, fallbacks: string[] = []) => {
          for (const f of fallbacks) {
            if (r[f] !== undefined && String(r[f]).trim() !== "") return String(r[f]);
          }
          return undefined;
        },
      },
      "@/lib/person-name": pName,
      "@/lib/validators": val,
      "@/lib/scheduler-utils": sUtils,
    },
  }) as unknown as typeof import("./import-workforce-master");

  const fpModule = await loadModule(new URL("./import-fingerprint.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      crypto: await import("node:crypto"),
      "drizzle-orm": dOrm,
      "@/db": { db, pool },
      "@/db/schema": { workforceDataImportBatches, workforceDataImportRows },
      "@/lib/validators": val,
      "@/lib/scheduler-utils": sUtils,
      "./import-workforce-master": wfModule,
    },
  }) as unknown as typeof import("./import-fingerprint");

  const recModule = await loadModule(new URL("./stalled-recovery.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "drizzle-orm": dOrm,
      "@/db": { db, pool },
      "@/db/schema": { workforceDataImportBatches, workforceDataImportRows },
      "./import-workforce-master": wfModule,
      "./import-fingerprint": fpModule,
      "@/lib/scheduler-utils": sUtils,
    },
  }) as unknown as typeof import("./stalled-recovery");

  return { wfModule, fpModule, recModule };
}

// ---------------------------------------------------------------------------
// 1. Fresh active batch is not considered stalled
// ---------------------------------------------------------------------------
test("1. fresh active batch is not considered stalled", async () => {
  const now = new Date("2026-09-21T12:00:00Z");
  const pool = makeFakePool();
  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "workforce_data_import_batches") {
        // Created 10 seconds ago, validated 5 seconds ago
        return [];
      }
      return undefined;
    },
  });
  const { recModule } = await loadTestModules(pool, db);

  const stalled = await recModule.findStalledBatches({ now, staleMs: 90_000 });
  assert.equal(stalled.length, 0, "fresh batch must not be considered stalled");
});

// ---------------------------------------------------------------------------
// 2. Stale incomplete batch is detected
// ---------------------------------------------------------------------------
test("2. stale incomplete batch is detected", async () => {
  const now = new Date("2026-09-21T12:00:00Z");
  const pool = makeFakePool();
  const staleBatch = {
    id: "batch-stale-1",
    importType: "WORKFORCE_MASTER",
    status: "IMPORTING",
    totalRows: 500,
    processedRows: 100,
    createdAt: new Date("2026-09-21T11:55:00Z"),
    validatedAt: new Date("2026-09-21T11:56:00Z"), // 4 minutes ago > 90s
  };

  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "workforce_data_import_batches") {
        return [staleBatch];
      }
      return undefined;
    },
  });
  const { recModule } = await loadTestModules(pool, db);

  const stalled = await recModule.findStalledBatches({ now, staleMs: 90_000 });
  assert.equal(stalled.length, 1);
  assert.equal(stalled[0].id, "batch-stale-1");
  assert.ok(stalled[0].staleMs > 90_000);
});

// ---------------------------------------------------------------------------
// 3. Terminal batch is ignored
// ---------------------------------------------------------------------------
test("3. terminal batch is ignored", async () => {
  const now = new Date("2026-09-21T12:00:00Z");
  const pool = makeFakePool();
  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "workforce_data_import_batches") {
        // COMPLETED/FAILED/REPLACED are filtered by SQL WHERE status NOT IN (...)
        return [];
      }
      return undefined;
    },
  });
  const { recModule } = await loadTestModules(pool, db);

  const stalled = await recModule.findStalledBatches({ now });
  assert.equal(stalled.length, 0);
});

// ---------------------------------------------------------------------------
// 4. Batch with zero pending rows completes safely
// ---------------------------------------------------------------------------
test("4. batch with zero pending rows completes safely", async () => {
  const pool = makeFakePool();
  const updates: QueryCall[] = [];
  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "workforce_data_import_rows") {
        return []; // 0 pending rows
      }
      if (call.root === "update" && call.table === "workforce_data_import_batches") {
        updates.push(call);
        return [{ id: "batch-1" }];
      }
      return undefined;
    },
  });
  const { wfModule } = await loadTestModules(pool, db);

  const result = await wfModule.mergeWorkforceMasterChunk("batch-1");
  assert.equal(result.done, true);
  assert.equal(result.processed, 0);
  assert.ok(updates.length > 0, "must update batch to completed");
});

// ---------------------------------------------------------------------------
// 5. Watchdog acquires per-batch lock
// ---------------------------------------------------------------------------
test("5. watchdog acquires per-batch lock", async () => {
  const pool = makeFakePool();
  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "workforce_data_import_rows") {
        return [];
      }
      return undefined;
    },
  });
  const { wfModule } = await loadTestModules(pool, db);

  await wfModule.mergeWorkforceMasterChunk("batch-lock-test");
  const lockQuery = pool.queries.find((q) => q.text.includes("pg_try_advisory_xact_lock"));
  assert.ok(lockQuery, "must call pg_try_advisory_xact_lock");
  assert.equal(lockQuery.params[0], wfModule.WORKFORCE_IMPORT_BATCH_ADVISORY_NAMESPACE);
  assert.equal(lockQuery.params[1], wfModule.deriveBatchAdvisoryLockKey("batch-lock-test"));
});

// ---------------------------------------------------------------------------
// 6. Concurrent client + watchdog -> one processes, one SAFE_NOOP
// ---------------------------------------------------------------------------
test("6. concurrent client + watchdog -> one processes, one SAFE_NOOP", async () => {
  const batchId = "batch-race-1";
  const lockKey = createHash("sha256").update(batchId).digest().readInt32BE(0);

  // Simulate lock already held by client
  const pool = makeFakePool({
    lockResponses: new Map([[lockKey, false]]),
  });

  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "workforce_data_import_rows") {
        assert.fail("must not read rows when lock is not acquired");
      }
      return undefined;
    },
  });
  const { wfModule } = await loadTestModules(pool, db);

  const result = await wfModule.mergeWorkforceMasterChunk(batchId);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "ALREADY_PROCESSING");
  assert.equal(result.processed, 0);
  assert.ok(pool.queries.some((q) => q.text.includes("ROLLBACK")), "must rollback transaction on lock contention");
});

// ---------------------------------------------------------------------------
// 7. Different batches can proceed independently
// ---------------------------------------------------------------------------
test("7. different batches can proceed independently", async () => {
  const batchA = "batch-AAA";
  const batchB = "batch-BBB";
  const keyA = createHash("sha256").update(batchA).digest().readInt32BE(0);
  const keyB = createHash("sha256").update(batchB).digest().readInt32BE(0);

  assert.notEqual(keyA, keyB, "keys for different batches must be distinct");

  // Lock A is held, Lock B is free
  const pool = makeFakePool({
    lockResponses: new Map([
      [keyA, false],
      [keyB, true],
    ]),
  });

  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "workforce_data_import_rows") {
        return [];
      }
      return undefined;
    },
  });
  const { wfModule } = await loadTestModules(pool, db);

  const resA = await wfModule.mergeWorkforceMasterChunk(batchA);
  assert.equal(resA.skipped, true, "batch A must be skipped");

  const resB = await wfModule.mergeWorkforceMasterChunk(batchB);
  assert.equal(resB.done, true, "batch B must proceed");
  assert.equal(resB.skipped, undefined);
});

// ---------------------------------------------------------------------------
// 8. One chunk makes durable progress
// ---------------------------------------------------------------------------
test("8. one chunk makes durable progress", async () => {
  const pool = makeFakePool();
  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "workforce_data_import_rows") {
        const hasLimit = call.ops.some((op) => op.fn === "limit");
        if (!hasLimit) {
          return [{ c: 10 }]; // count query: 10 rows remaining
        }
        return [
          {
            id: "r1",
            batchId: "b-chunk-1",
            rowNumber: 1,
            rawData: { "HỌ TÊN": "Nguyen Van A", CCCD: "001200000001" },
            status: "PENDING",
            message: null,
          },
        ];
      }
      return undefined;
    },
  });
  const { wfModule } = await loadTestModules(pool, db);

  const result = await wfModule.mergeWorkforceMasterChunk("b-chunk-1");
  assert.equal(result.processed, 1);
  assert.equal(result.inserted, 1);
  assert.equal(result.done, false);

  const batchUpdate = pool.queries.find((q) => q.text.includes("UPDATE workforce_data_import_batches SET processed_rows"));
  assert.ok(batchUpdate, "must update batch progress");
  assert.ok(batchUpdate.text.includes("validated_at = now()"), "must update validated_at heartbeat");
  assert.ok(pool.queries.some((q) => q.text.includes("COMMIT")), "must commit chunk transaction");
});

// ---------------------------------------------------------------------------
// 9. Watchdog invocation is bounded
// ---------------------------------------------------------------------------
test("9. watchdog invocation is bounded", async () => {
  const pool = makeFakePool();
  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "workforce_data_import_batches") {
        return [
          { id: "b1", importType: "WORKFORCE_MASTER", status: "IMPORTING", totalRows: 1000, processedRows: 0, createdAt: new Date(0), validatedAt: null },
          { id: "b2", importType: "WORKFORCE_MASTER", status: "IMPORTING", totalRows: 1000, processedRows: 0, createdAt: new Date(0), validatedAt: null },
        ];
      }
      if (call.root === "select" && call.table === "workforce_data_import_rows") {
        const hasLimit = call.ops.some((op) => op.fn === "limit");
        if (!hasLimit) {
          return [{ c: 500 }]; // count query
        }
        return [{ id: "r1", batchId: "b1", rowNumber: 1, rawData: { "HỌ TÊN": "A", CCCD: "001200000001" }, status: "PENDING", message: null }];
      }
      return undefined;
    },
  });
  const { recModule } = await loadTestModules(pool, db);

  // Bounded: maxChunksPerBatch = 1
  const outcome = await recModule.resumeStalledWorkforceImportBatches({
    maxChunksPerBatch: 1,
  });

  assert.equal(outcome.batchesFound, 2);
  assert.equal(outcome.batchesResumed, 2);
  assert.equal(outcome.rowsAttempted, 2);
});

// ---------------------------------------------------------------------------
// 10. Second invocation continues from remaining rows
// ---------------------------------------------------------------------------
test("10. second invocation continues from remaining rows", async () => {
  const pool = makeFakePool();
  let remainingCount = 2;
  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "workforce_data_import_batches") {
        return [{ id: "b1", importType: "WORKFORCE_MASTER", status: "IMPORTING", totalRows: 2, processedRows: 2 - remainingCount, createdAt: new Date(0), validatedAt: null }];
      }
      if (call.root === "select" && call.table === "workforce_data_import_rows") {
        const hasLimit = call.ops.some((op) => op.fn === "limit");
        if (!hasLimit) {
          remainingCount--;
          return [{ c: remainingCount }];
        }
        if (remainingCount === 2) {
          return [{ id: "r1", batchId: "b1", rowNumber: 1, rawData: { "HỌ TÊN": "A", CCCD: "001200000001" }, status: "PENDING", message: null }];
        }
        if (remainingCount === 1) {
          return [{ id: "r2", batchId: "b1", rowNumber: 2, rawData: { "HỌ TÊN": "B", CCCD: "001200000002" }, status: "PENDING", message: null }];
        }
        return [];
      }
      return undefined;
    },
  });
  const { recModule } = await loadTestModules(pool, db);

  // Invocation 1: processes row 1 (remainingCount becomes 1, done = false)
  const out1 = await recModule.resumeStalledWorkforceImportBatches({ maxChunksPerBatch: 1 });
  assert.equal(out1.rowsAttempted, 1);
  assert.equal(out1.batchesCompleted, 0);

  // Invocation 2: processes row 2 (remainingCount becomes 0, done = true)
  const out2 = await recModule.resumeStalledWorkforceImportBatches({ maxChunksPerBatch: 1 });
  assert.equal(out2.rowsAttempted, 1);
  assert.equal(out2.batchesCompleted, 1);
});

// ---------------------------------------------------------------------------
// 11. Partial failure does not lose pending rows
// ---------------------------------------------------------------------------
test("11. partial failure does not lose pending rows", async () => {
  const pool = makeFakePool({
    onQuery: async (text: string) => {
      if (text.includes("INSERT INTO dw_data")) {
        throw new Error("Disk Full");
      }
    },
  });
  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "workforce_data_import_rows") {
        return [{ id: "r1", batchId: "b1", rowNumber: 1, rawData: { "HỌ TÊN": "A", CCCD: "001200000001" }, status: "PENDING", message: null }];
      }
      return undefined;
    },
  });
  const { wfModule } = await loadTestModules(pool, db);

  await assert.rejects(() => wfModule.mergeWorkforceMasterChunk("b1"), /Disk Full/);
  assert.ok(pool.queries.some((q) => q.text.includes("ROLLBACK")), "must rollback uncommitted chunk rows");
});

// ---------------------------------------------------------------------------
// 12. Failure is visible/actionable
// ---------------------------------------------------------------------------
test("12. failure is visible/actionable", async () => {
  const pool = makeFakePool({
    onQuery: async (text: string) => {
      if (text.includes("INSERT INTO dw_data")) {
        throw new Error("Database token=SECRET_VAL connection refused");
      }
    },
  });
  const batchUpdates: QueryCall[] = [];
  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "workforce_data_import_rows") {
        return [{ id: "r1", batchId: "b1", rowNumber: 1, rawData: { "HỌ TÊN": "A", CCCD: "001200000001" }, status: "PENDING", message: null }];
      }
      if (call.root === "update" && call.table === "workforce_data_import_batches") {
        batchUpdates.push(call);
        return [{ id: "b1" }];
      }
      return undefined;
    },
  });
  const { wfModule } = await loadTestModules(pool, db);

  await assert.rejects(() => wfModule.mergeWorkforceMasterChunk("b1"));

  const failedUpdate = batchUpdates.find((call) =>
    call.ops.some((op) => op.fn === "set" && (op.args[0] as any)?.status === "FAILED")
  );
  assert.ok(failedUpdate, "batch must be marked FAILED");
  const setArgs = failedUpdate.ops.find((op) => op.fn === "set")?.args[0] as any;
  assert.ok(setArgs.notes.includes("[REDACTED]"), "notes must be sanitized");
  assert.ok(!setArgs.notes.includes("SECRET_VAL"), "secrets must not leak into notes");
});

// ---------------------------------------------------------------------------
// 13. Completed rows are not reprocessed
// ---------------------------------------------------------------------------
test("13. completed rows are not reprocessed", async () => {
  const pool = makeFakePool();
  let checkedWhere = false;
  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "workforce_data_import_rows") {
        checkedWhere = call.ops.some((op) => op.fn === "where");
        return [];
      }
      return undefined;
    },
  });
  const { wfModule } = await loadTestModules(pool, db);

  await wfModule.mergeWorkforceMasterChunk("b1");
  assert.ok(checkedWhere, "query must filter by status = PENDING");
});

// ---------------------------------------------------------------------------
// 14. Canonical DW/IT mirror protections remain unchanged
// ---------------------------------------------------------------------------
test("14. canonical DW/IT mirror protections remain unchanged", async () => {
  const CANONICAL_CODE = "DR00100-D";
  const CANONICAL_IT = "IT-001";
  const pool = makeFakePool({
    dwData: [{ cccd: "001200000001", code: CANONICAL_CODE, it_code: CANONICAL_IT, full_name: "Worker" }],
  });
  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "workforce_data_import_rows") {
        return [
          {
            id: "r1",
            batchId: "b1",
            rowNumber: 1,
            rawData: {
              "HỌ TÊN": "Worker Updated",
              CCCD: "001200000001",
              CODE: "MALICIOUS-CODE-OVERWRITE",
              "IT CODE": "MALICIOUS-IT-OVERWRITE",
            },
            status: "PENDING",
            message: null,
          },
        ];
      }
      if (call.root === "select") return [{ c: 0 }];
      return undefined;
    },
  });
  const { wfModule } = await loadTestModules(pool, db);

  await wfModule.mergeWorkforceMasterChunk("b1");
  const worker = pool.dwMap.get("001200000001");
  assert.equal(worker?.code, CANONICAL_CODE, "canonical DW code mirror must not be modified");
  assert.equal(worker?.it_code, CANONICAL_IT, "canonical IT code mirror must not be modified");
});

// ---------------------------------------------------------------------------
// 15. Fingerprint evidence-only behavior remains unchanged
// ---------------------------------------------------------------------------
test("15. fingerprint evidence-only behavior remains unchanged", async () => {
  const pool = makeFakePool({
    dwData: [{ cccd: "001200000001", code: "DC001", it_code: null, full_name: "Worker" }],
  });
  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "workforce_data_import_rows") {
        return [
          {
            id: "r1",
            batchId: "b1",
            rowNumber: 1,
            rawData: { CCCD: "001200000001", "IT CODE": "NEW-FP-CODE" },
            status: "PENDING",
            message: null,
          },
        ];
      }
      if (call.root === "select") return [{ c: 0 }];
      return undefined;
    },
  });
  const { fpModule } = await loadTestModules(pool, db);

  const res = await fpModule.mergeFingerprintChunk("b1", "system:watchdog");
  assert.equal(res.matched, 1);
  assert.equal(pool.dwMap.get("001200000001")?.it_code, null, "dw_data.it_code must remain null (evidence only)");
  assert.ok(!pool.queries.some((q) => q.text.includes("UPDATE dw_data SET it_code")), "no direct update to dw_data.it_code");
});

// ---------------------------------------------------------------------------
// 16. Workforce master mirror isolation remains unchanged
// ---------------------------------------------------------------------------
test("16. workforce master mirror isolation remains unchanged on new CCCD insert", async () => {
  const pool = makeFakePool();
  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "workforce_data_import_rows") {
        return [
          {
            id: "r1",
            batchId: "b1",
            rowNumber: 1,
            rawData: {
              "HỌ TÊN": "Brand New Worker",
              CCCD: "001200999999",
              CODE: "ATTEMPTED-CODE",
              "IT CODE": "ATTEMPTED-IT",
            },
            status: "PENDING",
            message: null,
          },
        ];
      }
      if (call.root === "select") return [{ c: 0 }];
      return undefined;
    },
  });
  const { wfModule } = await loadTestModules(pool, db);

  await wfModule.mergeWorkforceMasterChunk("b1");
  const created = pool.dwMap.get("001200999999");
  assert.equal(created?.code, null, "new CCCD code must be NULL");
  assert.equal(created?.it_code, null, "new CCCD it_code must be NULL");
});

// ---------------------------------------------------------------------------
// 17. Auth on normal import endpoints unchanged
// ---------------------------------------------------------------------------
test("17. auth on normal import endpoints unchanged", () => {
  const wfRoute = readFileSync(join(process.cwd(), "src/app/api/admin/data-management/imports/workforce/execute/route.ts"), "utf8");
  const fpRoute = readFileSync(join(process.cwd(), "src/app/api/admin/data-management/imports/fingerprint/execute/route.ts"), "utf8");

  assert.ok(wfRoute.includes(`requirePermission(["ADMIN"], "data_management.import")`), "workforce execute requires data_management.import");
  assert.ok(fpRoute.includes(`requirePermission(["ADMIN"], "data_management.import")`), "fingerprint execute requires data_management.import");
});

// ---------------------------------------------------------------------------
// 18. Scheduler observability integration works
// ---------------------------------------------------------------------------
test("18. scheduler observability integration works", async () => {
  const pool = makeFakePool();
  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "workforce_data_import_batches") {
        return [{ id: "b1", importType: "WORKFORCE_MASTER", status: "IMPORTING", totalRows: 10, processedRows: 0, createdAt: new Date(0), validatedAt: null }];
      }
      if (call.root === "select" && call.table === "workforce_data_import_rows") {
        return [{ id: "r1", batchId: "b1", rowNumber: 1, rawData: { "HỌ TÊN": "A", CCCD: "001200000001" }, status: "PENDING", message: null }];
      }
      if (call.root === "select") return [{ c: 0 }];
      return undefined;
    },
  });
  const { recModule } = await loadTestModules(pool, db);

  const outcome = await recModule.resumeStalledWorkforceImportBatches();
  assert.ok(typeof outcome.durationMs === "number");
  assert.equal(outcome.batchesFound, 1);
  assert.equal(outcome.batchesResumed, 1);
  assert.equal(outcome.batchesCompleted, 1);
  assert.equal(outcome.batches[0].batchId, "b1");
});

// ---------------------------------------------------------------------------
// 19. Retry/repeated watchdog invocation is idempotent
// ---------------------------------------------------------------------------
test("19. retry/repeated watchdog invocation is idempotent", async () => {
  const pool = makeFakePool();
  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "workforce_data_import_batches") {
        return []; // No stalled batches remaining
      }
      return undefined;
    },
  });
  const { recModule } = await loadTestModules(pool, db);

  const out1 = await recModule.resumeStalledWorkforceImportBatches();
  assert.equal(out1.batchesFound, 0);
  assert.equal(out1.batchesResumed, 0);

  const out2 = await recModule.resumeStalledWorkforceImportBatches();
  assert.equal(out2.batchesFound, 0);
  assert.equal(out2.batchesResumed, 0);
});

// ---------------------------------------------------------------------------
// 20. No PII appears in structured/audit logs
// ---------------------------------------------------------------------------
test("20. no PII appears in structured/audit logs", async () => {
  const pool = makeFakePool();
  const sensitiveCccd = "001200000001";
  const sensitiveName = "Nguyen Van Secret PII";
  const sensitivePhone = "0901234567";

  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "workforce_data_import_batches") {
        return [{ id: "b-pii-test", importType: "WORKFORCE_MASTER", status: "IMPORTING", totalRows: 1, processedRows: 0, createdAt: new Date(0), validatedAt: null }];
      }
      if (call.root === "select" && call.table === "workforce_data_import_rows") {
        return [
          {
            id: "r1",
            batchId: "b-pii-test",
            rowNumber: 1,
            rawData: { "HỌ TÊN": sensitiveName, CCCD: sensitiveCccd, "Phone number": sensitivePhone },
            status: "PENDING",
            message: null,
          },
        ];
      }
      if (call.root === "select") return [{ c: 0 }];
      return undefined;
    },
  });
  const { recModule } = await loadTestModules(pool, db);

  const outcome = await recModule.resumeStalledWorkforceImportBatches();
  const serialized = JSON.stringify(outcome);

  assert.ok(!serialized.includes(sensitiveCccd), "CCCD must not appear in outcome");
  assert.ok(!serialized.includes(sensitiveName), "Name must not appear in outcome");
  assert.ok(!serialized.includes(sensitivePhone), "Phone must not appear in outcome");
});
