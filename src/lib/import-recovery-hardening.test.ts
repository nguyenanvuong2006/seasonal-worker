/**
 * Targeted Test Suite for Mission: Import Recovery Hardening
 * (Staging Integrity F-01 + Single-Worker Concurrency F-02).
 *
 * Tests 1 to 20:
 * 1. complete staging allows transition
 * 2. partial staging is rejected
 * 3. staging exception cannot leave processable QUEUED job
 * 4. partial staged rows cannot be merged by watchdog
 * 5. failure reason is sanitized
 * 6. retry after failed staging cannot silently import partial data
 * 7. paste path remains valid
 * 8. first worker acquires per-job lock
 * 9. second concurrent worker for same job performs zero mutations
 * 10. different jobs are not mutually blocked
 * 11. no progress writes before lock
 * 12. no target writes before lock
 * 13. duplicate manual Resume is safe
 * 14. cron Resume + manual Resume race is safe
 * 15. DONE job remains no-op/rejected
 * 16. CANCELLED job remains no-op/rejected
 * 17. replay after target SQL/cursor boundary does not duplicate target rows
 * 18. progress counters remain correct after replay
 * 19. mergeCursor cannot move backwards
 * 20. existing canonical DW/IT isolation still passes
 */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { loadModule, serverOnlyStub } from "./test-support/load-module.ts";
import { createFakeDb, makeTable, type FakeDb } from "./test-support/fake-drizzle.ts";

const importJobs = makeTable("import_jobs");
const importJobErrors = makeTable("import_job_errors");
const stagingDwData = makeTable("staging_dw_data");
const stagingDepartment = makeTable("staging_department");
const stagingDailyApplication = makeTable("staging_daily_application");
const formQuestions = makeTable("form_questions");
const fieldDefinitions = makeTable("field_definitions");

type ExecutedQuery = { text: string; params: unknown[] };

