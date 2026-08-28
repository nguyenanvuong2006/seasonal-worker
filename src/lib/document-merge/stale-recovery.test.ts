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
  assert.match(stmt, /j\.engine = 'HTML_PDF'/);
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
