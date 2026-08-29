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
  reclaimStalledItems: { calls: number };
  casSyncJobCompleted: { calls: { args: unknown[] }[] };
  casSyncJobFailed: { calls: { args: unknown[] }[] };
  listCompletedItemsInOrder: { calls: number; results: unknown[][] };
  completeItem: { calls: { args: unknown[] }[] };
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
    reclaimStalledItems: { calls: 0 },
    casSyncJobCompleted: { calls: [] },
    casSyncJobFailed: { calls: [] },
    listCompletedItemsInOrder: { calls: 0, results: [] },
    completeItem: { calls: [] },
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
  googleDocsCalls: { create: { title: string; content: string; folderId?: string }[] } = { create: [] },
  googleDocsFailure?: (title: string) => Error | null,
): Promise<WorkerModule> {
  const queueStub = {
    allRemainingItemsAwaitingRetry: async () => spies.allRemainingItemsAwaitingRetry,
    claimItems: async () => {
      const idx = spies.claimItems.calls;
      spies.claimItems.calls += 1;
      return (spies.claimItems.results[idx] ?? []) as unknown[];
    },
    completeItem: async (...args: unknown[]) => {
      spies.completeItem.calls.push({ args });
      return 1;
    },
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
    reclaimStalledItems: async () => {
      spies.reclaimStalledItems.calls += 1;
      return 0;
    },
    casSyncJobCompleted: async (...args: unknown[]) => {
      spies.casSyncJobCompleted.calls.push({ args });
      return true;
    },
    casSyncJobFailed: async (...args: unknown[]) => {
      spies.casSyncJobFailed.calls.push({ args });
      return true;
    },
    listCompletedItemsInOrder: async () => {
      const idx = spies.listCompletedItemsInOrder.calls;
      spies.listCompletedItemsInOrder.calls += 1;
      return spies.listCompletedItemsInOrder.results[idx] ?? [];
    },
  };

  const googleServiceStub = {
    getDocumentContent: async () => "MẪU <<Ho_ten>>",
    createDocument: async (title: string, content: string, folderId?: string) => {
      const failure = googleDocsFailure?.(title) ?? null;
      if (failure) throw failure;
      googleDocsCalls.create.push({ title, content, folderId });
      return "doc-out-1";
    },
    trashFile: async () => undefined,
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
      "../../src/lib/document-merge/google-docs-service.ts": {
        createGoogleDocsService: () => googleServiceStub,
        isTransientGoogleDocsError: (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error ?? "");
          return /timed out|timeout|429|500|502|503|fetch failed/i.test(message);
        },
      },
      "../../src/lib/document-merge/google-drive-pdf.ts": {
        exportGoogleDocAsPdf: async () => new Uint8Array([1]),
        uploadPdfToDrive: async () => ({ id: "pdf-merged", webViewLink: "https://drive/pdf-merged", webContentLink: null }),
      },
      "../../src/lib/document-merge/batch-pdf.ts": {
        mergePdfBuffers: async () => new Uint8Array([1, 2]),
      },
      "../../src/lib/document-merge/data-resolver.ts": {
        resolveAllFields: () => ({}),
        validateRequiredFields: () => ({ missingFields: [] }),
      },
      "../../src/lib/document-merge/preview-merge.ts": {
        applyFallbackPlaceholders: (_data: unknown, mapped: Record<string, string>) => ({ ...mapped }),
        buildPreviewContent: (content: string) => ({ content }),
      },
      "../../src/lib/document-merge/template-routing.ts": {
        googleDocEditUrl: (id: string) => `https://docs.google.com/document/d/${id}/edit`,
        googleDocPdfUrl: (id: string) => `https://docs.google.com/document/d/${id}/export?format=pdf`,
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

function googleDocsJob(overrides: Record<string, unknown> = {}) {
  return {
    id: "job-gd",
    engine: "GOOGLE_DOCS",
    createdBy: "hr",
    createdAt: new Date("2026-08-29T00:06:26.000Z"),
    recordCount: 1,
    metadata: {
      renderedAt: "2026-08-29T00:06:26.000Z",
      googleDocs: {
        batchPrint: false,
        dispatchToApplicant: false,
        outputStrategy: "INDIVIDUAL_DOCS",
        currentUserId: "user-1",
        currentUserName: "HR Staff",
        templates: {
          "tpl-1": {
            templateId: "tpl-1",
            name: "Đăng ký tập nghề - Quy định tập nghề",
            documentKind: "DW_CU",
            googleDocId: "google-doc-16",
            outputFolderId: "folder-1",
            fields: [
              {
                id: "f1",
                placeholder: "Ho_ten",
                sourceType: "FIELD",
                sourceEntity: "daily_applications",
                sourceField: "fullName",
                sourcePath: null,
                optionValue: null,
                formatType: null,
                fallbackValue: null,
                isRequired: false,
              },
            ],
          },
        },
      },
    },
    ...overrides,
  };
}

function googleDocsItem() {
  return {
    id: "item-1",
    templateId: "tpl-1",
    sortOrder: 1,
    sourceRecordId: "app-1",
    mergeJobId: "job-gd",
    attemptCount: 0,
  };
}

test("GOOGLE_DOCS worker: runJob self-heals (reclaim), processes the item, CAS-completes the job with the Doc URL", async () => {
  const db = createFakeDb({
    respond: (call) => (call.root === "select" && call.table === "merge_jobs" ? [googleDocsJob()] : []),
  });
  const spies = makeQueueSpies();
  spies.claimItems.results = [[googleDocsItem()], []];
  spies.recomputeJobProgress.results = [
    { queued: 0, completed: 1, failed: 0, terminal: true },
    { queued: 0, completed: 1, failed: 0, terminal: true },
    { queued: 0, completed: 1, failed: 0, terminal: true },
  ];
  spies.listCompletedItemsInOrder.results = [[{ id: "item-1", sortOrder: 1, pdfUrl: "https://docs.google.com/document/d/doc-out-1/edit", storageKey: "doc-out-1" }]];
  const records = new Map([["app-1", { id: "app-1", fullName: "Nguyễn Văn A" }]]);
  const googleCalls = { create: [] as { title: string; content: string; folderId?: string }[] };
  const worker = await loadWorker(db, spies, [], records, googleCalls);

  const result = await worker.runJob("job-gd");
  assert.equal(result.processed, 1);
  assert.equal(result.failed, 0);

  // Self-healing reclaim runs before any claim (expired-lease items → RETRY).
  assert.equal(spies.reclaimStalledItems.calls, 1, "runJob must reclaim expired-lease items first");

  // The Google Doc copy went to the right template folder with the rendered content.
  assert.equal(googleCalls.create.length, 1);
  assert.match(googleCalls.create[0].title, /^DW_CU_Nguyễn Văn A_job-gd_app-1$/);
  assert.equal(googleCalls.create[0].content, "MẪU <<Ho_ten>>");
  assert.equal(googleCalls.create[0].folderId, "folder-1");

  // CAS item completion stores the Doc id + edit URL.
  const completeCall = spies.completeItem.calls[0];
  assert.ok(completeCall);
  assert.equal(completeCall.args[0], "item-1");
  const output = completeCall.args[1] as { storageKey?: string; pdfUrl?: string };
  assert.equal(output.storageKey, "doc-out-1");
  assert.match(output.pdfUrl ?? "", /docs\.google\.com\/document\/d\/doc-out-1\/edit/);

  // Job CAS-commits with the Doc as output (never a plain finalizeJob write).
  assert.equal(spies.casSyncJobCompleted.calls.length, 1);
  const jobArgs = spies.casSyncJobCompleted.calls[0].args;
  assert.equal(jobArgs[0], "job-gd");
  const jobOutput = jobArgs[1] as { outputDocId?: string | null; outputUrl?: string | null };
  assert.equal(jobOutput.outputDocId, "doc-out-1");
  assert.match(jobOutput.outputUrl ?? "", /doc-out-1\/edit/);
  assert.equal(spies.finalizeJob.calls.length, 0, "GOOGLE_DOCS success must go through the CAS helper");
});

test("GOOGLE_DOCS worker: transient Google error retries the item (retryable), a 403 fails deterministically", async () => {
  const transientDb = createFakeDb({
    respond: (call) => (call.root === "select" && call.table === "merge_jobs" ? [googleDocsJob()] : []),
  });
  const transientSpies = makeQueueSpies();
  transientSpies.claimItems.results = [[googleDocsItem()], []];
  transientSpies.recomputeJobProgress.results = [
    { queued: 0, completed: 0, failed: 1, terminal: true },
    { queued: 0, completed: 0, failed: 1, terminal: true },
    { queued: 0, completed: 0, failed: 1, terminal: true },
  ];
  const transientWorker = await loadWorker(
    transientDb,
    transientSpies,
    [],
    new Map([["app-1", { id: "app-1", fullName: "Nguyễn Văn A" }]]),
    { create: [] },
    () => new Error("Google API request timed out after 30000ms"),
  );
  await transientWorker.runJob("job-gd");
  const retryFail = transientSpies.failItem.calls[0];
  assert.ok(retryFail);
  const retryOpts = retryFail.args[2] as { attemptCount?: number; retryable?: boolean };
  assert.equal(retryOpts.retryable, true, "timeout must be retryable (standard attempt cap applies)");
  assert.ok(
    transientSpies.casSyncJobFailed.calls.length >= 1,
    "all-failed GOOGLE_DOCS job is failed loudly via CAS",
  );

  const forbiddenDb = createFakeDb({
    respond: (call) => (call.root === "select" && call.table === "merge_jobs" ? [googleDocsJob()] : []),
  });
  const forbiddenSpies = makeQueueSpies();
  forbiddenSpies.claimItems.results = [[googleDocsItem()], []];
  forbiddenSpies.recomputeJobProgress.results = [
    { queued: 0, completed: 0, failed: 1, terminal: true },
    { queued: 0, completed: 0, failed: 1, terminal: true },
    { queued: 0, completed: 0, failed: 1, terminal: true },
  ];
  const forbiddenWorker = await loadWorker(
    forbiddenDb,
    forbiddenSpies,
    [],
    new Map([["app-1", { id: "app-1", fullName: "Nguyễn Văn A" }]]),
    { create: [] },
    () => new Error("Google API 403: The caller does not have permission"),
  );
  await forbiddenWorker.runJob("job-gd");
  const forbiddenFail = forbiddenSpies.failItem.calls[0];
  const forbiddenOpts = forbiddenFail.args[2] as { attemptCount?: number; retryable?: boolean };
  assert.equal(forbiddenOpts.retryable, false, "403 is deterministic — fail immediately, do not spin the queue");
});

test("GOOGLE_DOCS worker: batch print exports each completed Doc, merges and uploads the combined PDF once", async () => {
  const db = createFakeDb({
    respond: (call) => (call.root === "select" && call.table === "merge_jobs" ? [googleDocsJob({ metadata: { renderedAt: "2026-08-29T00:06:26.000Z", googleDocs: { ...(googleDocsJob().metadata as { googleDocs: Record<string, unknown> }).googleDocs, batchPrint: true, outputStrategy: "INDIVIDUAL_DOCS_PLUS_BATCH_PDF" } } })] : []),
  });
  const spies = makeQueueSpies();
  spies.claimItems.results = [[googleDocsItem()], []];
  spies.recomputeJobProgress.results = [
    { queued: 0, completed: 1, failed: 0, terminal: true },
    { queued: 0, completed: 1, failed: 0, terminal: true },
    { queued: 0, completed: 1, failed: 0, terminal: true },
  ];
  spies.listCompletedItemsInOrder.results = [
    [{ id: "item-1", sortOrder: 1, pdfUrl: "https://docs.google.com/document/d/doc-out-1/edit", storageKey: "doc-out-1" }],
  ];
  const records = new Map([["app-1", { id: "app-1", fullName: "Nguyễn Văn A" }]]);
  const worker = await loadWorker(db, spies, [], records, { create: [] });

  await worker.runJob("job-gd");

  const jobArgs = spies.casSyncJobCompleted.calls[0].args;
  const jobOutput = jobArgs[1] as {
    outputDocId?: string | null;
    outputUrl?: string | null;
    metadata?: { printUrl?: string | null; printDocId?: string | null; individualDocs?: unknown[] };
  };
  assert.equal(jobOutput.outputDocId, "pdf-merged", "job output = the uploaded merged PDF");
  assert.equal(jobOutput.outputUrl, "https://drive/pdf-merged");
  assert.equal(jobOutput.metadata?.printDocId, "pdf-merged");
  assert.equal(jobOutput.metadata?.individualDocs?.length, 1, "individual Doc references preserved");
});

test("GOOGLE_DOCS worker: legacy job without the frozen googleDocs snapshot fails loudly (never stuck PROCESSING)", async () => {
  const db = createFakeDb({
    respond: (call) =>
      call.root === "select" && call.table === "merge_jobs"
        ? [googleDocsJob({ metadata: { renderedAt: "2026-08-28T10:07:55.000Z" } })]
        : [],
  });
  const spies = makeQueueSpies();
  const worker = await loadWorker(db, spies);
  await assert.rejects(() => worker.runJob("job-gd"), /GOOGLE_DOCS_METADATA_MISSING/);
  assert.equal(spies.failAllNonTerminalItems.calls.length, 1, "remaining items failed visibly");
  assert.equal(spies.casSyncJobFailed.calls.length, 1, "job failed via CAS");
});

test("worker: unknown engines are still rejected", async () => {
  const db = createFakeDb({
    respond: (call) => (call.root === "select" && call.table === "merge_jobs" ? [htmlJob({ engine: "PDF_OVERLAY" })] : []),
  });
  const spies = makeQueueSpies();
  const worker = await loadWorker(db, spies);
  await assert.rejects(() => worker.runJob("job-1"), /UNSUPPORTED_WORKER_ENGINE:PDF_OVERLAY/);
  assert.equal(spies.markJobProcessing.calls, 0);
});