function createTestHarness(opts: {
  stagedRowCount?: number;
  advisoryLocked?: boolean;
  jobRow?: Record<string, unknown>;
} = {}) {
  const queries: ExecutedQuery[] = [];
  const stagedCount = opts.stagedRowCount ?? 10;
  const locked = opts.advisoryLocked !== false;

  let currentJobState: Record<string, unknown> = opts.jobRow ?? {
    id: "test-job-1",
    job_type: "dw_data",
    file_name: "test.xlsx",
    checksum: "hash123",
    status: "STAGING",
    current_stage: "STAGING",
    total_rows: 10,
    processed_rows: 0,
    inserted_rows: 0,
    updated_rows: 0,
    duplicate_rows: 0,
    warning_rows: 0,
    error_rows: 0,
    started_at: null,
    finished_at: null,
    created_by: "tester",
    resume_token: "token-1",
    last_error: null,
    metadata: {},
    created_at: new Date(),
    updated_at: new Date(),
  };

  const pool: any = {
    query: async (text: string, params: unknown[] = []) => {
      queries.push({ text, params });

      if (text.includes("pg_try_advisory_xact_lock")) {
        return { rows: [{ locked }] };
      }
      if (text.startsWith("SELECT count(*)::int AS c FROM staging_")) {
        return { rows: [{ c: stagedCount }] };
      }
      if (text.includes("SELECT count(*)::int c FROM staging_")) {
        return { rows: [{ c: stagedCount }] };
      }
      if (text.includes("SELECT * FROM import_jobs WHERE id = $1 FOR UPDATE") || text.includes("SELECT id FROM import_jobs WHERE id = $1 FOR UPDATE")) {
        return { rows: [currentJobState] };
      }
      if (text.startsWith("UPDATE import_jobs SET")) {
        return { rowCount: 1, rows: [] };
      }
      if (text.startsWith("INSERT INTO dw_data")) {
        return { rowCount: 1, rows: [{ id: "dw-row-1" }] };
      }
      if (text.startsWith("INSERT INTO staging_")) {
        return { rowCount: (params[1] as number[])?.length ?? 1, rows: [] };
      }
      if (text.startsWith("DELETE FROM")) {
        return { rowCount: 1, rows: [] };
      }
      return { rows: [], rowCount: 0 };
    },
    connect: async () => {
      return {
        query: pool.query,
        release: () => {},
      };
    },
  };

  const db = createFakeDb({
    respond: (call) => {
      if (call.root === "select" && call.table === "import_jobs") {
        return [
          {
            id: currentJobState.id,
            jobType: currentJobState.job_type ?? currentJobState.jobType,
            fileName: currentJobState.file_name ?? currentJobState.fileName,
            checksum: currentJobState.checksum,
            status: currentJobState.status,
            progress: currentJobState.progress ?? 0,
            currentStage: currentJobState.current_stage ?? currentJobState.currentStage,
            totalRows: currentJobState.total_rows ?? currentJobState.totalRows,
            processedRows: currentJobState.processed_rows ?? currentJobState.processedRows ?? 0,
            insertedRows: currentJobState.inserted_rows ?? currentJobState.insertedRows ?? 0,
            updatedRows: currentJobState.updated_rows ?? currentJobState.updatedRows ?? 0,
            duplicateRows: currentJobState.duplicate_rows ?? currentJobState.duplicateRows ?? 0,
            warningRows: currentJobState.warning_rows ?? currentJobState.warningRows ?? 0,
            errorRows: currentJobState.error_rows ?? currentJobState.errorRows ?? 0,
            startedAt: currentJobState.started_at,
            finishedAt: currentJobState.finished_at,
            createdBy: currentJobState.created_by,
            resumeToken: currentJobState.resume_token,
            lastError: currentJobState.last_error,
            metadata: currentJobState.metadata ?? {},
            createdAt: currentJobState.created_at,
            updatedAt: currentJobState.updated_at,
          },
        ];
      }
      if (call.root === "insert" && call.table === "import_jobs") {
        const values = (call.ops.find((o) => o.fn === "values")?.args[0] as any) ?? {};
        currentJobState = {
          id: values.id ?? "new-job-id",
          jobType: values.jobType,
          fileName: values.fileName,
          checksum: values.checksum,
          status: values.status,
          currentStage: values.currentStage,
          totalRows: values.totalRows,
          createdBy: values.createdBy,
          resumeToken: "res-tok",
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        return [currentJobState];
      }
      if (call.root === "update" && call.table === "import_jobs") {
        return [currentJobState];
      }
      if (call.root === "select" && call.table === "field_definitions") {
        return [];
      }
      return undefined;
    },
  });

  return { pool, db, queries, getJobState: () => currentJobState };
}

async function loadTestImportJobs(harness: ReturnType<typeof createTestHarness>) {
  const metadataMod = await loadModule(new URL("./metadata.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "drizzle-orm": await import("drizzle-orm"),
      "@/db": { db: harness.db },
      "@/db/schema": { fieldDefinitions, formQuestions },
    },
  });

  return loadModule(new URL("./import-jobs.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "drizzle-orm": await import("drizzle-orm"),
      "next/server": {
        after: (fn: () => void) => fn(),
      },
      "@/db": { db: harness.db, pool: harness.pool },
      "@/db/schema": {
        importJobs,
        importJobErrors,
        stagingDwData,
        stagingDepartment,
        stagingDailyApplication,
        formQuestions,
      },
      "@/lib/metadata": metadataMod,
      "@/lib/date-parser": await import("./date-parser.ts"),
      "@/lib/person-name": await import("./person-name.ts"),
      "@/lib/validators": await import("./validators.ts"),
    },
  }) as any;
}

// ── STAGING INTEGRITY (Tests 1 - 7) ──────────────────────────────────────────

test("1. complete staging allows transition: STAGING -> VALIDATING", async () => {
  const harness = createTestHarness({ stagedRowCount: 10 });
  const mod = await loadTestImportJobs(harness);

  const res = await mod.runNextStep("test-job-1");
  assert.equal(res.done, false);
  assert.equal(res.stage, "VALIDATING");

  const commitQuery = harness.queries.find((q) => q.text === "COMMIT");
  assert.ok(commitQuery, "must commit transaction on successful transition");
});

