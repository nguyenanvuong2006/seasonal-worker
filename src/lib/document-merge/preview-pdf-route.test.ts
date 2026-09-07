/**
 * "A4 PDF PREVIEW" ROUTE — regression tests.
 *
 * POST /api/document-merge/templates/[id]/versions/[versionId]/preview-pdf
 *
 * Same vm-sandbox pattern as draft-preview-route.test.ts. Proves:
 *   1. auth guard identical to the DOM preview route (ADMIN only);
 *   2. resolves the snapshot via the SAME resolveTemplateVersionPreview()
 *      the DOM preview route uses (see preview-render.test.ts for the deep
 *      behavioral proof — not duplicated here);
 *   3. calls the worker's /preview-pdf endpoint via the SAME callWorker()
 *      helper every other Vercel→worker call uses, passing exactly the
 *      resolved rendered.html and nothing else (no second render/HTML
 *      construction happens in this route);
 *   4. on success, streams the decoded PDF bytes back with
 *      Content-Type: application/pdf and Cache-Control: no-store — never
 *      JSON, never persisted;
 *   5. a worker failure is a controlled 502, not a 500 or a silently wrong
 *      response;
 *   6. PreviewResolutionError / CanonicalTemplateError are translated the
 *      same way as the DOM preview route.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const ROUTE_PATH = "src/app/api/document-merge/templates/[id]/versions/[versionId]/preview-pdf/route.ts";
const routeSource = readFileSync(new URL(`../../../${ROUTE_PATH}`, import.meta.url), "utf8");
const routeCode = routeSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const jsSource = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

const PREVIEW_RESOLUTION_ERROR = class extends Error {
  code: string;
  status: number;
  action?: string;
  templateId?: string | null;
  constructor(code: string, message: string, status: number, action?: string, templateId?: string | null) {
    super(message);
    this.name = "PreviewResolutionError";
    this.code = code;
    this.status = status;
    this.action = action;
    this.templateId = templateId;
  }
};

const CANONICAL_TEMPLATE_ERROR = class extends Error {
  code: string;
  operatorMessage: string;
  action: string;
  templateId: string | null;
  constructor(code: string, templateId: string | null = null) {
    super(code);
    this.name = "CanonicalTemplateError";
    this.code = code;
    this.operatorMessage = `Lỗi: ${code}`;
    this.action = "ACTION";
    this.templateId = templateId;
  }
};

const RESOLVED_RESULT = {
  template: { name: "Tpl", documentKind: "B", currentPublishedVersion: 7 },
  version: { id: "ver-8", version: 8, status: "DRAFT", mappingSnapshot: [] },
  rendered: {
    html: '<!DOCTYPE html><html><body><div class="paper"><p>x</p></div></body></html>',
    templateVersion: 8,
    printCss: ".paper{}",
    margins: { topMm: 10, bottomMm: 10, leftMm: 12, rightMm: 12 },
    unreplaced: [],
    missingFields: [],
    valid: true,
  },
  mappingSource: "CURRENT_MERGE_TEMPLATE_FIELDS",
  mappingSnapshotCount: 0,
  mappingSummary: { total: 1, mapped: 1, required: 1 },
  unpublished: true,
  fullName: "Trần Văn Dũng",
  cccd: "068098012345",
};

type Options = {
  role?: string;
  resolveError?: InstanceType<typeof PREVIEW_RESOLUTION_ERROR> | InstanceType<typeof CANONICAL_TEMPLATE_ERROR> | Error | null;
  workerResult?: { ok: boolean; status: number; data: unknown; stage?: string | null };
};

const PDF_BYTES = Buffer.from("%PDF-1.4 fake bytes for test", "utf8");

function makeContext(opts: Options = {}) {
  const role = opts.role ?? "ADMIN";
  const resolveCalls: Record<string, unknown>[] = [];
  const workerCalls: { path: string; body: unknown }[] = [];
  const workerResult = opts.workerResult ?? { ok: true, status: 200, data: { pdfBase64: PDF_BYTES.toString("base64"), byteLength: PDF_BYTES.byteLength } };

  const moduleObj = { exports: {} as Record<string, unknown> };
  const context = vm.createContext({
    module: moduleObj,
    exports: moduleObj.exports,
    require: (id: string) => {
      switch (id) {
        case "next/server":
          return {
            NextResponse: class {
              status: number;
              body: unknown;
              headers: Record<string, string>;
              constructor(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
                this.body = body;
                this.status = init?.status ?? 200;
                this.headers = init?.headers ?? {};
              }
              static json(body: unknown, init?: { status?: number }) {
                return { status: init?.status ?? 200, isJson: true, body };
              }
            },
          };
        case "@/lib/auth":
          return {
            requirePermission: async (roles: string[]) => {
              if (!roles.includes(role)) {
                return { ok: false as const, status: 403, error: "Từ chối truy cập! Quyền hạn không hợp lệ." };
              }
              return { ok: true as const, session: { id: "u-1", username: role, fullName: role, role, deptId: null } };
            },
            getUserScope: async () => null,
          };
        case "@/lib/document-merge/preview-render":
          return {
            PreviewResolutionError: PREVIEW_RESOLUTION_ERROR,
            isCanonicalTemplateError: (e: unknown) => e instanceof CANONICAL_TEMPLATE_ERROR,
            CANONICAL_ACTION_VI: "CANONICAL_ACTION",
            resolveTemplateVersionPreview: async (input: Record<string, unknown>) => {
              resolveCalls.push(input);
              if (opts.resolveError) throw opts.resolveError;
              return RESOLVED_RESULT;
            },
          };
        case "@/lib/document-merge/draft-preview":
          return {
            parseDraftPreviewRequest: (body: unknown) => {
              const data = (body ?? {}) as Record<string, unknown>;
              if (typeof data.applicationId !== "string" || !data.applicationId) {
                return { ok: false as const, error: { code: "APPLICATION_REQUIRED", error: "Cần applicationId." } };
              }
              return { ok: true as const, value: { applicationId: data.applicationId, signingContext: (data.signingContext as Record<string, unknown>) ?? {} } };
            },
          };
        case "@/lib/verification/helpers":
          return {
            callWorker: async (path: string, body: unknown) => {
              workerCalls.push({ path, body });
              return workerResult;
            },
          };
        default:
          throw new Error(`Unexpected require("${id}") — route must not depend on this module.`);
      }
    },
    process,
    Request,
    Buffer,
    console,
    Date,
    JSON,
    Array,
    Object,
    Number,
    Boolean,
    String,
    Set,
    Math,
  });
  vm.runInContext(jsSource, context);
  return {
    POST: (moduleObj.exports as { POST: (req: Request, ctx: { params: Promise<{ id: string; versionId: string }> }) => Promise<{ status: number; body?: unknown; headers?: Record<string, string>; isJson?: boolean }> }).POST,
    resolveCalls,
    workerCalls,
  };
}

function requestFor(payload: Record<string, unknown>): Request {
  return new Request("http://localhost/api/document-merge/templates/tpl-1/versions/ver-8/preview-pdf", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

const params = (id = "tpl-1", versionId = "ver-8") => ({ params: Promise.resolve({ id, versionId }) });

test("non-admin roles are rejected with 403 before any resolution/worker call", async () => {
  for (const role of ["HR_RECRUITER", "HR_SUPPORT", "GUEST"]) {
    const ctx = makeContext({ role });
    const res = await ctx.POST(requestFor({ applicationId: "app-1" }), params());
    assert.equal(res.status, 403, `${role} must be rejected`);
    assert.equal(ctx.resolveCalls.length, 0);
    assert.equal(ctx.workerCalls.length, 0);
  }
  assert.match(routeCode, /requirePermission\(\["ADMIN"\],\s*"document_merge\.templates\.manage"\)/);
});

test("calls the worker's /preview-pdf with EXACTLY the resolved rendered.html — no second render", async () => {
  const ctx = makeContext();
  await ctx.POST(requestFor({ applicationId: "app-1" }), params());
  assert.equal(ctx.workerCalls.length, 1);
  assert.equal(ctx.workerCalls[0].path, "/preview-pdf");
  // JSON-compare, not deepEqual: object literals built inside the vm sandbox
  // have a different Object prototype identity than this file's Object.
  assert.equal(JSON.stringify(ctx.workerCalls[0].body), JSON.stringify({ html: RESOLVED_RESULT.rendered.html }));
});

test("on success, returns raw PDF bytes with application/pdf content-type and no-store cache-control — not JSON", async () => {
  const ctx = makeContext();
  const res = await ctx.POST(requestFor({ applicationId: "app-1" }), params());
  assert.equal(res.status, 200);
  assert.equal(res.isJson, undefined, "must not be a NextResponse.json() call");
  assert.equal(res.headers?.["Content-Type"], "application/pdf");
  assert.equal(res.headers?.["Cache-Control"], "no-store");
  assert.equal(Buffer.from(res.body as Buffer).toString("utf8"), PDF_BYTES.toString("utf8"));
});

test("a worker failure is a controlled 502, not a 500 or a fabricated success", async () => {
  const ctx = makeContext({ workerResult: { ok: false, status: 502, data: { error: "worker down" }, stage: "CONFIG" } });
  const res = await ctx.POST(requestFor({ applicationId: "app-1" }), params());
  assert.equal(res.status, 502);
  assert.equal(res.isJson, true);
  assert.equal((res.body as Record<string, unknown>).code, "PDF_PREVIEW_RENDER_FAILED");
});

test("PreviewResolutionError from resolveTemplateVersionPreview is translated the same way as the DOM preview route", async () => {
  const ctx = makeContext({ resolveError: new PREVIEW_RESOLUTION_ERROR("APPLICATION_NOT_FOUND", "Không tìm thấy ứng viên.", 404, "Tìm lại.") });
  const res = await ctx.POST(requestFor({ applicationId: "app-1" }), params());
  assert.equal(res.status, 404);
  assert.equal((res.body as Record<string, unknown>).code, "APPLICATION_NOT_FOUND");
  assert.equal(ctx.workerCalls.length, 0, "must not call the worker when resolution already failed");
});

test("CanonicalTemplateError is translated to 422, never reaches the worker", async () => {
  const ctx = makeContext({ resolveError: new CANONICAL_TEMPLATE_ERROR("CANONICAL_SNAPSHOT_EMPTY", "tpl-1") });
  const res = await ctx.POST(requestFor({ applicationId: "app-1" }), params());
  assert.equal(res.status, 422);
  assert.equal(ctx.workerCalls.length, 0);
});

test("missing applicationId → 400 before any resolution/worker call", async () => {
  const ctx = makeContext();
  const res = await ctx.POST(requestFor({}), params());
  assert.equal(res.status, 400);
  assert.equal(ctx.resolveCalls.length, 0);
  assert.equal(ctx.workerCalls.length, 0);
});

test("route is nodejs runtime + force-dynamic and exposes POST only", () => {
  assert.match(routeCode, /export const runtime = "nodejs"/);
  assert.match(routeCode, /export const dynamic = "force-dynamic"/);
  assert.match(routeCode, /export async function POST\(/);
  assert.doesNotMatch(routeCode, /export async function (GET|PUT|PATCH|DELETE)\(/);
});

test("never persists the PDF — no storage/upload/put call anywhere in the route", () => {
  assert.doesNotMatch(routeCode, /storage\.put|getStorageProvider|storagePut/);
  assert.doesNotMatch(routeCode, /candidateDocuments|mergeJobs|merge_jobs/);
});
