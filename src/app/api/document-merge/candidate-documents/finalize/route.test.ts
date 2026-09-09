/**
 * POST /api/document-merge/candidate-documents/finalize — regression tests
 * for the GOOGLE_DOCS worker fallback fix (2026-09,
 * "BATCH_PDF_GOOGLE_AUTH_FAILED: Token has been expired or revoked").
 *
 * ROOT CAUSE (confirmed via a read-only production diagnostic against real
 * candidate_documents/merge_job_records rows — scripts/diagnose-econf-google-
 * auth.mjs): this route runs on Vercel, a runtime SEPARATE from the Cloud
 * Run worker. It made two Google calls directly, in-process, each with its
 * OWN independent token-exchange implementation reading process.env of
 * WHATEVER runtime is currently executing:
 *   - exportGoogleDocAsPdf() (google-drive-pdf.ts) — export a Google Doc as
 *     PDF bytes.
 *   - storage.put() (storage/google-drive.ts, via getStorageProvider()) —
 *     upload those bytes to Drive.
 * Vercel's own copy of GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN was confirmed
 * stale ("Token has been expired or revoked"), while the SAME job's own
 * GOOGLE_DOCS item creation succeeds inside the worker (merge_job_records
 * status COMPLETED, storageKey present) — proving the worker's copy of the
 * SAME credential is healthy.
 *
 * FIX: buildDeps() tries the local credential first (unchanged behavior for
 * a Vercel deployment that DOES have a working local credential); only on a
 * confirmed local-auth failure does it fall back to the Cloud Run worker's
 * already-authorized /export-doc-pdf and /drive-upload-pdf endpoints via
 * callWorker() — the SAME fallback channel already used by the Scan route's
 * identical fix (see templates/[id]/scan/route.ts and
 * scan-route-google-auth-fallback.test.ts, which this test file mirrors).
 *
 * Same pattern as that test file (repo has no jsdom): transpile the REAL
 * route.ts source, run it in a vm sandbox with a fake require() for every
 * external import; drizzle uses the repo's shared fake-drizzle. The REAL
 * finalizeToReady() (candidate-consent/finalize.ts, already covered by its
 * own finalize.test.ts) is loaded for real and injected into the sandbox,
 * so this test exercises the actual decision logic end-to-end, not a stub.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createFakeDb, drizzleStub, makeTable, argOf, eqValue, type FakeDb } from "../../../../../lib/test-support/fake-drizzle.ts";
import { finalizeToReady } from "../../../../../lib/candidate-consent/finalize.ts";

const ROUTE_PATH = "src/app/api/document-merge/candidate-documents/finalize/route.ts";
const routeSource = readFileSync(new URL(`../../../../../../${ROUTE_PATH}`, import.meta.url), "utf8");
const jsSource = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

const schemaStub = {
  candidateDocuments: makeTable("candidate_documents"),
  mergeJobRecords: makeTable("merge_job_records"),
  mergeTemplates: makeTable("merge_templates"),
};

const GENERATING_DOC = {
  id: "cdoc-1",
  mergeJobRecordId: "rec-1",
  applicationId: "app-1",
  status: "GENERATING",
};

const COMPLETED_RECORD = {
  id: "rec-1",
  status: "COMPLETED",
  errorMessage: null,
  storageKey: "google-doc-id-abc123",
  pdfUrl: "https://docs.google.com/document/d/google-doc-id-abc123/edit",
  sha256: null,
  fileSize: null,
  filename: "cdoc-1.pdf",
  templateId: "tpl-1",
};

type AuthMode = "local-ok" | "local-auth-failed" | "local-other-error";

type Options = {
  exportAuthMode?: AuthMode;
  uploadAuthMode?: AuthMode;
  workerExportResult?: { ok: boolean; status: number; data: Record<string, unknown> };
  workerUploadResult?: { ok: boolean; status: number; data: Record<string, unknown> };
  /** PHASE 5 (batch isolation): override the GENERATING docs and their linked records for a multi-candidate scenario. */
  docs?: (typeof GENERATING_DOC)[];
  records?: Record<string, unknown>[];
};

type Context = {
  POST: (req: Request) => Promise<{ status: number; body: Record<string, unknown> }>;
  db: FakeDb;
  localExportCalls: string[];
  localUploadCalls: { key: string; bytes: number }[];
  workerCalls: { path: string; body: unknown }[];
  updates: Record<string, unknown>[];
};