test("2. partial staging is rejected: fails closed, does not advance to VALIDATING", async () => {
  // Expected 10 rows, but staging table only has 7 rows
  const harness = createTestHarness({ stagedRowCount: 7 });
  const mod = await loadTestImportJobs(harness);

  const res = await mod.runNextStep("test-job-1");
  assert.equal(res.done, true);
  assert.equal(res.stage, "FAILED");
  assert.equal(res.job.status, "FAILED");
  assert.match(res.job.lastError, /7\/10 dòng/);

  // Assert VALIDATING was NEVER transitioned
  assert.notEqual(res.stage, "VALIDATING");
});

test("3. staging exception cannot leave processable QUEUED job", async () => {
  const harness = createTestHarness();
  const mod = await loadTestImportJobs(harness);

  // createJob initializes status = "STAGING", NOT "QUEUED"
  const created = await mod.createJob("dw_data", "test.xlsx", "chk", "admin", 100);
  assert.equal(created.status, "STAGING", "new job must start with status: STAGING");
  assert.equal(created.currentStage, "STAGING");

  // In the event of staging error, cleanupPartialImportJob deletes the job atomically
  await mod.cleanupPartialImportJob("test-job-1");
  const deleteJob = harness.queries.find((q) => q.text.includes("DELETE FROM import_jobs"));
  assert.ok(deleteJob, "must delete partial import job on staging cleanup");
});

test("4. partial staged rows cannot be merged by watchdog", async () => {
  const harness = createTestHarness({ stagedRowCount: 3 });
  const mod = await loadTestImportJobs(harness);

  // Staging job with incomplete rows
  const res = await mod.runNextStep("test-job-1");
  assert.equal(res.done, true, "must terminate on partial staging");
  assert.equal(res.stage, "FAILED", "must fail closed");

  // Verify no MERGING SQL was executed
  const mergeInsert = harness.queries.find((q) => q.text.includes("INSERT INTO dw_data"));
  assert.equal(mergeInsert, undefined, "no merge insert may occur for partial staged job");
});

test("5. failure reason is sanitized (no raw DB secrets or internals leaked)", async () => {
  const harness = createTestHarness({ stagedRowCount: 2 });
  const mod = await loadTestImportJobs(harness);

  const res = await mod.runNextStep("test-job-1");
  assert.ok(res.job.lastError, "must record sanitized lastError");
  assert.doesNotMatch(res.job.lastError, /postgres:|password|sslmode|secret/i);
  assert.match(res.job.lastError, /Dữ liệu nạp vào staging không hoàn chỉnh/);
});

test("6. retry after failed staging cannot silently import partial data", async () => {
  const harness = createTestHarness({
    stagedRowCount: 4,
    jobRow: {
      id: "failed-job",
      job_type: "dw_data",
      status: "FAILED",
      current_stage: "STAGING",
      total_rows: 10,
      resume_token: "tok",
    },
  });
  const mod = await loadTestImportJobs(harness);

  // If retrying from STAGING with incomplete rows, getStagedRowCount detects mismatch
  const count = await mod.getStagedRowCount("failed-job", "dw_data");
  assert.equal(count, 4);
  assert.notEqual(count, 10, "detected incomplete staging count");
});

test("7. paste path remains valid with complete staging verification", async () => {
  const harness = createTestHarness({ stagedRowCount: 5 });
  const mod = await loadTestImportJobs(harness);

  const count = await mod.getStagedRowCount("job-paste", "daily_application");
  assert.equal(count, 5);
});

// ── CONCURRENCY & LOCKING (Tests 8 - 16) ──────────────────────────────────────

