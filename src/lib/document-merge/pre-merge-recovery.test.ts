/**
 * REGRESSION — interactive stale-merge recovery on the merge WRITE path.
 *
 * runPreMergeStaleRecovery() is the plan-independent recovery trigger used by
 * POST /api/document-merge/merge/execute. It must:
 *   - run the SAME stale-recovery sweep as the cron watchdog (same predicate
 *     lives in stale-recovery.ts — nothing here can weaken it);
 *   - hand HTML_PDF orphan re-dispatch to triggerPdfWorker via the fire
 *     callback (dynamic import, like the cron scheduler);
 *   - NEVER throw — a recovery failure must never block a new merge;
 *   - log counts only (no candidate PII, no secrets).
 *
 * Transpiles the REAL module in a vm sandbox with scripted stubs (same
 * harness as stale-recovery.test.ts).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { loadModule, serverOnlyStub } from "../test-support/load-module.ts";

type SweepResult = {
  syncFailed: number;
  processingReclaimed: number;
  dispatchJobIds: string[];
  recoveredJobIds: string[];
};

function loadPreMergeRecovery(opts: {
  sweepImpl: (fire: (id: string) => void) => Promise<SweepResult>;
  workerTrigger?: unknown;
}): {
  runPreMergeStaleRecovery: () => Promise<SweepResult | null>;
} {
  const stubs: Record<string, unknown> = {
    "server-only": serverOnlyStub,
    "./stale-recovery": {
      recoverStaleMergeJobs: (args: { fire: (id: string) => void }) => opts.sweepImpl(args.fire),
    },
    "./worker-trigger": opts.workerTrigger ?? {
      triggerPdfWorker: () => undefined,
    },
  };
  return loadModule(new URL("./pre-merge-recovery.ts", import.meta.url), {
    stubs,
  }) as unknown as { runPreMergeStaleRecovery: () => Promise<SweepResult | null> };
}

test("recovery sweep result is passed through and HTML_PDF orphan re-dispatch goes to triggerPdfWorker", async () => {
  const fired: string[] = [];
  const result: SweepResult = {
    syncFailed: 1,
    processingReclaimed: 0,
    dispatchJobIds: ["job-html-orphan"],
    recoveredJobIds: ["job-sync-zombie", "job-html-orphan"],
  };

  const mod = loadPreMergeRecovery({
    sweepImpl: async (fire) => {
      // The real stale-recovery calls fire() once per orphaned job.
      fire("job-html-orphan");
      return result;
    },
    workerTrigger: { triggerPdfWorker: (jobId: string) => fired.push(jobId) },
  });

  const res = await mod.runPreMergeStaleRecovery();
  assert.deepEqual(JSON.parse(JSON.stringify(res)), JSON.parse(JSON.stringify(result)));
  assert.deepEqual(fired, ["job-html-orphan"], "orphan re-dispatch must go through triggerPdfWorker");
});

test("a failing sweep NEVER throws — the new merge must not be blocked", async () => {
  const mod = loadPreMergeRecovery({
    sweepImpl: async () => {
      throw new Error("db down");
    },
  });
  const res = await mod.runPreMergeStaleRecovery();
  assert.equal(res, null, "failure returns null instead of propagating");
});

test("a failing worker-trigger module load NEVER throws — recovery degrades gracefully", async () => {
  const mod = loadPreMergeRecovery({
    sweepImpl: async () => ({ syncFailed: 0, processingReclaimed: 0, dispatchJobIds: [], recoveredJobIds: [] }),
    workerTrigger: new Proxy(
      {},
      {
        get() {
          throw new Error("worker-trigger module unavailable");
        },
      },
    ),
  });
  const res = await mod.runPreMergeStaleRecovery();
  assert.equal(res, null);
});

test("healthy world (nothing recovered) returns an empty result, not null", async () => {
  const mod = loadPreMergeRecovery({
    sweepImpl: async () => ({ syncFailed: 0, processingReclaimed: 0, dispatchJobIds: [], recoveredJobIds: [] }),
  });
  const res = await mod.runPreMergeStaleRecovery();
  assert.ok(res);
  assert.equal(res!.syncFailed, 0);
  assert.equal(res!.dispatchJobIds.length, 0);
});
