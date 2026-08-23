/**
 * HTML_PDF worker runJob — future RETRY must not be classified as CLAIM_STALLED.
 * Loads the real worker module with I/O stubs (no Chromium, no listen).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, drizzleStub, makeTable, type FakeDb } from "../../src/lib/test-support/fake-drizzle.ts";
import { loadModule } from "../../src/lib/test-support/load-module.ts";

const schemaStub = {
  dailyApplications: makeTable("daily_applications"),
  mergeJobs: makeTable("merge_jobs"),
  mergeJobRecords: makeTable("merge_job_records"),
  mergeTemplateVersions: makeTable("merge_template_versions"),
};

interface QueueSpies {
  claimItems: { calls: number; results: unknown[][] };
  failItem: { calls: { args: unknown[] }[] };
  failAllNonTerminalItems: { calls: { args: unknown[] }[] };
  finalizeJob: { calls: { args: unknown[] }[] };
  markJobProcessing: { calls: number };
  recomputeJobProgress: { calls: number; results: unknown[] };
  recordJobStage: { calls: { args: unknown[] }[] };
  allRemainingItemsAwaitingRetry: boolean;
}

function makeQueueSpies(): QueueSpies {
  return {
    claimItems: { calls: 0, results: [] },
    failItem: { calls: [] },
    failAllNonTerminalItems: { calls: [] },
    finalizeJob: { calls: [] },
    markJobProcessing: { calls: 0 },
    recomputeJobProgress: { calls: 0, results: [] },
    recordJobStage: { calls: [] },
    allRemainingItemsAwaitingRetry: false,
  };
}

type WorkerModule = {
  runJob: (jobId: string) => Promise<{ processed: number; failed: number }>;
};

async function loadWorker(db: FakeDb, spies: QueueSpies): Promise<WorkerModule> {
  const queueStub = {
    allRemainingItemsAwaitingRetry: async () => spies.allRemainingItemsAwaitingRetry,
    claimItems: async () => {
      const idx = spies.claimItems.calls;
      spies.claimItems.calls += 1;
      return (spies.claimItems.results[idx] ?? []) as unknown[];
    },
    completeItem: async () => undefined,
    failAllNonTerminalItems: async (...args: unknown[]) => {
      spies.failAllNonTerminalItems.calls.push({ args });
      return 1;
    },
    failItem: async (...args: unknown[]) => {
      spies.failItem.calls.push({ args });
      return "RETRY";
    },
    finalizeJob: async (...args: unknown[]) => {
      spies.finalizeJob.calls.push({ args });
    },
    hasPendingItems: async () => false,
    markJobProcessing: async () => {
      spies.markJobProcessing.calls += 1;
    },
    recomputeJobProgress: async () => {
      const idx = spies.recomputeJobProgress.calls;
      spies.recomputeJobProgress.calls += 1;
      return spies.recomputeJobProgress.results[idx] ?? { queued: 0, completed: 0, failed: 0, terminal: false };
    },
    recordJobStage: async (...args: unknown[]) => {
      spies.recordJobStage.calls.push({ args });
    },
  };

  const mod = await loadModule(new URL("./index.ts", import.meta.url), {
    stubs: {
      "node:http": {
        createServer: () => ({ listen: () => undefined, close: () => undefined }),
      },
      playwright: {
        chromium: { launch: async () => { throw new Error("no browser in unit test"); } },
      },
      "drizzle-orm": drizzleStub,
      "../../src/db": { db },
      "../../src/db/schema": schemaStub,
      "../../src/lib/document-merge/queue.ts": queueStub,
      "../../src/lib/document-merge/queue-types.ts": {
        shouldRetryClaim: (attempt: number, maxAttempts = 3) => attempt < maxAttempts,
        claimRetryDelayMs: () => 0,
      },
      "../../src/lib/document-merge/html-pipeline.ts": {
        renderApplicantDocumentFromParts: () => ({ valid: true, html: "", missingFields: [], unreplaced: [] }),
      },
      "../../src/lib/storage/index.ts": { getStorageProvider: () => ({ name: "local", put: async () => ({ key: "k", url: "u" }) }) },
      "../../src/lib/document-merge/filename.ts": {
        buildIndividualPdfFilename: () => "file.pdf",
        buildIndividualStorageKey: () => "key",
      },
      "../../src/lib/document-merge/document-history.ts": {
        createDocumentHistory: async () => ({ id: "hist-1" }),
        linkRecordToHistory: async () => undefined,
      },
      "../../src/lib/document-merge/batch-finalize.ts": {
        finalizeBatchOutputs: async () => ({ pdfUrl: "p", zipUrl: "z", pdfBytes: 1, zipBytes: 1, itemCount: 1 }),
      },
      "../../src/lib/document-merge/record-loader.ts": { loadDailyApplicationRecords: async () => new Map() },
      "../../src/lib/document-merge/db-identity.ts": { getDbIdentity: async () => ({}) },
      "../../src/lib/document-merge/queue-diagnostics.ts": {
        runClaimProbe: async () => ({}),
        claimExistingJobItem: async () => ({}),
      },
      "../../src/lib/document-merge/worker-diag-gate.ts": { shouldBlockRestrictedWorkerRequest: () => false },
      "../../src/lib/document-merge/pdf-overlay/worker-overlay-e2e.ts": { runOverlayE2EJob: async () => ({ processed: 0, failed: 0 }) },
      "../../src/document-templates/registry.ts": { getHtmlTemplateContractByKey: () => null },
    },
  });
  return mod as unknown as WorkerModule;
}

function htmlJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    engine: "HTML_PDF",
    createdBy: "admin",
    createdAt: new Date("2026-08-23T00:00:00.000Z"),
    recordCount: 1,
    metadata: { templates: {}, renderedAt: "2026-08-23T00:00:00.000Z" },
    ...overrides,
  };
}

test("HTML worker: future RETRY is deferred — does not become CLAIM_STALLED or overwrite INCOMPLETE", async () => {
  const db = createFakeDb({
    respond: (call) => (call.root === "select" && call.table === "merge_jobs" ? [htmlJob()] : []),
  });
  const spies = makeQueueSpies();
  spies.allRemainingItemsAwaitingRetry = true;
  spies.claimItems.results = [];
  spies.recomputeJobProgress.results = [
    { queued: 1, completed: 0, failed: 0, terminal: false },
    { queued: 1, completed: 0, failed: 0, terminal: false },
  ];
  const worker = await loadWorker(db, spies);
  const result = await worker.runJob("job-1");
  assert.equal(result.processed, 0);
  assert.equal(result.failed, 0);
  assert.equal(spies.failAllNonTerminalItems.calls.length, 0, "must not fail items waiting for retry backoff");
  assert.equal(spies.finalizeJob.calls.length, 0, "job stays PROCESSING for the next /run");
  assert.ok(!spies.recordJobStage.calls.some((call) => call.args.includes("CLAIM_STALLED")));
});

test("HTML worker: true unclaimable QUEUED item still becomes CLAIM_STALLED", async () => {
  const db = createFakeDb({
    respond: (call) => (call.root === "select" && call.table === "merge_jobs" ? [htmlJob()] : []),
  });
  const spies = makeQueueSpies();
  spies.allRemainingItemsAwaitingRetry = false;
  spies.claimItems.results = [];
  spies.recomputeJobProgress.results = [
    { queued: 1, completed: 0, failed: 0, terminal: false },
    { queued: 0, completed: 0, failed: 1, terminal: true },
  ];
  const worker = await loadWorker(db, spies);
  const result = await worker.runJob("job-1");
  assert.equal(result.processed, 0);
  assert.equal(result.failed, 1);
  const stall = spies.failAllNonTerminalItems.calls[0];
  assert.ok(stall, "true stall must fail remaining items");
  assert.equal((stall.args[1] as { errorCode?: string }).errorCode, "CLAIM_STALLED");
  const finalize = spies.finalizeJob.calls.find((call) => call.args[1] === "FAILED");
  assert.ok(finalize, "true stall must finalize the job FAILED");
});

test("HTML worker: GOOGLE_DOCS jobs are rejected — legacy path stays untouched", async () => {
  const db = createFakeDb({
    respond: (call) => (call.root === "select" && call.table === "merge_jobs" ? [htmlJob({ engine: "GOOGLE_DOCS" })] : []),
  });
  const spies = makeQueueSpies();
  const worker = await loadWorker(db, spies);
  await assert.rejects(() => worker.runJob("job-1"), /UNSUPPORTED_WORKER_ENGINE:GOOGLE_DOCS/);
  assert.equal(spies.markJobProcessing.calls, 0);
  assert.equal(spies.failAllNonTerminalItems.calls.length, 0);
});