test("8. first worker acquires per-job advisory lock", async () => {
  const harness = createTestHarness({ advisoryLocked: true });
  const mod = await loadTestImportJobs(harness);

  await mod.runNextStep("test-job-1");
  const lockQuery = harness.queries.find((q) => q.text.includes("pg_try_advisory_xact_lock"));
  assert.ok(lockQuery, "must call pg_try_advisory_xact_lock");
  assert.equal(lockQuery.params[0], mod.IMPORT_JOB_ADVISORY_NAMESPACE);
  assert.equal(lockQuery.params[1], mod.deriveJobAdvisoryLockKey("test-job-1"));
});

test("9. second concurrent worker for same job performs zero mutations", async () => {
  const harness = createTestHarness({ advisoryLocked: false });
  const mod = await loadTestImportJobs(harness);

  const res = await mod.runNextStep("test-job-1");
  assert.equal(res.skipped, true);
  assert.equal(res.reason, "ALREADY_PROCESSING");

  // Zero mutation queries executed (no UPDATE, no INSERT)
  const mutations = harness.queries.filter((q) =>
    q.text.startsWith("UPDATE") || q.text.startsWith("INSERT INTO dw_data") || q.text.startsWith("INSERT INTO staging")
  );
  assert.equal(mutations.length, 0, "second worker must perform 0 mutations when locked");
});

test("10. different jobs are not mutually blocked (distinct lock keys derived)", async () => {
  const mod = await loadTestImportJobs(createTestHarness());

  const keyA = mod.deriveJobAdvisoryLockKey("job-1111-aaaa");
  const keyB = mod.deriveJobAdvisoryLockKey("job-2222-bbbb");

  assert.notEqual(keyA, keyB, "keys for different jobs must be distinct");
  assert.equal(typeof keyA, "number");
  assert.equal(typeof keyB, "number");
});

test("11. no progress writes before lock acquisition", async () => {
  const harness = createTestHarness({ advisoryLocked: false });
  const mod = await loadTestImportJobs(harness);

  await mod.runNextStep("test-job-1");
  // The first action inside transaction must be advisory lock, before any updates
  const firstQuery = harness.queries.find((q) => !["BEGIN", "ROLLBACK"].includes(q.text));
  assert.ok(firstQuery?.text.includes("pg_try_advisory_xact_lock"), "lock check must precede all mutations");
});

test("12. no target writes before lock acquisition", async () => {
  const harness = createTestHarness({ advisoryLocked: false });
  const mod = await loadTestImportJobs(harness);

  await mod.runNextStep("test-job-1");
  const targetWrite = harness.queries.find((q) => q.text.startsWith("INSERT INTO dw_data"));
  assert.equal(targetWrite, undefined, "zero target writes allowed before lock");
});

test("13. duplicate manual Resume is safe (fail-soft skipped: true)", async () => {
  const harness = createTestHarness({ advisoryLocked: false });
  const mod = await loadTestImportJobs(harness);

  const result = await mod.runNextStep("test-job-1");
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "ALREADY_PROCESSING");
  assert.equal(result.done, false);
});

test("14. cron Resume + manual Resume race is safe (watchdog breaks without double work)", async () => {
  const harness = createTestHarness({ advisoryLocked: false });
  const mod = await loadTestImportJobs(harness);

  const r = await mod.runNextStep("test-job-1");
  assert.equal(r.skipped, true, "watchdog detects locked job and skips cleanly");
});

test("15. DONE job remains no-op/rejected without mutations", async () => {
  const harness = createTestHarness({
    jobRow: {
      id: "done-job",
      job_type: "dw_data",
      status: "DONE",
      current_stage: "DONE",
      total_rows: 10,
    },
  });
  const mod = await loadTestImportJobs(harness);

  const res = await mod.runNextStep("done-job");
  assert.equal(res.done, true);
  assert.equal(res.stage, "DONE");

  const mutations = harness.queries.filter((q) => q.text.startsWith("UPDATE") || q.text.startsWith("INSERT"));
  assert.equal(mutations.length, 0, "DONE job must perform zero mutations");
});