function makeContext(opts: Options = {}): Context {
  const updates: Record<string, unknown>[] = [];
  const docs = opts.docs ?? [GENERATING_DOC];
  const records = opts.records ?? [COMPLETED_RECORD];
  const db = createFakeDb({
    respond: (call) => {
      if (call.root === "select" && call.table === "candidate_documents") return docs;
      if (call.root === "select" && call.table === "merge_job_records") return records;
      if (call.root === "select" && call.table === "merge_templates") return [{ id: "tpl-1", currentPublishedVersion: 20 }];
      if (call.root === "update" && call.table === "candidate_documents") {
        updates.push({ id: eqValue(call, "candidate_documents.id"), ...(argOf(call, "set") as Record<string, unknown>) });
        return [];
      }
      return [];
    },
  });

  const localExportCalls: string[] = [];
  const localUploadCalls: { key: string; bytes: number }[] = [];
  const workerCalls: Context["workerCalls"] = [];
  const exportAuthMode = opts.exportAuthMode ?? "local-ok";
  const uploadAuthMode = opts.uploadAuthMode ?? "local-ok";

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
          return { db };
        case "@/db/schema":
          return schemaStub;
        case "@/lib/auth":
          return {
            requirePermission: async () => ({
              ok: true as const,
              session: { id: "admin-1", username: "admin", fullName: "Admin", role: "ADMIN", deptId: null },
            }),
            writeAudit: async () => {},
          };
        case "@/lib/document-merge/google-drive-pdf":
          return {
            exportGoogleDocAsPdf: async (docId: string) => {
              localExportCalls.push(docId);
              if (exportAuthMode === "local-ok") return new TextEncoder().encode("fake-pdf-bytes");
              if (exportAuthMode === "local-other-error") {
                throw new Error("BATCH_PDF_EXPORT_404: not found");
              }
              // local-auth-failed — the exact failure mode confirmed in production.
              throw new Error("BATCH_PDF_GOOGLE_AUTH_FAILED: Token has been expired or revoked.");
            },
          };
        case "@/lib/storage":
          return {
            getStorageProvider: () => ({
              put: async (key: string, bytes: Buffer) => {
                localUploadCalls.push({ key, bytes: bytes.byteLength });
                if (uploadAuthMode === "local-ok") return { key, size: bytes.byteLength };
                if (uploadAuthMode === "local-other-error") {
                  throw new Error("GOOGLE_DRIVE_UPLOAD_403: forbidden");
                }
                throw new Error("GOOGLE_DRIVE_AUTH_FAILED: Token has been expired or revoked.");
              },
            }),
          };
        case "@/lib/candidate-consent/finalize":
          return { finalizeToReady };
        case "@/lib/verification/helpers":
          return {
            callWorker: async (path: string, body: unknown) => {
              workerCalls.push({ path, body });
              if (path === "/export-doc-pdf") {
                return opts.workerExportResult ?? { ok: false, status: 503, data: { error: "worker not configured in this test" } };
              }
              return opts.workerUploadResult ?? { ok: false, status: 503, data: { error: "worker not configured in this test" } };
            },
          };
        default:
          throw new Error(`Unexpected require("${id}") — route không được phụ thuộc module này.`);
      }
    },
    process,
    Request,
    console,
    Date,
    JSON,
    Buffer,
    Math,
    Uint8Array,
    TextEncoder,
    // Injected explicitly so `err instanceof Error` inside the vm-executed
    // route code recognizes Errors thrown by host-realm require() stubs
    // (and by the REAL, host-loaded finalizeToReady) — without this, the
    // vm's OWN separate Error identity makes every cross-realm instanceof
    // check false, silently discarding the real error message.
    Error,
    TypeError,
  });
  vm.runInContext(jsSource, context);
  return {
    POST: (moduleObj.exports as { POST: Context["POST"] }).POST,
    db,
    localExportCalls,
    localUploadCalls,
    workerCalls,
    updates,
  };
}

function requestFor(body: Record<string, unknown> = {}): Request {
  return new Request("http://localhost/api/document-merge/candidate-documents/finalize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("local Google credentials healthy → export + upload happen locally, worker is never called, document reaches READY", async () => {
  const ctx = makeContext();
  const res = await ctx.POST(requestFor());

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(ctx.localExportCalls.length, 1);
  assert.equal(ctx.localUploadCalls.length, 1);
  assert.equal(ctx.workerCalls.length, 0, "must not call the worker when Vercel already has working Google credentials");
  assert.equal(ctx.updates.length, 1);
  assert.equal(ctx.updates[0].status, "READY");
});

