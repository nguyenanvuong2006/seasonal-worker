/**
 * POST /api/document-merge/verification/run-test — fail-fast regression tests.
 *
 * Trước fix: dù workerTrigger trả 401 (job sẽ KHÔNG BAO GIỜ tự chạy), route
 * vẫn polling job 120s (60 x 2s) trước khi trả FAIL — verification treo gần
 * 2.5 phút để báo 1 lỗi đã biết ngay từ bước trigger. Test này khẳng định:
 * trigger thất bại → dừng NGAY, không polling; trigger thành công → polling
 * vẫn chạy bình thường (không đổi hành vi đường thành công).
 *
 * Theo đúng khuôn mẫu src/app/api/cron/run/route.test.ts: transpile CHÍNH
 * source route.ts thật (không viết lại) sang CommonJS, chạy trong vm sandbox
 * với "require" giả cho MỌI import bên ngoài route.ts thật sự dùng. drizzle
 * dùng lại hạ tầng fake-drizzle chung của repo (không tự chế lại).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createFakeDb, drizzleStub, makeTable, type FakeDb, type QueryCall } from "../../../../../lib/test-support/fake-drizzle.ts";

const routeSource = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
const jsSource = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

const schemaStub = {
  dailyApplications: makeTable("daily_applications"),
  documentHistory: makeTable("document_history"),
  mergeJobRecords: makeTable("merge_job_records"),
  mergeJobs: makeTable("merge_jobs"),
};

type CallWorkerMock = (...args: unknown[]) => Promise<{
  ok: boolean;
  status: number;
  stage?: string;
  data: { error?: string; processed?: number };
  diagnostics?: unknown;
}>;

function makeContext(opts: {
  db: FakeDb;
  callWorkerImpl: CallWorkerMock;
  pollRespond?: (call: QueryCall) => unknown;
}) {
  const setTimeoutCalls: number[] = [];
  const moduleObj = { exports: {} as Record<string, unknown> };
  const context = vm.createContext({
    module: moduleObj,
    exports: moduleObj.exports,
    require: (id: string) => {
      switch (id) {
        case "next/server":
          return {
            NextResponse: {
              json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body }),
            },
          };
        case "drizzle-orm":
          return drizzleStub;
        case "@/db":
          return { db: opts.db };
        case "@/db/schema":
          return schemaStub;
        case "@/lib/auth":
          return {
            requirePermission: async () => ({ ok: true, session: { username: "admin-test" } }),
          };
        case "@/lib/verification/helpers":
          return {
            isVerificationEnabled: () => true,
            callWorker: opts.callWorkerImpl,
          };
        case "@/lib/document-merge/async-job":
          return {
            createAsyncMergeJob: async () => ({ jobId: "job-1", total: 1, status: "QUEUED" }),
          };
        case "@/lib/document-merge/template-versions":
          return {
            findHtmlPublishableTemplateId: async () => "tpl-1",
          };
        default:
          throw new Error(`Unexpected require("${id}") trong test — route.ts không nên phụ thuộc module này.`);
      }
    },
    process,
    Request,
    console,
    Date,
    Math,
    JSON,
    // Poll loop dùng setTimeout(2000) thật — fake nó chạy ngay (setImmediate) để
    // test không thật sự ngủ 2s/lần; KHÔNG đổi logic sản phẩm, chỉ tăng tốc test.
    setTimeout: (fn: () => void, ms: number) => {
      setTimeoutCalls.push(ms);
      return setImmediate(fn);
    },
  });
  vm.runInContext(jsSource, context);
  return { POST: (moduleObj.exports as { POST: (req: Request) => Promise<{ status: number; body: Record<string, unknown> }> }).POST, setTimeoutCalls };
}

function seedDb(pollRespond?: (call: QueryCall) => unknown): FakeDb {
  return createFakeDb({
    respond: (call) => {
      if (call.root === "insert" && call.table === "daily_applications") {
        return [{ id: "app-1" }];
      }
      if (call.root === "update" && call.table === "daily_applications") {
        return { rowCount: 1 };
      }
      if (pollRespond) {
        const custom = pollRespond(call);
        if (custom !== undefined) return custom;
      }
      return undefined;
    },
  });
}

test("run-test: workerTrigger 401 -> dừng NGAY, KHÔNG polling merge_jobs, trả pass=false với stage/status thật", async () => {
  const db = seedDb();
  const { POST, setTimeoutCalls } = makeContext({
    db,
    callWorkerImpl: async () => ({
      ok: false,
      status: 401,
      stage: "WORKER_AUTH",
      data: { error: "unauthorized" },
      diagnostics: { workerHost: "worker.example", workerSecretConfigured: false },
    }),
  });

  const res = await POST(new Request("https://app.example/api/document-merge/verification/run-test", {
    method: "POST",
    body: JSON.stringify({ records: 1 }),
  }));

  assert.equal(res.body.pass, false);
  assert.match(String(res.body.error), /stage=WORKER_AUTH/);
  assert.match(String(res.body.error), /HTTP 401/);

  const stages = res.body.stages as Record<string, { pass: boolean; skipped?: boolean; status?: number; stage?: string }>;
  assert.equal(stages.workerTrigger.pass, false);
  assert.equal(stages.workerTrigger.status, 401);
  assert.equal(stages.workerTrigger.stage, "WORKER_AUTH");
  assert.equal(stages.poll.skipped, true);
  assert.equal((stages.items as { skipped?: boolean }).skipped, true);

  // Bằng chứng KHÔNG polling: không có setTimeout(2000) nào được gọi, và
  // không có select nào nhắm vào merge_jobs (chỉ poll loop mới select bảng này).
  assert.equal(setTimeoutCalls.length, 0, "không được gọi setTimeout của poll loop khi trigger đã thất bại");
  const pollQueries = db.calls.filter((c) => c.root === "select" && c.table === "merge_jobs");
  assert.equal(pollQueries.length, 0, "không được query merge_jobs khi trigger đã thất bại (đó là việc của poll loop)");
});

test("run-test: workerTrigger 403 cũng dừng ngay (không chỉ riêng 401)", async () => {
  const db = seedDb();
  const { POST, setTimeoutCalls } = makeContext({
    db,
    callWorkerImpl: async () => ({
      ok: false,
      status: 403,
      stage: "CLOUD_RUN_IAM",
      data: { error: "Forbidden" },
    }),
  });

  const res = await POST(new Request("https://app.example/api/document-merge/verification/run-test", {
    method: "POST",
    body: JSON.stringify({ records: 1 }),
  }));

  assert.equal(res.body.pass, false);
  assert.equal(setTimeoutCalls.length, 0);
});

test("run-test: workerTrigger thành công -> polling merge_jobs vẫn chạy bình thường (không đổi đường thành công)", async () => {
  const db = seedDb((call) => {
    if (call.root === "select" && call.table === "merge_jobs") {
      return [{ id: "job-1", status: "COMPLETED", progressPercent: 100, outputPdfUrl: "https://x/pdf", outputZipUrl: "https://x/zip", batchExpiresAt: null }];
    }
    if (call.root === "select" && call.table === "merge_job_records") {
      return [{ id: "r1", status: "COMPLETED", attemptCount: 1, sha256: "abc", storageKey: "k", documentHistoryId: "h1", startedAt: new Date(0), completedAt: new Date(1000) }];
    }
    if (call.root === "select" && call.table === "document_history") {
      return [{ sha256: "abc", storageFileId: "f1", templateVersion: 1, retentionUntil: new Date(Date.now() + 3 * 365 * 86400 * 1000), generatedAt: new Date(), archiveStatus: "ONLINE", storageProvider: "google_drive", fileSize: 100, createdBy: "verification-admin-test" }];
    }
    return undefined;
  });
  const { POST, setTimeoutCalls } = makeContext({
    db,
    callWorkerImpl: async () => ({ ok: true, status: 200, data: { processed: 1 } }),
  });

  const res = await POST(new Request("https://app.example/api/document-merge/verification/run-test", {
    method: "POST",
    body: JSON.stringify({ records: 1 }),
  }));

  const stages = res.body.stages as Record<string, { pass: boolean; skipped?: boolean }>;
  assert.equal(stages.workerTrigger.pass, true);
  assert.equal(stages.poll.skipped, undefined, "đường thành công không có 'skipped' — polling thật đã chạy");
  assert.equal(setTimeoutCalls.length > 0, true, "polling loop phải thật sự chạy khi trigger thành công");
  const pollQueries = db.calls.filter((c) => c.root === "select" && c.table === "merge_jobs");
  assert.equal(pollQueries.length > 0, true);
  assert.equal(res.body.pass, true);
});