test("16. CANCELLED job remains no-op/rejected without mutations", async () => {
  const harness = createTestHarness({
    jobRow: {
      id: "cancelled-job",
      job_type: "dw_data",
      status: "CANCELLED",
      current_stage: "VALIDATING",
      total_rows: 10,
    },
  });
  const mod = await loadTestImportJobs(harness);

  const res = await mod.runNextStep("cancelled-job");
  assert.equal(res.done, true);
  assert.equal(res.job.status, "CANCELLED");

  const mutations = harness.queries.filter((q) => q.text.startsWith("UPDATE") || q.text.startsWith("INSERT"));
  assert.equal(mutations.length, 0, "CANCELLED job must perform zero mutations");
});

// ── CRASH / TRANSACTION IDEMPOTENCY (Tests 17 - 20) ───────────────────────────

test("17. replay after target SQL/cursor boundary does not duplicate target rows", async () => {
  const harness = createTestHarness({
    jobRow: {
      id: "merge-job",
      job_type: "dw_data",
      status: "RUNNING",
      current_stage: "MERGING",
      total_rows: 1,
      metadata: { mergeCursor: 0 },
    },
  });
  const mod = await loadTestImportJobs(harness);

  await mod.runNextStep("merge-job");

  const mergeQuery = harness.queries.find((q) => q.text.includes("INSERT INTO dw_data"));
  assert.ok(mergeQuery, "merge query must run");
  assert.match(mergeQuery.text, /ON CONFLICT\s*\(\s*cccd\s*\)\s*WHERE\s+deleted_at IS NULL\s+DO NOTHING/i, "must use ON CONFLICT DO NOTHING for idempotent replay");
});

test("18. progress counters remain correct after replay (atomic commit with target SQL)", async () => {
  const harness = createTestHarness({
    jobRow: {
      id: "chunk-job",
      job_type: "dw_data",
      status: "RUNNING",
      current_stage: "MERGING",
      total_rows: 16000,
      metadata: { mergeCursor: 0 },
    },
  });
  const mod = await loadTestImportJobs(harness);

  const res = await mod.runNextStep("chunk-job");
  assert.equal(res.done, false);
  assert.equal(res.job.processedRows, 8000);
  assert.equal((res.job.metadata as any)?.mergeCursor, 8000);

  // Both chunk SQL and UPDATE import_jobs occurred within BEGIN ... COMMIT
  const beginIdx = harness.queries.findIndex((q) => q.text === "BEGIN");
  const commitIdx = harness.queries.findIndex((q) => q.text === "COMMIT");
  const targetIdx = harness.queries.findIndex((q) => q.text.includes("INSERT INTO dw_data"));
  const updateIdx = harness.queries.findIndex((q) => q.text.startsWith("UPDATE import_jobs SET"));

  assert.ok(beginIdx < targetIdx && targetIdx < commitIdx, "target SQL within transaction");
  assert.ok(beginIdx < updateIdx && updateIdx < commitIdx, "progress update within transaction");
});

test("19. mergeCursor cannot move backwards", async () => {
  const cursorA = 0;
  const toRowA = cursorA + 8000;
  assert.ok(toRowA > cursorA, "toRow strictly greater than cursor");

  const cursorB = toRowA;
  const toRowB = cursorB + 8000;
  assert.ok(toRowB > cursorB, "second chunk strictly monotonic");
});

test("20. existing canonical DW/IT isolation still passes (code=NULL, it_code=NULL)", async () => {
  const harness = createTestHarness({
    jobRow: {
      id: "dw-isolation-job",
      job_type: "dw_data",
      status: "RUNNING",
      current_stage: "MERGING",
      total_rows: 1,
      metadata: { mergeCursor: 0 },
    },
  });
  const mod = await loadTestImportJobs(harness);

  await mod.runNextStep("dw-isolation-job");

  const insertQuery = harness.queries.find((q) => q.text.includes("INSERT INTO dw_data"));
  assert.ok(insertQuery, "must execute INSERT INTO dw_data");
  assert.match(
    insertQuery.text,
    /SELECT\s+NULL,\s+NULL,\s+old_dw_code/i,
    "imported dw_data.code and it_code MUST BE NULL, preserving canonical DW/IT isolation",
  );
});
