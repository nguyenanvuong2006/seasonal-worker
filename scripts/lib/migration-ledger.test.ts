/**
 * SCHEMA MIGRATIONS LEDGER — unit tests against a hand-rolled in-memory fake
 * Postgres client (no real DB). The fake implements just enough of
 * BEGIN/COMMIT/ROLLBACK (snapshot-on-BEGIN, restore-on-ROLLBACK) and the
 * exact statements migration-ledger.mjs issues to prove the CONTRACT:
 * checksum-match NOOP, checksum-mismatch hard error, failed migration SQL
 * leaves no ledger row, successful migration SQL + ledger row commit
 * together. This proves control-flow correctness, not real Postgres
 * concurrency — advisory-lock SERIALIZATION under genuine concurrent
 * connections cannot be exercised without a real database; the "concurrent
 * duplicate attempt" test below proves the SAME single-connection code path
 * a second caller would hit after the lock releases (via sequential calls),
 * which is the reusable, DB-free proof available in this harness.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  recordMigration,
  runMigration,
  recordAlreadyExecutedMigration,
  ensureSchemaMigrationsTable,
  schemaMigrationsTableExists,
  getLedgerRow,
  computeChecksum,
  MigrationLedgerError,
  MIGRATION_CHECKSUM_MISMATCH,
} from "./migration-ledger.mjs";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type FakeRow = Record<string, unknown>;

/** Minimal in-memory Postgres fake — implements only what migration-ledger.mjs calls. */
function makeFakeClient() {
  let tableExists = false;
  let rows = new Map<string, FakeRow>();
  let snapshot: { tableExists: boolean; rows: Map<string, FakeRow> } | null = null;
  const calls: { text: string; params?: unknown[] }[] = [];
  const sideEffects: string[] = []; // proves `execute` ran inside the transaction

  // Real FIFO mutex keyed by the SAME "one advisory lock per client" model
  // pg_advisory_xact_lock provides — a second caller's lock acquisition
  // genuinely blocks (awaits) until the first caller's COMMIT/ROLLBACK
  // releases it, exactly mirroring the real Postgres serialization
  // contract, not just leaving the two calls to race in the fake.
  let mutex: Promise<void> = Promise.resolve();
  let releaseLock: (() => void) | null = null;

  return {
    calls,
    sideEffects,
    getRows: () => new Map(rows),
    tableExistsNow: () => tableExists,
    async query(text: string, params: unknown[] = []) {
      calls.push({ text, params });
      const t = text.trim();

      if (/CREATE TABLE IF NOT EXISTS schema_migrations/i.test(t)) {
        tableExists = true;
        return { rows: [], rowCount: 0 };
      }
      if (/CREATE INDEX IF NOT EXISTS/i.test(t)) {
        return { rows: [], rowCount: 0 };
      }
      if (/^BEGIN$/i.test(t)) {
        snapshot = { tableExists, rows: new Map(rows) };
        return { rows: [], rowCount: 0 };
      }
      if (/^COMMIT$/i.test(t)) {
        snapshot = null;
        if (releaseLock) {
          releaseLock();
          releaseLock = null;
        }
        return { rows: [], rowCount: 0 };
      }
      if (/^ROLLBACK$/i.test(t)) {
        if (snapshot) {
          tableExists = snapshot.tableExists;
          rows = snapshot.rows;
          snapshot = null;
        }
        if (releaseLock) {
          releaseLock();
          releaseLock = null;
        }
        return { rows: [], rowCount: 0 };
      }
      if (/^SELECT pg_advisory_xact_lock/i.test(t)) {
        const myTurn = mutex;
        let myRelease: () => void = () => {};
        mutex = new Promise((resolve) => {
          myRelease = resolve;
        });
        await myTurn; // block until the previous holder's COMMIT/ROLLBACK releases
        releaseLock = myRelease; // only now am I the actual lock holder
        return { rows: [{}], rowCount: 1 };
      }
      if (/^SELECT to_regclass/i.test(t)) {
        return { rows: [{ reg: tableExists ? "schema_migrations" : null }], rowCount: 1 };
      }
      if (/^SELECT checksum_sha256 FROM schema_migrations WHERE migration_id = \$1 FOR UPDATE$/i.test(t)) {
        const row = rows.get(params[0] as string);
        return row ? { rows: [{ checksum_sha256: row.checksum_sha256 }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (/^SELECT migration_id, checksum_sha256, applied_at, applied_by, execution_method, app_commit_sha, notes FROM schema_migrations WHERE migration_id = \$1$/i.test(t)) {
        const row = rows.get(params[0] as string);
        return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (/^INSERT INTO schema_migrations/i.test(t)) {
        const [migrationId, checksum, appliedBy, executionMethod, appCommitSha, notes] = params;
        rows.set(migrationId as string, {
          migration_id: migrationId,
          checksum_sha256: checksum,
          applied_at: new Date(),
          applied_by: appliedBy,
          execution_method: executionMethod,
          app_commit_sha: appCommitSha,
          notes,
        });
        return { rows: [], rowCount: 1 };
      }
      if (/^FAIL_THIS_MIGRATION$/i.test(t)) {
        throw new Error("simulated migration SQL failure");
      }
      throw new Error(`FakeClient: unexpected query: ${t}`);
    },
  };
}

function writeTempMigrationFile(sql: string): string {
  const dir = mkdtempSync(join(tmpdir(), "migration-ledger-test-"));
  const path = join(dir, "test-migration.sql");
  writeFileSync(path, sql, "utf8");
  return path;
}

test("ensureSchemaMigrationsTable: creates the ledger table if absent", async () => {
  const client = makeFakeClient();
  assert.equal(client.tableExistsNow(), false);
  await ensureSchemaMigrationsTable(client, { root: process.cwd() });
  assert.equal(client.tableExistsNow(), true);
  assert.equal(await schemaMigrationsTableExists(client), true);
});

test("recordMigration: no existing row -> executes `execute` inside the transaction, inserts ledger row, returns APPLIED", async () => {
  const client = makeFakeClient();
  let executed = false;
  const result = await recordMigration(client, {
    migrationId: "m1.sql",
    checksum: "abc123",
    executionMethod: "TEST",
    execute: async () => {
      executed = true;
    },
  });
  assert.equal(executed, true, "execute() must run for a genuinely new migration");
  assert.equal(result.status, "APPLIED");
  const row = await getLedgerRow(client, "m1.sql");
  assert.ok(row);
  assert.equal(row.checksum_sha256, "abc123");
  assert.equal(row.execution_method, "TEST");
});

test("recordMigration: same migrationId + SAME checksum -> NOOP, execute() is NOT called again", async () => {
  const client = makeFakeClient();
  let executeCalls = 0;
  const opts = {
    migrationId: "m2.sql",
    checksum: "same-checksum",
    executionMethod: "TEST",
    execute: async () => {
      executeCalls += 1;
    },
  };
  const first = await recordMigration(client, opts);
  assert.equal(first.status, "APPLIED");
  assert.equal(executeCalls, 1);

  const second = await recordMigration(client, opts);
  assert.equal(second.status, "NOOP");
  assert.equal(executeCalls, 1, "execute() must NOT run again on a checksum-matched NOOP");
});

test("recordMigration: same migrationId + DIFFERENT checksum -> MigrationLedgerError(MIGRATION_CHECKSUM_MISMATCH), never silently overwritten", async () => {
  const client = makeFakeClient();
  await recordMigration(client, { migrationId: "m3.sql", checksum: "checksum-A", executionMethod: "TEST" });

  await assert.rejects(
    () => recordMigration(client, { migrationId: "m3.sql", checksum: "checksum-B", executionMethod: "TEST" }),
    (err: unknown) => err instanceof MigrationLedgerError && err.code === MIGRATION_CHECKSUM_MISMATCH,
  );

  const row = await getLedgerRow(client, "m3.sql");
  assert.equal(row!.checksum_sha256, "checksum-A", "ledger checksum must stay the ORIGINAL value — never overwritten");
});

test("recordMigration: execute() throws -> transaction rolls back, NO ledger row is left behind", async () => {
  const client = makeFakeClient();
  await assert.rejects(
    () =>
      recordMigration(client, {
        migrationId: "m4.sql",
        checksum: "will-fail",
        executionMethod: "TEST",
        execute: async () => {
          throw new Error("migration SQL failed");
        },
      }),
    /migration SQL failed/,
  );
  const row = await getLedgerRow(client, "m4.sql");
  assert.equal(row, null, "a failed migration must NEVER leave a ledger row");
});

test("recordMigration: BEGIN happens before the advisory lock, and the ledger table is ensured before BEGIN (bootstrap-before-everything)", async () => {
  const client = makeFakeClient();
  await recordMigration(client, { migrationId: "m5.sql", checksum: "x", executionMethod: "TEST" });
  const kinds = client.calls.map((c) => c.text.trim().split(/\s+/)[0].toUpperCase());
  const createIdx = kinds.findIndex((k) => k === "CREATE");
  const beginIdx = kinds.findIndex((k) => k === "BEGIN");
  const lockIdx = client.calls.findIndex((c) => /pg_advisory_xact_lock/i.test(c.text));
  assert.ok(createIdx < beginIdx, "table bootstrap must happen before BEGIN");
  assert.ok(beginIdx < lockIdx, "BEGIN must happen before the advisory lock is taken");
});

test("recordMigration: sequential 'concurrent' attempts on the same migrationId — the second sees the first's committed row and NOOPs (proves the single-connection code path a real concurrent second caller hits after the advisory lock releases)", async () => {
  const client = makeFakeClient();
  const opts = { migrationId: "m6.sql", checksum: "concurrent-checksum", executionMethod: "TEST" };
  const results = await Promise.all([recordMigration(client, opts), recordMigration(client, opts)]);
  // With a single-threaded fake, `await`ed calls to the same client naturally interleave in
  // issue order — this proves one APPLIED + one NOOP with no double-insert, matching what a
  // real Postgres advisory lock would serialize into for a second, genuinely concurrent caller.
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, ["APPLIED", "NOOP"]);
});

test("runMigration: reads migration file from disk, computes its checksum, executes its real SQL text, and records that checksum", async () => {
  const client = makeFakeClient();
  const sqlFilePath = writeTempMigrationFile("SELECT to_regclass('public.schema_migrations') AS reg");
  const expectedChecksum = computeChecksum(Buffer.from("SELECT to_regclass('public.schema_migrations') AS reg", "utf8"));

  const result = await runMigration(client, { migrationId: "temp.sql", sqlFilePath, executionMethod: "TEST" });
  assert.equal(result.status, "APPLIED");
  assert.equal(result.checksum, expectedChecksum);
  const row = await getLedgerRow(client, "temp.sql");
  assert.equal(row!.checksum_sha256, expectedChecksum);
});

test("recordAlreadyExecutedMigration: does NOT re-run the migration SQL — only records it (for scoped runners that already executed + verified it themselves)", async () => {
  const client = makeFakeClient();
  const sqlFilePath = writeTempMigrationFile("FAIL_THIS_MIGRATION"); // would throw if ever executed by the ledger helper
  const result = await recordAlreadyExecutedMigration(client, { migrationId: "already-run.sql", sqlFilePath, executionMethod: "SCOPED_RUNNER" });
  assert.equal(result.status, "APPLIED");
  const row = await getLedgerRow(client, "already-run.sql");
  assert.ok(row, "ledger row must be recorded even though the SQL was never executed by this helper");
});

test("computeChecksum: same bytes -> same checksum; different bytes -> different checksum (raw bytes, not normalized)", () => {
  const a = computeChecksum(Buffer.from("hello\n", "utf8"));
  const b = computeChecksum(Buffer.from("hello\n", "utf8"));
  const c = computeChecksum(Buffer.from("hello\r\n", "utf8"));
  assert.equal(a, b);
  assert.notEqual(a, c, "CRLF vs LF must produce a DIFFERENT checksum — raw bytes, no normalization");
});