test("local export auth failed (the confirmed production symptom) → falls back to worker's /export-doc-pdf, document reaches READY", async () => {
  const ctx = makeContext({
    exportAuthMode: "local-auth-failed",
    workerExportResult: {
      ok: true,
      status: 200,
      data: { pdfBase64: Buffer.from("fake-pdf-from-worker").toString("base64"), byteLength: 21 },
    },
  });
  const res = await ctx.POST(requestFor());

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(ctx.localExportCalls.length, 1, "must still try the local credential first");
  assert.equal(ctx.workerCalls.length, 1, "must fall back to the worker exactly once for export");
  assert.equal(ctx.workerCalls[0].path, "/export-doc-pdf");
  assert.equal(JSON.stringify(ctx.workerCalls[0].body), JSON.stringify({ docId: "google-doc-id-abc123" }));
  // Upload proceeds locally with the bytes the worker returned — local upload credential is fine in this scenario.
  assert.equal(ctx.localUploadCalls.length, 1);
  assert.equal(ctx.updates[0].status, "READY");
});

test("local upload auth failed → falls back to worker's /drive-upload-pdf with base64 PDF bytes, document reaches READY", async () => {
  const ctx = makeContext({
    uploadAuthMode: "local-auth-failed",
    workerUploadResult: { ok: true, status: 200, data: { key: "candidate-documents/cdoc-1.pdf", size: 14 } },
  });
  const res = await ctx.POST(requestFor());

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(ctx.localExportCalls.length, 1);
  assert.equal(ctx.localUploadCalls.length, 1, "must still try the local credential first");
  assert.equal(ctx.workerCalls.length, 1, "must fall back to the worker exactly once for upload");
  assert.equal(ctx.workerCalls[0].path, "/drive-upload-pdf");
  const uploadBody = ctx.workerCalls[0].body as { key: string; pdfBase64: string; contentType: string };
  assert.equal(uploadBody.key, "candidate-documents/cdoc-1.pdf");
  assert.equal(uploadBody.contentType, "application/pdf");
  assert.equal(ctx.updates[0].status, "READY");
  assert.equal(ctx.updates[0].storageKey, "candidate-documents/cdoc-1.pdf");
});

test("both local export AND local upload auth fail → both fall back to the worker, document still reaches READY", async () => {
  const ctx = makeContext({
    exportAuthMode: "local-auth-failed",
    uploadAuthMode: "local-auth-failed",
    workerExportResult: {
      ok: true,
      status: 200,
      data: { pdfBase64: Buffer.from("fake-pdf-from-worker").toString("base64"), byteLength: 21 },
    },
    workerUploadResult: { ok: true, status: 200, data: { key: "candidate-documents/cdoc-1.pdf", size: 21 } },
  });
  const res = await ctx.POST(requestFor());

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(ctx.workerCalls.length, 2);
  assert.equal(ctx.workerCalls[0].path, "/export-doc-pdf");
  assert.equal(ctx.workerCalls[1].path, "/drive-upload-pdf");
  assert.equal(ctx.updates[0].status, "READY");
});

test("a non-auth Google error (404 not found) never falls back to the worker — surfaces as FAILED, isolated to this document", async () => {
  const ctx = makeContext({ exportAuthMode: "local-other-error" });
  const res = await ctx.POST(requestFor());

  assert.equal(res.status, 200);
  assert.equal(ctx.workerCalls.length, 0, "a permission/not-found error is not a missing-credential error — must not retry via worker");
  assert.equal(ctx.updates[0].status, "FAILED");
  assert.match(String(ctx.updates[0].errorMessage), /BATCH_PDF_EXPORT_404/);
});

test("local auth failed AND worker fallback also fails → surfaces as FAILED with the worker's own error, never crashes the batch", async () => {
  const ctx = makeContext({
    exportAuthMode: "local-auth-failed",
    workerExportResult: { ok: false, status: 502, data: { error: "GOOGLE_DRIVE_AUTH_FAILED: worker credential also invalid" } },
  });
  const res = await ctx.POST(requestFor());

  assert.equal(res.status, 200);
  assert.equal(ctx.workerCalls.length, 1);
  assert.equal(ctx.updates[0].status, "FAILED");
  assert.match(String(ctx.updates[0].errorMessage), /worker credential also invalid/);
});

