/**
 * PDF Overlay — worker runner (worker-overlay-e2e.ts) tests (PR5).
 *
 * Chạy ĐÚNG source thật của runner qua loadModule (xem load-module.ts), với
 * queue/history/storage được spy để kiểm tra:
 *   - job không tồn tại / engine sai / snapshot sai → lỗi rõ ràng
 *   - success: render → sha256 → storage → history → completeItem (không
 *     duplicate), finalizeJob COMPLETED kèm batch outputs
 *   - storage failure: failItem RENDER_FAILED, KHÔNG history, KHÔNG completeItem
 *   - retry semantics: item RETRY chờ backoff → worker defer (không fail job)
 *   - CLAIM_STALLED: item QUEUED không claim được → fail job + fail items
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createFakeDb, drizzleStub, makeTable, type FakeDb } from "../../test-support/fake-drizzle.ts";
import { loadModule } from "../../test-support/load-module.ts";
import { buildStagingE2ESnapshot, renderStagingE2EItem, type OverlayE2ESnapshot } from "./staging-e2e.ts";
import { PdfOverlayError } from "./types.ts";
import { buildIndividualPdfFilename, buildIndividualStorageKey } from "../filename.ts";
import { assertOverlayRequiredSchema as realAssertOverlayRequiredSchema, OverlaySchemaError } from "./required-schema.ts";

const schemaStub = {
  mergeJobs: makeTable("merge_jobs"),
  mergeJobRecords: makeTable("merge_job_records"),
};

interface QueueSpies {
  claimItems: { calls: number; results: unknown[][]; impl?: () => Promise<unknown[]> };
  completeItem: { calls: { args: unknown[] }[] };
  failItem: { calls: { args: unknown[] }[] };
  failAllNonTerminalItems: { calls: { args: unknown[] }[] };
  finalizeJob: { calls: { args: unknown[] }[] };
  markJobProcessing: { calls: number };
  recomputeJobProgress: { calls: number; results: unknown[] };
  recordJobStage: { calls: { args: unknown[] }[] };
}

function makeQueueSpies(): QueueSpies {
  const spies: QueueSpies = {
    claimItems: { calls: 0, results: [] },
    completeItem: { calls: [] },
    failItem: { calls: [] },
    failAllNonTerminalItems: { calls: [] },
    finalizeJob: { calls: [] },
    markJobProcessing: { calls: 0 },
    recomputeJobProgress: { calls: 0, results: [] },
    recordJobStage: { calls: [] },
  };
  spies.claimItems.impl = async () => {
    const idx = spies.claimItems.calls;
    spies.claimItems.calls += 1;
    return (spies.claimItems.results[idx] ?? []) as unknown[];
  };
  return spies;
}

type RunnerModule = {
  runOverlayE2EJob: (jobId: string, options?: Record<string, unknown>) => Promise<{ processed: number; failed: number }>;
  processOverlayE2EItem: (item: unknown, ctx: Record<string, unknown>) => Promise<void>;
  allRemainingItemsAwaitingRetry: (jobId: string) => Promise<boolean>;
};

const QUEUE_STUB_NAMES = [
  "claimItems",
  "completeItem",
  "failItem",
  "failAllNonTerminalItems",
  "finalizeJob",
  "markJobProcessing",
  "recomputeJobProgress",
  "recordJobStage",
];

function buildQueueStub(spies: QueueSpies): Record<string, unknown> {
  const stub: Record<string, unknown> = {};
  for (const name of QUEUE_STUB_NAMES) {
    if (name === "claimItems") {
      stub[name] = spies.claimItems.impl;
    } else if (name === "completeItem") {
      stub[name] = async (...args: unknown[]) => { spies.completeItem.calls.push({ args }); };
    } else if (name === "failItem") {
      stub[name] = async (...args: unknown[]) => { spies.failItem.calls.push({ args }); };
    } else if (name === "failAllNonTerminalItems") {
      stub[name] = async (...args: unknown[]) => { spies.failAllNonTerminalItems.calls.push({ args }); return 1; };
    } else if (name === "finalizeJob") {
      stub[name] = async (...args: unknown[]) => { spies.finalizeJob.calls.push({ args }); };
    } else if (name === "markJobProcessing") {
      stub[name] = async () => { spies.markJobProcessing.calls += 1; };
    } else if (name === "recomputeJobProgress") {
      stub[name] = async () => {
        const idx = spies.recomputeJobProgress.calls;
        spies.recomputeJobProgress.calls += 1;
        return (spies.recomputeJobProgress.results[idx] ?? { queued: 0, completed: 0, failed: 0, terminal: false });
      };
    } else if (name === "recordJobStage") {
      stub[name] = async (...args: unknown[]) => { spies.recordJobStage.calls.push({ args }); };
    }
  }
  return stub;
}

function makeHistoryStub() {
  const calls: { args: unknown[] }[] = [];
  return {
    createDocumentHistory: async (...args: unknown[]) => {
      calls.push({ args });
      return { id: "11111111-1111-4111-8111-111111111111" };
    },
    linkRecordToHistory: async () => undefined,
    calls,
  };
}

async function loadRunner(db: FakeDb, spies: QueueSpies, historyStub: ReturnType<typeof makeHistoryStub>, opts: { storageThrows?: boolean; realPreflight?: boolean } = {}) {
  const snapshot = await buildStagingE2ESnapshot(1);
  const mod = await loadModule(new URL("./worker-overlay-e2e.ts", import.meta.url), {
    stubs: {
      "drizzle-orm": drizzleStub,
      "../../../db": { db },
      "../../../db/schema": schemaStub,
      "../../storage/index.ts": {
        getStorageProvider: () => {
          throw new Error("storage provider không dùng trong test (inject qua options.storage)");
        },
      },
      "../queue.ts": buildQueueStub(spies),
      "../queue-types.ts": {
        claimRetryDelayMs: (attempt: number) => Math.min(2000, 250 * 2 ** Math.max(0, attempt - 1)),
        shouldRetryClaim: (attempt: number, maxAttempts = 3) => attempt < maxAttempts,
      },
      "../document-history.ts": historyStub,
      "../filename.ts": { buildIndividualPdfFilename, buildIndividualStorageKey },
      "../batch-finalize.ts": {
        finalizeBatchOutputs: async () => ({
          pdfUrl: "https://batch/pdf.pdf",
          zipUrl: "https://batch/out.zip",
          pdfFileId: "batch-pdf",
          zipFileId: "batch-zip",
          pdfKey: "Batch Outputs/2026/08/job/batch.pdf",
          zipKey: "Batch Outputs/2026/08/job/out.zip",
          pdfBytes: 100,
          zipBytes: 200,
          itemCount: 1,
        }),
      },
      "./types.ts": { PdfOverlayError },
      "./required-schema.ts": {
        // Mặc định no-op để các test path-bình-thường chạy "như trước" (preflight
        // đã thoả). realPreflight=true → dùng assertOverlayRequiredSchema THẬT để
        // kiểm chứng default path phát hiện schema thiếu (yêu cầu root-cause #3).
        assertOverlayRequiredSchema: opts.realPreflight ? realAssertOverlayRequiredSchema : async () => undefined,
        checkOverlaySchema: async () => ({ ok: true, requiredTableCount: 3, observedTableCount: 3, missingTables: [], missingColumns: [] }),
        OverlaySchemaError,
      },
      "./staging-e2e.ts": {
        OVERLAY_E2E_DOCUMENT_TYPE: "PDF-Overlay-E2E",
        OVERLAY_E2E_ENGINE: "PDF_OVERLAY",
        OVERLAY_E2E_RETENTION_YEARS: 3,
        assertStagingE2EItemComplete: () => ({ ok: true, detail: "ok" }),
        buildStagingE2EFieldValues: (base: Record<string, string>, index: number, total: number) => ({ ...base, So_thu_tu: String(index), Tong_so: String(total) }),
        parseOverlayE2ESnapshot: (metadata: unknown) => {
          const e2e = (metadata as { e2e?: unknown }).e2e;
          if (typeof e2e !== "object" || e2e === null) throw new Error("OVERLAY_E2E_SNAPSHOT_INVALID: thiếu metadata.e2e.");
          return e2e as OverlayE2ESnapshot;
        },
        renderStagingE2EItem: async (snap: OverlayE2ESnapshot, index: number, total: number) => {
          if (opts.storageThrows) {
            // render thành công bình thường — storage là thứ throw
          }
          return renderStagingE2EItem(snap, index, total);
        },
      },
    },
  });
  return mod as unknown as RunnerModule;
}

function jobRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "job-1",
    engine: "PDF_OVERLAY",
    createdBy: "staging-e2e-overlay",
    metadata: {},
    templateNameSnapshot: "",
    status: "QUEUED",
    ...overrides,
  };
}

test("worker-overlay-e2e: job không tồn tại → throw 'job not found'", async () => {
  const db = createFakeDb({ respond: () => [] });
  const spies = makeQueueSpies();
  const runner = await loadRunner(db, spies, makeHistoryStub());
  await assert.rejects(() => runner.runOverlayE2EJob("missing-job", { storage: {} as never }), /job not found/);
});

test("worker-overlay-e2e: engine không phải PDF_OVERLAY → throw ENGINE_MISMATCH", async () => {
  const db = createFakeDb({
    respond: (call) => (call.root === "select" && call.table === "merge_jobs" ? [jobRow({ engine: "HTML_PDF" })] : []),
  });
  const spies = makeQueueSpies();
  const runner = await loadRunner(db, spies, makeHistoryStub());
  await assert.rejects(() => runner.runOverlayE2EJob("job-1", { storage: {} as never }), /OVERLAY_E2E_ENGINE_MISMATCH/);
});

test("worker-overlay-e2e: snapshot thiếu → throw SNAPSHOT_INVALID", async () => {
  const db = createFakeDb({
    respond: (call) => (call.root === "select" && call.table === "merge_jobs" ? [jobRow({ metadata: {} })] : []),
  });
  const spies = makeQueueSpies();
  const runner = await loadRunner(db, spies, makeHistoryStub());
  await assert.rejects(() => runner.runOverlayE2EJob("job-1", { storage: {} as never }), /OVERLAY_E2E_SNAPSHOT_INVALID/);
});

test("worker-overlay-e2e: success — render→sha256→storage→history→complete→COMPLETED + batch outputs", async () => {
  const snapshot = await buildStagingE2ESnapshot(1);
  const db = createFakeDb({
    respond: (call) => {
      if (call.root === "select" && call.table === "merge_jobs") return [jobRow({ metadata: { e2e: snapshot } })];
      if (call.root === "select" && call.table === "merge_job_records") return [];
      return { rowCount: 1 };
    },
  });
  const spies = makeQueueSpies();
  spies.claimItems.results = [
    [{ id: "item-1", mergeJobId: "job-1", sourceEntity: "staging_e2e_fixture", sourceRecordId: "22222222-2222-4222-8222-222222222222", templateId: null, sortOrder: 1, status: "QUEUED", attemptCount: 0 }],
  ];
  spies.recomputeJobProgress.results = [
    { queued: 0, completed: 1, failed: 0, terminal: false },
    { queued: 0, completed: 1, failed: 0, terminal: false },
    { queued: 0, completed: 1, failed: 0, terminal: true },
  ];

  const historyStub = makeHistoryStub();
  const runner = await loadRunner(db, spies, historyStub);
  const stored: { key: string; url: string }[] = [];
  const storage = {
    name: "local",
    put: async (key: string, _bytes: Uint8Array, _mime: string) => {
      stored.push({ key, url: `file://${key}` });
      return { key, url: `file://${key}` };
    },
    getMetadata: async () => ({ size: 10 }),
  };

  const result = await runner.runOverlayE2EJob("job-1", { storage: storage as never, concurrency: 1 });
  assert.equal(result.processed, 1);
  assert.equal(result.failed, 0);

  // completeItem được gọi với sha256 thật (khớp render deterministic)
  const expectedSha = (await renderStagingE2EItem(snapshot, 1, 1)).sha256;
  const completeArgs = spies.completeItem.calls[0]?.args[1] as { sha256?: string; storageKey?: string; documentHistoryId?: string };
  assert.equal(completeArgs?.sha256, expectedSha);
  assert.ok(completeArgs?.storageKey?.startsWith("Candidate Documents/"));
  assert.equal(completeArgs?.documentHistoryId, "11111111-1111-4111-8111-111111111111");

  // history được tạo đúng 1 lần với sha256 khớp
  assert.equal(historyStub.calls.length, 1);
  const historyArgs = historyStub.calls[0].args[0] as { sha256?: string; storageFileId?: string; applicationId?: string; documentType?: string };
  assert.equal(historyArgs.sha256, expectedSha);
  assert.equal(historyArgs.storageFileId, completeArgs?.storageKey);
  assert.equal(historyArgs.applicationId, "22222222-2222-4222-8222-222222222222");
  assert.equal(historyArgs.documentType, "PDF-Overlay-E2E");

  // finalize COMPLETED kèm batch outputs
  const finalize = spies.finalizeJob.calls.find((c) => c.args[1] === "COMPLETED");
  assert.ok(finalize, "finalizeJob COMPLETED được gọi");
  const finalizeExtra = finalize.args[2] as { outputPdfUrl?: string; outputZipUrl?: string };
  assert.equal(finalizeExtra?.outputPdfUrl, "https://batch/pdf.pdf");
  assert.equal(finalizeExtra?.outputZipUrl, "https://batch/out.zip");
  assert.equal(stored.length, 1, "đúng 1 object được ghi storage (không duplicate)");
});

test("worker-overlay-e2e: storage failure → failItem RENDER_FAILED, KHÔNG history, KHÔNG completeItem, KHÔNG finalize COMPLETED", async () => {
  const snapshot = await buildStagingE2ESnapshot(1);
  const db = createFakeDb({
    respond: (call) => {
      if (call.root === "select" && call.table === "merge_jobs") return [jobRow({ metadata: { e2e: snapshot } })];
      // allRemainingItemsAwaitingRetry: item đang RETRY chờ backoff → defer
      if (call.root === "select" && call.table === "merge_job_records") {
        return [{ status: "RETRY", retryAt: new Date(Date.now() + 60_000) }];
      }
      return { rowCount: 1 };
    },
  });
  const spies = makeQueueSpies();
  spies.claimItems.results = [
    [{ id: "item-1", mergeJobId: "job-1", sourceEntity: "staging_e2e_fixture", sourceRecordId: "22222222-2222-4222-8222-222222222222", templateId: null, sortOrder: 1, status: "QUEUED", attemptCount: 0 }],
  ];
  spies.recomputeJobProgress.results = [
    { queued: 1, completed: 0, failed: 0, terminal: false },
    { queued: 1, completed: 0, failed: 0, terminal: false },
    { queued: 1, completed: 0, failed: 0, terminal: false },
  ];

  const historyStub = makeHistoryStub();
  const runner = await loadRunner(db, spies, historyStub, { storageThrows: true });
  const storage = {
    name: "local",
    put: async () => {
      throw new Error("storage unavailable (simulated)");
    },
  };

  const result = await runner.runOverlayE2EJob("job-1", { storage: storage as never, concurrency: 1, maxIterations: 5 });
  assert.equal(result.processed, 0);
  assert.equal(result.failed, 1);

  const failCall = spies.failItem.calls[0];
  assert.ok(failCall, "failItem được gọi");
  assert.equal((failCall.args[1] as { errorCode?: string }).errorCode, "RENDER_FAILED");
  assert.equal(failCall.args[0], "item-1");
  assert.equal(historyStub.calls.length, 0, "KHÔNG tạo history khi storage fail");
  assert.equal(spies.completeItem.calls.length, 0, "KHÔNG completeItem khi storage fail");
  assert.ok(!spies.finalizeJob.calls.some((c) => c.args[1] === "COMPLETED"), "KHÔNG finalize COMPLETED khi có item lỗi chưa terminal");
});

test("worker-overlay-e2e: item RETRY chờ backoff → worker defer, KHÔNG fail job (retry semantics)", async () => {
  const snapshot = await buildStagingE2ESnapshot(1);
  const db = createFakeDb({
    respond: (call) => {
      if (call.root === "select" && call.table === "merge_jobs") return [jobRow({ metadata: { e2e: snapshot } })];
      if (call.root === "select" && call.table === "merge_job_records") {
        return [{ status: "RETRY", retryAt: new Date(Date.now() + 60_000) }];
      }
      return { rowCount: 1 };
    },
  });
  const spies = makeQueueSpies();
  spies.claimItems.results = [];
  spies.recomputeJobProgress.results = [
    { queued: 1, completed: 0, failed: 0, terminal: false },
    { queued: 1, completed: 0, failed: 0, terminal: false },
    { queued: 1, completed: 0, failed: 0, terminal: false },
  ];
  const runner = await loadRunner(db, spies, makeHistoryStub());
  const result = await runner.runOverlayE2EJob("job-1", { storage: {} as never, concurrency: 1 });
  assert.equal(result.processed, 0);
  assert.equal(result.failed, 0);
  assert.equal(spies.failAllNonTerminalItems.calls.length, 0, "KHÔNG fail items khi đang chờ backoff");
  assert.equal(spies.finalizeJob.calls.length, 0, "KHÔNG finalize (job giữ PROCESSING chờ lần /run kế tiếp)");
});

test("worker-overlay-e2e: item QUEUED không claim được → CLAIM_STALLED: fail job + fail items (parity)", async () => {
  const snapshot = await buildStagingE2ESnapshot(1);
  const db = createFakeDb({
    respond: (call) => {
      if (call.root === "select" && call.table === "merge_jobs") return [jobRow({ metadata: { e2e: snapshot } })];
      if (call.root === "select" && call.table === "merge_job_records") {
        return [{ status: "QUEUED", retryAt: null }];
      }
      return { rowCount: 1 };
    },
  });
  const spies = makeQueueSpies();
  spies.claimItems.results = [];
  spies.recomputeJobProgress.results = [
    { queued: 1, completed: 0, failed: 0, terminal: false },
    { queued: 1, completed: 0, failed: 0, terminal: false },
    { queued: 1, completed: 0, failed: 0, terminal: false },
    { queued: 0, completed: 0, failed: 1, terminal: true },
  ];
  const runner = await loadRunner(db, spies, makeHistoryStub());
  const result = await runner.runOverlayE2EJob("job-1", { storage: {} as never, concurrency: 1, maxIterations: 5 });
  assert.equal(result.processed, 0);
  assert.equal(result.failed, 1);
  const stall = spies.failAllNonTerminalItems.calls[0];
  assert.ok(stall, "failAllNonTerminalItems được gọi");
  assert.equal((stall.args[1] as { errorCode?: string }).errorCode, "CLAIM_STALLED");
  const finalize = spies.finalizeJob.calls.find((c) => c.args[1] === "FAILED");
  assert.ok(finalize, "finalizeJob FAILED được gọi");
});

test("worker-overlay-e2e: SCHEMA_MISMATCH (default preflight, schema thiếu) → throw TRƯỚC overlay query, KHÔNG side effect", async () => {
  // realPreflight=true → default path chạy assertOverlayRequiredSchema THẬT qua
  // makeDrizzleSchemaQuerier(db). Fake db.execute trả rows rỗng → probe thấy 0
  // bảng → thiếu toàn bộ → SCHEMA_MISMATCH (yêu cầu root-cause #3, #4, #8).
  const db = createFakeDb({ respond: () => [] });
  const spies = makeQueueSpies();
  const runner = await loadRunner(db, spies, makeHistoryStub(), { realPreflight: true });

  await assert.rejects(
    () => runner.runOverlayE2EJob("job-1", { storage: {} as never }),
    (err: unknown) => {
      assert.ok(err instanceof OverlaySchemaError, "phải là OverlaySchemaError");
      assert.equal((err as OverlaySchemaError).code, "SCHEMA_MISMATCH");
      assert.match((err as Error).message, /SCHEMA_MISMATCH/);
      // Chẩn đoán chỉ rõ bảng thiếu (operator biết migration nào thiếu).
      assert.match((err as Error).message, /merge_jobs/);
      assert.match((err as Error).message, /merge_job_records/);
      assert.match((err as Error).message, /document_history/);
      return true;
    },
  );

  // Preflight chặn TRƯỚC overlay query: KHÔNG select merge_jobs, KHÔNG side effect.
  assert.equal(
    db.calls.some((c) => c.root === "select" && c.table === "merge_jobs"),
    false,
    "KHÔNG thực hiện overlay query (merge_jobs select) khi schema thiếu",
  );
  assert.equal(spies.markJobProcessing.calls, 0, "KHÔNG markJobProcessing");
  assert.equal(spies.claimItems.calls, 0, "KHÔNG claimItems");
  assert.equal(spies.finalizeJob.calls.length, 0, "KHÔNG finalizeJob");
});

test("worker-overlay-e2e: SCHEMA_MISMATCH (inject assertSchema) → propagate, KHÔNG side effect", async () => {
  const db = createFakeDb({ respond: () => [] });
  const spies = makeQueueSpies();
  const runner = await loadRunner(db, spies, makeHistoryStub());

  const schemaErr = new OverlaySchemaError({
    ok: false,
    requiredTableCount: 3,
    observedTableCount: 2,
    missingTables: ["document_history"],
    missingColumns: [],
  });

  await assert.rejects(
    () => runner.runOverlayE2EJob("job-1", { storage: {} as never, assertSchema: async () => { throw schemaErr; } }),
    (err: unknown) => {
      assert.ok(err instanceof OverlaySchemaError);
      assert.equal((err as OverlaySchemaError).code, "SCHEMA_MISMATCH");
      return true;
    },
  );

  assert.equal(
    db.calls.some((c) => c.root === "select" && c.table === "merge_jobs"),
    false,
    "overlay query không chạy khi assertSchema throw",
  );
  assert.equal(spies.markJobProcessing.calls, 0);
  assert.equal(spies.claimItems.calls, 0);
  assert.equal(spies.finalizeJob.calls.length, 0);
});

test("worker-overlay-e2e: schema hợp lệ → preflight pass, path thành công vẫn như cũ", async () => {
  // Mặc định preflight no-op (đã "thoả") → success path KHÔNG đổi so với trước.
  const snapshot = await buildStagingE2ESnapshot(1);
  const db = createFakeDb({
    respond: (call) => {
      if (call.root === "select" && call.table === "merge_jobs") return [jobRow({ metadata: { e2e: snapshot } })];
      if (call.root === "select" && call.table === "merge_job_records") return [];
      return { rowCount: 1 };
    },
  });
  const spies = makeQueueSpies();
  spies.claimItems.results = [
    [{ id: "item-1", mergeJobId: "job-1", sourceEntity: "staging_e2e_fixture", sourceRecordId: "22222222-2222-4222-8222-222222222222", templateId: null, sortOrder: 1, status: "QUEUED", attemptCount: 0 }],
  ];
  spies.recomputeJobProgress.results = [
    { queued: 0, completed: 1, failed: 0, terminal: false },
    { queued: 0, completed: 1, failed: 0, terminal: false },
    { queued: 0, completed: 1, failed: 0, terminal: true },
  ];
  const runner = await loadRunner(db, spies, makeHistoryStub());
  const storage = {
    name: "local",
    put: async (key: string) => ({ key, url: `file://${key}` }),
    getMetadata: async () => ({ size: 10 }),
  };
  const result = await runner.runOverlayE2EJob("job-1", { storage: storage as never, concurrency: 1 });
  assert.equal(result.processed, 1);
  assert.equal(result.failed, 0);
  assert.ok(spies.finalizeJob.calls.some((c) => c.args[1] === "COMPLETED"), "vẫn finalize COMPLETED");
});
