/**
 * REGRESSION — stale merge recovery liveness/race safety.
 *
 * Recovery must ONLY reclaim jobs whose LAST-PROGRESS lease is genuinely dead,
 * never a healthy job merely because it is old. Tests assert (against the real
 * module via vm/transpile, db.execute scripted):
 *
 *  - GOOGLE_DOCS: stale decision keys on merge_jobs.updated_at (liveness) and a
 *    fresh item lease — NOT created_at wall-clock age.
 *  - A long-running HEALTHY job (recent updated_at / fresh lease) is never
 *    failed even when it is far older than the old 10-minute threshold.
 *  - A truly dead job (no progress past STALE_AFTER_NO_PROGRESS_MS, expired
 *    item lease) is FAILED with a visible error.
 *  - HTML_PDF stale PROCESSING items reclaim only on expired lease; orphan
 *    QUEUED jobs redispatch once; idempotent; a thrown fire() never crashes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, drizzleStub, makeTable } from "../test-support/fake-drizzle.ts";
import { loadModule, serverOnlyStub } from "../test-support/load-module.ts";

const schemaStub = {
  mergeJobRecords: makeTable("merge_job_records"),
  mergeJobs: makeTable("merge_jobs"),
};

type RecoveryResult = {
  syncFailed: number;
  processingReclaimed: number;
  dispatchJobIds: string[];
  recoveredJobIds: string[];
};
type RecoveryModule = {
  recoverStaleMergeJob: (jobId: string, opts?: { now?: Date; fire?: (id: string) => void }) => Promise<RecoveryResult>;
  recoverStaleMergeJobs: (opts?: { now?: Date; fire?: (id: string) => void }) => Promise<RecoveryResult>;
  STALE_SYNC_GRACE_MS: number;
  STALE_DISPATCH_MS: number;
  STALE_PROCESSING_MS: number;
};

function sqlTextOf(arg: unknown): string {
  const t = arg as { sql?: string; strings?: string[]; text?: string };
  if (typeof t.text === "string") return t.text;
  if (typeof t.sql === "string") return t.sql;
  if (Array.isArray(t.strings)) return t.strings.join("?");
  return "";
}

function loadRecovery(execute: (...args: unknown[]) => Promise<{ rows: unknown[] }>): RecoveryModule {
  const fake = createFakeDb({ respond: () => undefined });
  return loadModule(new URL("./stale-recovery.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "drizzle-orm": drizzleStub,
      "../../db": { db: { ...fake, calls: fake.calls, execute } },
      "../../db/schema": schemaStub,
    },
  }) as unknown as RecoveryModule;
}

const NOW = new Date("2026-08-28T03:00:00Z");
const tag = (text: string, marker: string): boolean => text.includes(marker);

test("GOOGLE_DOCS stale statement keys on LIVENESS (j.updated_at), never created_at age", async () => {
  const executeCalls: unknown[][] = [];
  const execute = async (...args: unknown[]) => {
    executeCalls.push(args);
    const text = sqlTextOf(args[0]);
    if (tag(text, "recover-sync-killed")) {
      return { rows: [{ syncFailed: 1, itemsFailed: 1, jobIds: ["job-dead"] }] };
    }
    return { rows: [] };
  };
  const mod = loadRecovery(execute);

  const res = await mod.recoverStaleMergeJob("job-dead", { now: NOW });
  assert.equal(res.syncFailed, 1);

  const stmt = executeCalls.map((c) => sqlTextOf(c[0])).find((t) => tag(t, "recover-sync-killed"));
  assert.ok(stmt);
  // Liveness, not wall-clock age.
  assert.match(stmt, /j\.updated_at </, "must decide staleness on updated_at (last progress)");
  assert.doesNotMatch(stmt, /j\.created_at </, "must NOT decide GOOGLE_DOCS staleness on created_at");
  // A fresh item lease proves a request is alive → excluded from reclaim.
  assert.match(stmt, /r\.status = 'PROCESSING'[\s\S]*r\.leased_until > \?/, "fresh item lease must exempt the job");
  assert.match(stmt, /STALE_SYNC_KILLED/);
});

test("TEST A — long HEALTHY GOOGLE_DOCS job (old created_at but recent progress/fresh lease) is NEVER failed", async () => {
  const execute = async (...args: unknown[]) => {
    // Simulate the SQL returning no dead rows: updated_at is recent AND a live
    // item lease exists, so the dead CTE matches nothing.
    void sqlTextOf(args[0]);
    return { rows: [] };
  };
  const mod = loadRecovery(execute);
  const fired: string[] = [];

  const res = await mod.recoverStaleMergeJob("job-healthy", { now: NOW, fire: (id) => fired.push(id) });
  assert.equal(res.syncFailed, 0, "healthy progressing job must not be failed");
  assert.equal(res.processingReclaimed, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(fired)), []);
});

test("TEST B — truly dead GOOGLE_DOCS job (no liveness past threshold) is FAILED loudly", async () => {
  const execute = async (...args: unknown[]) => {
    const text = sqlTextOf(args[0]);
    if (tag(text, "recover-sync-killed")) return { rows: [{ syncFailed: 1, itemsFailed: 1, jobIds: ["job-dead"] }] };
    return { rows: [] };
  };
  const mod = loadRecovery(execute);

  const res = await mod.recoverStaleMergeJobs({ now: NOW });
  assert.equal(res.syncFailed, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(res.recoveredJobIds)), ["job-dead"]);
});

test("HTML_PDF reclaim statement keys on expired item LEASE (r.leased_until), so a heartbeating worker is never reclaimed", async () => {
  const executeCalls: unknown[][] = [];
  const execute = async (...args: unknown[]) => {
    executeCalls.push(args);
    const text = sqlTextOf(args[0]);
    if (tag(text, "recover-stale-processing")) return { rows: [{ jobId: "job-html-dead" }] };
    return { rows: [] };
  };
  const mod = loadRecovery(execute);
  const fired: string[] = [];

  const res = await mod.recoverStaleMergeJobs({ now: NOW, fire: (id) => fired.push(id) });
  assert.equal(res.processingReclaimed, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(fired)), ["job-html-dead"]);

  const stmt = executeCalls.map((c) => sqlTextOf(c[0])).find((t) => tag(t, "recover-stale-processing"));
  assert.ok(stmt);
  assert.match(stmt, /r\.leased_until/, "reclaim must hinge on the item lease");
  assert.match(stmt, /r\.status = 'PROCESSING'/);
  assert.match(stmt, /j\.engine IN \('HTML_PDF', 'GOOGLE_DOCS'\)/, "worker-queue engines (HTML_PDF + async GOOGLE_DOCS) reclaim on expired lease");
});

test("orphaned QUEUED HTML_PDF job is re-dispatched exactly once", async () => {
  const execute = async (...args: unknown[]) => {
    const text = sqlTextOf(args[0]);
    if (tag(text, "recover-orphan-dispatch")) return { rows: [{ jobId: "job-orphan" }] };
    return { rows: [] };
  };
  const mod = loadRecovery(execute);
  const fired: string[] = [];

  const res = await mod.recoverStaleMergeJobs({ now: NOW, fire: (id) => fired.push(id) });
  assert.deepEqual(JSON.parse(JSON.stringify(res.dispatchJobIds)), ["job-orphan"]);
  assert.deepEqual(JSON.parse(JSON.stringify(fired)), ["job-orphan"]);
});

test("idempotent healthy world → zero recovery; a thrown fire() never crashes", async () => {
  let mod = loadRecovery(async () => ({ rows: [] }));
  const fired1: string[] = [];
  const res = await mod.recoverStaleMergeJobs({ now: NOW, fire: (id) => fired1.push(id) });
  assert.equal(res.syncFailed, 0);
  assert.equal(res.processingReclaimed, 0);
  assert.equal(res.dispatchJobIds.length, 0);
  assert.equal(fired1.length, 0);

  mod = loadRecovery(async (...a: unknown[]) => {
    const text = sqlTextOf(a[0]);
    if (tag(text, "recover-orphan-dispatch")) return { rows: [{ jobId: "job-x" }] };
    return { rows: [] };
  });
  const res2 = await mod.recoverStaleMergeJobs({ now: NOW, fire: () => { throw new Error("trigger down"); } });
  assert.deepEqual(JSON.parse(JSON.stringify(res2.dispatchJobIds)), ["job-x"]);
});

test("LEGACY GAP — pre-#125 zombie shape (RUNNING job, PENDING items, no lease, old updated_at) SATISFIES the new recovery predicate", async () => {
  const executeCalls: unknown[][] = [];
  const execute = async (...args: unknown[]) => {
    executeCalls.push(args);
    const text = sqlTextOf(args[0]);
    if (tag(text, "recover-sync-killed")) {
      return { rows: [{ syncFailed: 1, itemsFailed: 2, jobIds: ["job-legacy"] }] };
    }
    return { rows: [] };
  };
  const mod = loadRecovery(execute);

  // Legacy rows created by the pre-#125 execute route:
  //   merge_jobs.status='RUNNING', engine default 'GOOGLE_DOCS',
  //   updated_at = creation time (never refreshed), items status='PENDING'
  //   with leased_until NULL.
  const res = await mod.recoverStaleMergeJobs({ now: NOW });
  assert.equal(res.syncFailed, 1, "legacy zombie must be failed loudly");
  assert.deepEqual(JSON.parse(JSON.stringify(res.recoveredJobIds)), ["job-legacy"]);

  const stmt = executeCalls.map((c) => sqlTextOf(c[0])).find((t) => tag(t, "recover-sync-killed"));
  assert.ok(stmt, "sync-killed statement must have run");

  // Engine: legacy rows have engine = default 'GOOGLE_DOCS' (NOT NULL default);
  // COALESCE also covers a hypothetical NULL — both match the predicate.
  assert.match(stmt, /COALESCE\(j\.engine, 'GOOGLE_DOCS'\)\s*=\s*'GOOGLE_DOCS'/, "legacy engine value must match the predicate");
  // Status: the pre-#125 route wrote status 'RUNNING'.
  assert.match(stmt, /j\.status IN \('RUNNING', 'PROCESSING'\)/, "legacy RUNNING status must match the predicate");
  // Liveness: updated_at (creation-time for legacy rows) is compared against
  // the no-progress cutoff — legacy rows are stale and get selected.
  assert.match(stmt, /j\.updated_at </, "legacy rows are decided by updated_at liveness");
  assert.doesNotMatch(stmt, /j\.created_at </, "staleness must not depend on created_at");
  // Items: legacy items are PENDING with leased_until NULL — the item-fail
  // UPDATE must cover every non-terminal item (PENDING included) and clear
  // the (absent) lease, so no orphan QUEUED/PENDING row is left behind.
  assert.match(stmt, /r\.status NOT IN \('COMPLETED', 'FAILED', 'CANCELLED'\)/, "legacy PENDING items must be failed too");
  assert.match(stmt, /leased_until = NULL/, "failed items must release any lease");
  assert.match(stmt, /STALE_SYNC_KILLED/, "legacy zombie items get the visible STALE_SYNC_KILLED code");
});

test("LEGACY GAP — the no-live-lease exemption cannot protect a legacy job (no PROCESSING item holds a fresh lease)", async () => {
  const executeCalls: unknown[][] = [];
  const execute = async (...args: unknown[]) => {
    executeCalls.push(args);
    return { rows: [] };
  };
  const mod = loadRecovery(execute);
  await mod.recoverStaleMergeJobs({ now: NOW });

  const stmt = executeCalls.map((c) => sqlTextOf(c[0])).find((t) => tag(t, "recover-sync-killed"));
  assert.ok(stmt);
  // The only exemption is an item PROCESSING with a live lease. Legacy jobs
  // have PENDING items and leased_until NULL → the exemption cannot match →
  // legacy jobs are never hidden from recovery.
  assert.match(stmt, /r\.status = 'PROCESSING'/, "exemption requires a PROCESSING item");
  assert.match(stmt, /r\.leased_until > \?/, "exemption requires a fresh lease (legacy rows have none)");
});

test("ASYNC MODEL — sync-killed NEVER fails a GOOGLE_DOCS job whose items are worker-claimable (QUEUED/RETRY/PROCESSING)", async () => {
  const executeCalls: unknown[][] = [];
  const execute = async (...args: unknown[]) => {
    executeCalls.push(args);
    return { rows: [] };
  };
  const mod = loadRecovery(execute);
  await mod.recoverStaleMergeJobs({ now: NOW });

  const stmt = executeCalls.map((c) => sqlTextOf(c[0])).find((t) => tag(t, "recover-sync-killed"));
  assert.ok(stmt);
  // Async GOOGLE_DOCS jobs are recoverable by the worker (claim/reclaim) —
  // the legacy sync-killed predicate must exclude them via this guard.
  assert.match(stmt, /r2\.status IN \('QUEUED', 'RETRY', 'PROCESSING'\)/, "async-model items excluded from sync-killed");
  assert.match(stmt, /NOT EXISTS \(/, "exclusion guard present");
});

test("ASYNC MODEL — orphaned QUEUED GOOGLE_DOCS job (trigger died) is re-dispatched to the worker", async () => {
  const executeCalls: unknown[][] = [];
  const execute = async (...args: unknown[]) => {
    executeCalls.push(args);
    const text = sqlTextOf(args[0]);
    if (tag(text, "recover-orphan-dispatch")) return { rows: [{ jobId: "job-gd-orphan" }] };
    return { rows: [] };
  };
  const mod = loadRecovery(execute);
  const fired: string[] = [];

  const res = await mod.recoverStaleMergeJobs({ now: NOW, fire: (id) => fired.push(id) });
  assert.deepEqual(JSON.parse(JSON.stringify(res.dispatchJobIds)), ["job-gd-orphan"]);
  assert.deepEqual(JSON.parse(JSON.stringify(fired)), ["job-gd-orphan"]);

  const stmt = executeCalls.map((c) => sqlTextOf(c[0])).find((t) => tag(t, "recover-orphan-dispatch"));
  assert.ok(stmt);
  assert.match(stmt, /j\.engine IN \('HTML_PDF', 'GOOGLE_DOCS'\)/, "orphan re-dispatch covers both worker-queue engines");
});
