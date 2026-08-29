/**
 * HTML_PDF worker runJob — future RETRY must not be classified as CLAIM_STALLED.
 * Loads the real worker module with I/O stubs (no Chromium, no listen).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, drizzleStub, makeTable, type FakeDb } from "../../src/lib/test-support/fake-drizzle.ts";
import { loadModule } from "../../src/lib/test-support/load-module.ts";
import * as signingContextModule from "../../src/lib/document-merge/signing-context.ts";

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

async function loadWorker(
  db: FakeDb,
  spies: QueueSpies,
  renderCalls: Record<string, unknown>[] = [],
  records: Map<string, Record<string, unknown>> = new Map(),
): Promise<WorkerModule> {
  const queueStub = {
    allRemainingItemsAwaitingRetry: async () => spies.allRemainingItemsAwaitingRetry,
    claimItems: async () => {
      const idx = spies.claimItems.calls;
      spies.claimItems.calls += 1;
      return (spies.claimItems.results[idx] ?? []) as unknown[];
    },
    completeItem: async () => 1,
    heartbeatItem: async () => 1,
    ITEM_LEASE_SECONDS: 60,
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
      "../../src/lib/document-merge/canonical-document.ts": {
        CANONICAL_ERROR: {
          NOT_PUBLISHED: "CANONICAL_TEMPLATE_NOT_PUBLISHED",
          SNAPSHOT_EMPTY: "CANONICAL_SNAPSHOT_EMPTY",
        },
        CANONICAL_ERROR_MESSAGE_VI: {
          CANONICAL_TEMPLATE_NOT_PUBLISHED: "Chưa xuất bản phiên bản canonical.",
          CANONICAL_SNAPSHOT_EMPTY: "Snapshot không có nội dung HTML.",
        },
        isCanonicalTemplateError: (e: unknown) =>
          Boolean(e) && (e as { name?: string }).name === "CanonicalTemplateError",
        parseCanonicalSnapshot: (raw: { htmlBody?: string | null; templateVersion?: number } | null) => {
          if (!raw?.htmlBody || typeof raw.templateVersion !== "number") {
            const err = new Error("CANONICAL_SNAPSHOT_EMPTY");
            err.name = "CanonicalTemplateError";
            Object.assign(err, {
              code: "CANONICAL_SNAPSHOT_EMPTY",
              operatorMessage: "Snapshot không có nội dung HTML.",
            });
            throw err;
          }
          return { ...raw, mappings: [], formatting: {} };
        },
        renderCanonicalDocument: (
          _snapshot: unknown,
          _recordData: unknown,
          context: Record<string, unknown>,
        ) => {
          renderCalls.push(context);
          return { valid: true, html: "", missingFields: [], unreplaced: [] };
        },
      },
      "../../src/lib/document-merge/signing-context.ts": signingContextModule,
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
      "../../src/lib/document-merge/record-loader.ts": { loadDailyApplicationRecords: async () => records },
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

test("H3: runJob threads the frozen job.metadata.signingContext into every item's render context, unchanged", async () => {
  const db = createFakeDb({
    respond: (call) =>
      call.root === "select" && call.table === "merge_jobs"
        ? [
            htmlJob({
              metadata: {
                templates: { "tpl-1": { htmlBody: "<p><<Ho_ten>></p>", templateVersion: 1 } },
                renderedAt: "2026-08-23T00:00:00.000Z",
                signingContext: { signingDate: "2026-08-26", signingLocation: "Đà Lạt" },
              },
            }),
          ]
        : [],
  });
  const spies = makeQueueSpies();
  spies.claimItems.results = [
    [{ id: "item-1", templateId: "tpl-1", sortOrder: 1, sourceRecordId: "app-1", mergeJobId: "job-1", attemptCount: 0 }],
    [],
  ];
  spies.recomputeJobProgress.results = [{ queued: 0, completed: 0, failed: 1, terminal: true }];
  const renderCalls: Record<string, unknown>[] = [];
  const records = new Map([["app-1", { id: "app-1", fullName: "Nguyễn Văn A" }]]);
  const worker = await loadWorker(db, spies, renderCalls, records);

  // No Chromium in this unit test — the item still reaches renderCanonicalDocument
  // (HTML_RENDER stage) before failing later at CHROMIUM_LAUNCH/PDF_RENDER, which
  // is exactly the point at which the render context (and its signingContext) is
  // built and passed — proving the wiring without needing a real browser.
  await worker.runJob("job-1");

  assert.equal(renderCalls.length, 1);
  const signingContext = renderCalls[0].signingContext as Record<string, unknown>;
  assert.equal(signingContext.signingDate, "2026-08-26");
  assert.equal(signingContext.signingLocation, "Đà Lạt");
  // Never a per-record wall-clock read: the value came verbatim from the
  // frozen job metadata, not from `new Date()`/geolocation inside the worker.
});

test("H3: runJob defaults to an empty (all-null) signingContext when job.metadata carries none (older jobs)", async () => {
  const db = createFakeDb({
    respond: (call) =>
      call.root === "select" && call.table === "merge_jobs"
        ? [
            htmlJob({
              metadata: {
                templates: { "tpl-1": { htmlBody: "<p><<Ho_ten>></p>", templateVersion: 1 } },
                renderedAt: "2026-08-23T00:00:00.000Z",
              },
            }),
          ]
        : [],
  });
  const spies = makeQueueSpies();
  spies.claimItems.results = [
    [{ id: "item-1", templateId: "tpl-1", sortOrder: 1, sourceRecordId: "app-1", mergeJobId: "job-1", attemptCount: 0 }],
    [],
  ];
  spies.recomputeJobProgress.results = [{ queued: 0, completed: 0, failed: 1, terminal: true }];
  const renderCalls: Record<string, unknown>[] = [];
  const records = new Map([["app-1", { id: "app-1", fullName: "Nguyễn Văn A" }]]);
  const worker = await loadWorker(db, spies, renderCalls, records);

  await worker.runJob("job-1");

  assert.equal(renderCalls.length, 1);
  const signingContext = renderCalls[0].signingContext as Record<string, unknown>;
  assert.equal(signingContext.signingDate, null);
  assert.equal(signingContext.signingLocation, null);
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
