/**
 * REGRESSION — POST /api/document-merge/merge/execute (GOOGLE_DOCS async).
 *
 * After the 28–29/08 incident the route no longer performs Google Docs/Drive
 * work inside the HTTP request. It must:
 *
 *   1. run the pre-merge stale-recovery sweep BEFORE inserting the new job
 *      (legacy zombie cleanup) and never let a recovery failure block a merge;
 *   2. create a durable QUEUED job + QUEUED items with a FROZEN googleDocs
 *      snapshot (template id / googleDocId / outputFolderId / field mapping)
 *      and trigger the Cloud Run worker (fire-and-forget);
 *   3. perform ZERO Google API work in-request (the test harness throws if
 *      the route requires the google-docs-service module);
 *   4. keep preflight read-only (no job insert, no worker trigger).
 *
 * GET polling stays read-only — covered by job-route-read-only.test.ts.
 * Worker-side GOOGLE_DOCS execution is covered by worker/src/index.test.ts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import {
  createFakeDb,
  drizzleStub,
  makeTable,
  type FakeDb,
  type QueryCall,
} from "../../../../../lib/test-support/fake-drizzle.ts";

const routeSource = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
const jsSource = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

const schemaStub = {
  dailyApplications: makeTable("daily_applications"),
  departments: makeTable("departments"),
  dwData: makeTable("dw_data"),
  mergeJobRecords: makeTable("merge_job_records"),
  mergeJobs: makeTable("merge_jobs"),
  mergeTemplateFields: makeTable("merge_template_fields"),
  mergeTemplates: makeTable("merge_templates"),
  workerProfiles: makeTable("worker_profiles"),
};

const ACTIVE_TEMPLATE = {
  id: "tpl-1",
  name: "Đăng ký tập nghề - Quy định tập nghề",
  isActive: true,
  googleDocId: "google-doc-16",
  outputFolderId: "folder-1",
  documentKind: "DW_CU",
};

const FIELD_ROW = {
  templateId: "tpl-1",
  id: "field-1",
  placeholder: "Ho_ten",
  sourceType: "FIELD",
  sourceEntity: "daily_applications",
  sourceField: "fullName",
  sourcePath: null,
  optionValue: null,
  formatType: null,
  fallbackValue: null,
  isRequired: false,
};

type RoutePostResult = { status: number; body: Record<string, unknown> };

function loadPost(opts: {
  events: string[];
  recoveryImpl: () => Promise<unknown>;
  workerTrigger?: (jobId: string) => void;
}): { POST: (r: Request) => Promise<RoutePostResult>; db: FakeDb } {
  const events = opts.events;
  const db: FakeDb = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "merge_templates") return [ACTIVE_TEMPLATE];
      if (call.root === "select" && call.table === "daily_applications") {
        return [{ application: { id: "app-1" }, deptName: null }];
      }
      if (call.root === "select" && call.table === "merge_template_fields") {
        return [FIELD_ROW];
      }
      if (call.root === "insert" && call.table === "merge_jobs") {
        events.push("insert-merge-jobs");
        return [{ id: "job-1" }];
      }
      if (call.root === "insert" && call.table === "merge_job_records") {
        events.push("insert-merge-job-records");
        return [];
      }
      return undefined;
    },
  });

  const stubs: Record<string, unknown> = {
    "next/server": {
      NextResponse: {
        json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body }),
      },
    },
    "drizzle-orm": drizzleStub,
    "@/lib/auth": {
      requirePermission: async () => ({
        ok: true,
        status: 200,
        session: { id: "user-1", username: "hr", fullName: "HR Staff", role: "HR_RECRUITER" },
      }),
      writeAudit: async () => undefined,
    },
    "@/db": { db },
    "@/db/schema": schemaStub,
    "@/lib/document-merge/data-resolver": {
      resolveAllFields: () => ({}),
      validateRequiredFields: () => ({ missingFields: [] }),
    },
    "@/lib/document-merge/preview-merge": {
      applyFallbackPlaceholders: (_data: unknown, mapped: Record<string, string>) => ({ ...mapped }),
      buildPreviewContent: (content: string) => ({ content }),
    },
    "@/lib/document-merge/applicant-record": {
      buildApplicantMergeRecord: ({ application }: { application: { id: string } }) => ({
        id: application.id,
        fullName: "Ung Vien",
        declaredType: "DW_CU",
        dwMatch: "MATCHED",
      }),
    },
    "@/lib/document-merge/template-routing": {
      documentKindLabel: (k: string) => String(k),
      selectTemplateForApplicant: () => ({ template: ACTIVE_TEMPLATE, kind: "DW_CU" }),
    },
    "@/lib/document-merge/queue-types": {
      ITEM_STATUS: { QUEUED: "QUEUED", PROCESSING: "PROCESSING" },
    },
    "@/lib/document-merge/pre-merge-recovery": {
      runPreMergeStaleRecovery: async () => {
        events.push("pre-merge-recovery");
        return opts.recoveryImpl();
      },
    },
    "@/lib/document-merge/worker-trigger": {
      triggerPdfWorker: (jobId: string) => {
        events.push(`worker-trigger:${jobId}`);
        opts.workerTrigger?.(jobId);
      },
    },
    // NOTE: NO google-docs-service / google-drive-pdf / batch-pdf stub — the
    // route must not import (or call) any Google module; the harness throws
    // "Unexpected require" if it does.
  };

  const moduleObj = { exports: {} as Record<string, unknown> };
  const context = vm.createContext({
    module: moduleObj,
    exports: moduleObj.exports,
    require: (specifier: string): unknown => {
      if (specifier in stubs) return stubs[specifier];
      throw new Error(`Unexpected require("${specifier}") in merge/execute route`);
    },
    console,
    process,
    Date,
    Promise,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Map,
    Set,
    Error,
    Uint8Array,
    Request,
    Headers,
    URL,
    TextEncoder,
    TextDecoder,
  });
  vm.runInContext(jsSource, context);

  const POST = (moduleObj.exports as { POST: (r: Request) => Promise<RoutePostResult> }).POST;
  return { POST, db };
}

function mergeRequest(overrides: Record<string, unknown> = {}): Request {
  return new Request("https://app.example/api/document-merge/merge/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      templateId: "tpl-1",
      autoRoute: false,
      batchPrint: true,
      dispatchToApplicant: false,
      records: { entityType: "daily_applications", recordIds: ["app-1"] },
      ...overrides,
    }),
  });
}

test("HOTFIX — pre-merge stale recovery runs BEFORE the new merge_jobs row is inserted", async () => {
  const events: string[] = [];
  const { POST } = loadPost({ events, recoveryImpl: async () => ({ syncFailed: 1, recoveredJobIds: ["zombie-1"] }) });

  const res = await POST(mergeRequest());
  assert.equal(res.status, 202);
  assert.equal(res.body.success, true);

  const recoveryIdx = events.indexOf("pre-merge-recovery");
  const insertIdx = events.indexOf("insert-merge-jobs");
  assert.ok(recoveryIdx >= 0, "recovery must be triggered on the merge write path");
  assert.ok(insertIdx >= 0, "job creation must happen");
  assert.ok(recoveryIdx < insertIdx, "recovery must run BEFORE job insert");
});

test("HOTFIX — a throwing recovery sweep never blocks a new merge", async () => {
  const events: string[] = [];
  const { POST } = loadPost({
    events,
    recoveryImpl: async () => {
      throw new Error("recovery db hiccup");
    },
  });

  const res = await POST(mergeRequest());
  assert.equal(res.status, 202);
  assert.equal(res.body.success, true);
});

test("ASYNC — POST creates a durable QUEUED job with a frozen googleDocs snapshot and returns 202 immediately", async () => {
  const events: string[] = [];
  const { POST, db } = loadPost({ events, recoveryImpl: async () => ({ syncFailed: 0 }) });

  const res = await POST(mergeRequest());
  assert.equal(res.status, 202, "job creation returns immediately");
  assert.equal(res.body.status, "QUEUED");
  assert.equal(res.body.engine, "GOOGLE_DOCS");
  assert.ok(typeof res.body.jobId === "string" && res.body.jobId.length > 0);
  assert.equal(res.body.outputUrl, undefined, "no synchronous output — the worker owns execution");

  const jobInsert = db.writesTo("merge_jobs").find((c) => c.root === "insert");
  assert.ok(jobInsert, "merge job inserted");
  const jobValues = jobInsert.ops.find((o) => o.fn === "values")?.args[0] as {
    status?: string;
    engine?: string;
    metadata?: { googleDocs?: Record<string, unknown> };
  };
  assert.equal(jobValues.status, "QUEUED", "job starts QUEUED (visible lifecycle)");
  assert.equal(jobValues.engine, "GOOGLE_DOCS");

  const googleDocs = jobValues.metadata?.googleDocs as
    | { batchPrint?: boolean; currentUserName?: string; templates?: Record<string, { googleDocId?: string; outputFolderId?: string | null; fields?: unknown[] }> }
    | undefined;
  assert.ok(googleDocs, "googleDocs snapshot frozen into metadata");
  assert.equal(googleDocs?.batchPrint, true);
  assert.equal(googleDocs?.currentUserName, "HR Staff");
  const tpl = googleDocs?.templates?.["tpl-1"];
  assert.ok(tpl, "template snapshot present");
  assert.equal(tpl?.googleDocId, "google-doc-16");
  assert.equal(tpl?.outputFolderId, "folder-1");
  assert.equal((tpl?.fields ?? []).length, 1, "field mapping snapshot frozen");

  // QUEUED items with templateId — the worker claims them via SKIP LOCKED.
  const recordInsert = db.writesTo("merge_job_records").find((c) => c.root === "insert");
  assert.ok(recordInsert, "job records inserted");
  const recordValues = recordInsert.ops.find((o) => o.fn === "values")?.args[0] as Array<{
    status?: string;
    templateId?: string;
  }>;
  assert.ok(Array.isArray(recordValues) && recordValues.length === 1);
  assert.equal(recordValues[0].status, "QUEUED", "items start QUEUED for the worker to claim");
  assert.equal(recordValues[0].templateId, "tpl-1");

  // Worker trigger fired exactly once with the new job id.
  assert.ok(events.includes("worker-trigger:job-1"), "worker trigger fired for the new job");
  assert.equal(events.filter((e) => e.startsWith("worker-trigger:")).length, 1);
});

test("ASYNC — NO Google module is imported or called in-request (zero Google work in the HTTP path)", async () => {
  const events: string[] = [];
  const { POST } = loadPost({ events, recoveryImpl: async () => ({ syncFailed: 0 }) });
  // The vm require-shim throws for any Google module; a passing POST proves
  // the route performs no Google work (the old synchronous route required
  // google-docs-service + google-drive-pdf + batch-pdf at module load).
  const res = await POST(mergeRequest());
  assert.equal(res.status, 202);
});

test("PREFLIGHT stays read-only: 200 valid, no job insert, no worker trigger", async () => {
  const events: string[] = [];
  const { POST, db } = loadPost({ events, recoveryImpl: async () => ({ syncFailed: 0 }) });

  const res = await POST(mergeRequest({ preflight: true }));
  assert.equal(res.status, 200);
  assert.equal(res.body.preflight, true);
  assert.equal(res.body.valid, true);

  assert.ok(!events.includes("insert-merge-jobs"), "preflight must not create a job");
  assert.ok(!events.includes("insert-merge-job-records"), "preflight must not create records");
  assert.equal(events.filter((e) => e.startsWith("worker-trigger:")).length, 0, "preflight must not trigger the worker");
  // Recovery still runs before preflight response (cheap, idempotent).
  assert.ok(events.includes("pre-merge-recovery"));
});