test("worker fallback bodies never carry a Google credential/token value — only docId or key+pdfBase64+contentType", async () => {
  const ctx = makeContext({
    exportAuthMode: "local-auth-failed",
    uploadAuthMode: "local-auth-failed",
    workerExportResult: {
      ok: true,
      status: 200,
      data: { pdfBase64: Buffer.from("fake-pdf-from-worker").toString("base64"), byteLength: 21 },
    },
    workerUploadResult: { ok: true, status: 200, data: { key: "candidate-documents/cdoc-1.pdf", size: 21 } },
  });
  await ctx.POST(requestFor());

  const exportKeys = Object.keys(ctx.workerCalls[0].body as object).sort();
  assert.deepEqual(exportKeys, ["docId"]);
  const uploadKeys = Object.keys(ctx.workerCalls[1].body as object).sort();
  assert.deepEqual(uploadKeys, ["contentType", "key", "pdfBase64"]);
});

// ---------------------------------------------------------------------------
// PHASE 5 — batch behavior: N candidates = N independent candidate_documents/
// PDFs (never a combined PDF for this candidate-facing route — batchPrint is
// hardcoded false for GOOGLE_DOCS in candidate-merge-job.ts), and one
// candidate's failure must never lose another's already-successful document
// in the SAME finalize batch.
// ---------------------------------------------------------------------------

test("PHASE 5: 3 candidates in one finalize batch → 3 independent candidate_documents rows, never a combined PDF", async () => {
  const docs = [
    { id: "cdoc-1", mergeJobRecordId: "rec-1", applicationId: "app-1", status: "GENERATING" },
    { id: "cdoc-2", mergeJobRecordId: "rec-2", applicationId: "app-2", status: "GENERATING" },
    { id: "cdoc-3", mergeJobRecordId: "rec-3", applicationId: "app-3", status: "GENERATING" },
  ];
  const records = [
    { ...COMPLETED_RECORD, id: "rec-1", storageKey: "google-doc-id-1" },
    { ...COMPLETED_RECORD, id: "rec-2", storageKey: "google-doc-id-2" },
    { ...COMPLETED_RECORD, id: "rec-3", storageKey: "google-doc-id-3" },
  ];
  const ctx = makeContext({ docs, records });
  const res = await ctx.POST(requestFor());

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(ctx.updates.length, 3, "each candidate must get its own independent status write");
  assert.deepEqual(
    ctx.updates.map((u) => u.status),
    ["READY", "READY", "READY"],
  );
  // Each export call targets its OWN doc id — never a shared/merged PDF.
  assert.deepEqual(ctx.localExportCalls.sort(), ["google-doc-id-1", "google-doc-id-2", "google-doc-id-3"]);
  // Each upload targets its OWN storage key, derived from ITS candidate_document id.
  const uploadKeys = ctx.localUploadCalls.map((c) => c.key).sort();
  assert.deepEqual(uploadKeys, ["candidate-documents/cdoc-1.pdf", "candidate-documents/cdoc-2.pdf", "candidate-documents/cdoc-3.pdf"]);
});

test("PHASE 5: partial failure isolation — candidate #2's merge_job_record already FAILED at the worker item level must not affect #1/#3's successful documents", async () => {
  const docs = [
    { id: "cdoc-1", mergeJobRecordId: "rec-1", applicationId: "app-1", status: "GENERATING" },
    { id: "cdoc-2", mergeJobRecordId: "rec-2", applicationId: "app-2", status: "GENERATING" },
    { id: "cdoc-3", mergeJobRecordId: "rec-3", applicationId: "app-3", status: "GENERATING" },
  ];
  const records = [
    { ...COMPLETED_RECORD, id: "rec-1", storageKey: "google-doc-id-1" },
    { ...COMPLETED_RECORD, id: "rec-2", status: "FAILED", storageKey: null, errorMessage: "GOOGLE_DOCS_CREATE_FAILED: quota exceeded" },
    { ...COMPLETED_RECORD, id: "rec-3", storageKey: "google-doc-id-3" },
  ];
  const ctx = makeContext({ docs, records });
  const res = await ctx.POST(requestFor());

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(ctx.updates.length, 3);
  const byId = new Map(ctx.updates.map((u) => [u.id, u]));
  assert.equal(byId.get("cdoc-1")?.status, "READY", "candidate #1 must reach READY unaffected by #2's failure");
  assert.equal(byId.get("cdoc-2")?.status, "FAILED");
  assert.match(String(byId.get("cdoc-2")?.errorMessage), /quota exceeded/);
  assert.equal(byId.get("cdoc-3")?.status, "READY", "candidate #3 must reach READY unaffected by #2's failure");
  // #2 never made it to export/upload at all (no completed item to export).
  assert.deepEqual(ctx.localExportCalls.sort(), ["google-doc-id-1", "google-doc-id-3"]);
});
