/**
 * REGRESSION — POST /api/document-merge/merge/execute triggers the interactive
 * stale-merge recovery BEFORE creating a new job.
 *
 * The 28–29/08 incident left zombie GOOGLE_DOCS jobs (RUNNING + PENDING rows)
 * because the only recovery actor was the daily Vercel cron. The hotfix runs
 * the same liveness/CAS sweep on the merge WRITE path. These tests transpile
 * the REAL route and prove:
 *
 *   1. runPreMergeStaleRecovery() is invoked BEFORE the new merge_jobs row is
 *      inserted (so it can never touch the job being created);
 *   2. a throwing recovery sweep NEVER blocks a new merge;
 *   3. the one-record GOOGLE_DOCS lifecycle still works at the route level:
 *      items are leased PROCESSING when work starts and the job commits
 *      through the CAS helpers (PENDING → PROCESSING → COMPLETED).
 *
 * GET polling stays read-only — covered by job-route-read-only.test.ts.
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
import * as realQueueTypes from "../../../../../lib/document-merge/queue-types.ts";

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
  outputFolderId: null,
  documentKind: "DW_CU",
};

type RoutePostResult = { status: number; body: Record<string, unknown> };

function loadPost(opts: {
  events: string[];
  recoveryImpl: () => Promise<unknown>;
}): { POST: (r: Request) => Promise<RoutePostResult>; db: FakeDb; heartbeats: string[] } {
  const events = opts.events;
  const heartbeats: string[] = [];
  const db: FakeDb = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "merge_templates") return [ACTIVE_TEMPLATE];
      if (call.root === "select" && call.table === "daily_applications") {
        return [{ application: { id: "app-1" }, deptName: null }];
      }
      if (call.root === "select" && call.table === "merge_template_fields") {
        return [{ templateId: "tpl-1", sourceField: "ho_ten", isOrphaned: false }];
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

  const queue = {
    touchSyncMerge: async () => {
      heartbeats.push("touchSyncMerge");
      return true;
    },
    syncMergeOwnsJob: async () => true,
    casSyncJobCompleted: async () => true,
    casSyncItemsCompleted: async () => 1,
    casSyncJobFailed: async () => true,
    casSyncItemsFailed: async () => 1,
  };

  const fakeDocs = {
    getDocumentContent: async () => "MẪU <<Ho_ten>> <<Ngay_sinh>>",
    createDocument: async () => "doc-out-1",
    updateDocumentContent: async () => undefined,
    trashFile: async () => undefined,
  };

  const stubs: Record<string, unknown> = {
    "next/server": {
      NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body }) },
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
    "@/lib/document-merge/google-docs-service": {
      createGoogleDocsService: () => fakeDocs,
    },
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
    "@/lib/document-merge/batch-pdf": {
      mergePdfBuffers: async () => new Uint8Array([1]),
    },
    "@/lib/document-merge/google-drive-pdf": {
      exportGoogleDocAsPdf: async () => new Uint8Array([1]),
      uploadPdfToDrive: async () => ({ id: "pdf-1", webViewLink: "https://drive/pdf-1", webContentLink: "https://drive/pdf-1" }),
    },
    "@/lib/document-merge/template-routing": {
      documentKindLabel: (k: string) => String(k),
      googleDocEditUrl: (id: string) => `https://docs.google.com/document/d/${id}/edit`,
      googleDocPdfUrl: (id: string) => `https://docs.google.com/document/d/${id}/export?format=pdf`,
      selectTemplateForApplicant: () => ({ template: ACTIVE_TEMPLATE, kind: "DW_CU" }),
    },
    "@/lib/document-merge/merge-timing": {
      MergeStageTimer: class {
        measure(_stage: string, fn: () => Promise<unknown>) {
          return fn();
        }
        set() {}
        log() {}
        summary() {
          return {};
        }
      },
    },
    "@/lib/document-merge/queue-types": realQueueTypes,
    "@/lib/document-merge/queue": queue,
    "@/lib/document-merge/pre-merge-recovery": {
      runPreMergeStaleRecovery: async () => {
        events.push("pre-merge-recovery");
        return opts.recoveryImpl();
      },
    },
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
  return { POST, db, heartbeats };
}

function mergeRequest(): Request {
  return new Request("https://app.example/api/document-merge/merge/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      templateId: "tpl-1",
      autoRoute: false,
      batchPrint: false,
      dispatchToApplicant: false,
      records: { entityType: "daily_applications", recordIds: ["app-1"] },
    }),
  });
}

test("HOTFIX — pre-merge stale recovery runs BEFORE the new merge_jobs row is inserted", async () => {
  const events: string[] = [];
  const { POST } = loadPost({ events, recoveryImpl: async () => ({ syncFailed: 1, recoveredJobIds: ["zombie-1"] }) });

  const res = await POST(mergeRequest());
  assert.equal(res.status, 200, "merge still succeeds after recovering a zombie");
  assert.equal(res.body.success, true);

  const recoveryIdx = events.indexOf("pre-merge-recovery");
  const insertIdx = events.indexOf("insert-merge-jobs");
  assert.ok(recoveryIdx >= 0, "recovery must be triggered on the merge write path");
  assert.ok(insertIdx >= 0, "job creation must happen");
  assert.ok(
    recoveryIdx < insertIdx,
    `recovery (idx ${recoveryIdx}) must run BEFORE job insert (idx ${insertIdx}) — the sweep must never be able to touch the job being created`,
  );
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
  assert.equal(res.status, 200, "recovery failure must not fail the merge request");
  assert.equal(res.body.success, true);
});

test("LIFECYCLE — one-record GOOGLE_DOCS merge transitions items PENDING → leased PROCESSING → CAS COMPLETED at the route level", async () => {
  const events: string[] = [];
  const { POST, db } = loadPost({ events, recoveryImpl: async () => ({ syncFailed: 0 }) });

  const res = await POST(mergeRequest());
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.status, "COMPLETED");

  // Items are born PENDING (insert values include status "PENDING").
  const recordInsert = db.writesTo("merge_job_records").find((c) => c.root === "insert");
  assert.ok(recordInsert, "job records must be inserted");
  const insertValues = recordInsert.ops.find((o) => o.fn === "values")?.args[0] as Array<{ status: string }>;
  assert.ok(Array.isArray(insertValues) && insertValues.length === 1);
  assert.equal(insertValues[0].status, "PENDING", "records start PENDING");

  // Real QUEUED → PROCESSING transition with a 60s lease when work starts.
  const leaseUpdate = db
    .writesTo("merge_job_records")
    .find((c) => c.root === "update" && c.ops.some((o) => o.fn === "set"));
  assert.ok(leaseUpdate, "records must be leased into PROCESSING before work begins");
  const leaseSet = leaseUpdate.ops.find((o) => o.fn === "set")?.args[0] as {
    status?: string;
    startedAt?: Date;
    leasedUntil?: Date;
  };
  assert.equal(leaseSet.status, "PROCESSING", "records are PROCESSING while the sync request works");
  assert.ok(leaseSet.leasedUntil instanceof Date, "a lease must be established");
  assert.equal(leaseSet.leasedUntil.getTime() - leaseSet.startedAt!.getTime(), 60_000, "60s lease");

  // The terminal commit is exclusively via the CAS helper (no direct terminal
  // write from the route), preserving FAILED/CANCELLED protections.
  const directTerminal = db.writesTo("merge_jobs").some(
    (c) =>
      c.root === "update" &&
      c.ops.some((o) => o.fn === "set" && (o.args[0] as { status?: string }).status === "COMPLETED"),
  );
  assert.equal(directTerminal, false, "route must not write a terminal job status directly (CAS-only)");
});

test("LIFECYCLE — liveness heartbeats fire around every external stage of the sync request", async () => {
  const events: string[] = [];
  const { POST, heartbeats } = loadPost({ events, recoveryImpl: async () => ({ syncFailed: 0 }) });
  const res = await POST(mergeRequest());
  assert.equal(res.status, 200);

  // heartbeat("start" | "template_read" | "candidate_1" | "doc_create" | "commit")
  // — the liveness lease that keeps the stale watchdog from touching a live job.
  assert.ok(heartbeats.length >= 5, `expected a liveness touch around every stage, got ${heartbeats.length}`);
});
