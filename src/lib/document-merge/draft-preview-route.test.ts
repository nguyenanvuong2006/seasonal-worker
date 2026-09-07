/**
 * DRAFT VERSION PREVIEW ROUTE — regression tests.
 *
 * POST /api/document-merge/templates/[id]/versions/[versionId]/preview
 *
 * Same pattern as the other route tests in this repo: transpile the REAL
 * route source and run it inside a vm sandbox whose `require` shim throws
 * for any module the route is not allowed to depend on.
 *
 * As of the "A4 PDF Preview" refactor (2026-09), the route's own job is
 * narrow: auth guard, request parsing, calling the SHARED
 * resolveTemplateVersionPreview() (see preview-render.ts), and mapping its
 * result/errors to a JSON response. The deep behavioral proofs (mapping
 * resolution, scope enforcement, snapshot semantics, SQL write-safety) now
 * live in preview-render.test.ts, since both this route and the new
 * preview-pdf route share that exact resolver — testing it once there
 * covers both.
 *
 * This file proves, for the route itself:
 *   1. publishTemplateVersion() is never imported;
 *   2. non-admin callers are rejected before resolveTemplateVersionPreview
 *      is ever called;
 *   3. resolveTemplateVersionPreview()'s result is correctly mapped to the
 *      JSON response shape (banner, mode, pageCount, mapping fields, ...);
 *   4. PreviewResolutionError and CanonicalTemplateError are translated to
 *      the right status/body;
 *   5. Signing Context request-body validation (malformed → 400) happens
 *      before any resolution;
 *   6. runtime/dynamic/POST-only route contract.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const ROUTE_PATH = "src/app/api/document-merge/templates/[id]/versions/[versionId]/preview/route.ts";
const routeSource = readFileSync(new URL(`../../../${ROUTE_PATH}`, import.meta.url), "utf8");
const routeCode = routeSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const jsSource = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

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

const RESOLVED_RESULT = {
  template: { name: "Tpl", documentKind: "B", currentPublishedVersion: 7 },
  version: { id: "ver-8", version: 8, status: "DRAFT", mappingSnapshot: [] },
  rendered: {
    html: '<div class="paper"><p>x</p></div>',
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
  resolveResult?: typeof RESOLVED_RESULT | null;
  resolveError?: InstanceType<typeof PREVIEW_RESOLUTION_ERROR> | InstanceType<typeof CANONICAL_TEMPLATE_ERROR> | Error | null;
};

function makeContext(opts: Options = {}) {
  const role = opts.role ?? "ADMIN";
  const resolveCalls: Record<string, unknown>[] = [];

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
        case "@/lib/document-merge/canonical-document":
          return {
            countCanonicalPages: (html: string) => (html.match(/class="paper/g) ?? []).length,
          };
        case "@/lib/document-merge/preview-render":
          return {
            PreviewResolutionError: PREVIEW_RESOLUTION_ERROR,
            isCanonicalTemplateError: (e: unknown) => e instanceof CANONICAL_TEMPLATE_ERROR,
            CANONICAL_ACTION_VI: "CANONICAL_ACTION",
            resolveTemplateVersionPreview: async (input: Record<string, unknown>) => {
              resolveCalls.push(input);
              if (opts.resolveError) throw opts.resolveError;
              return opts.resolveResult ?? RESOLVED_RESULT;
            },
          };
        case "@/lib/document-merge/draft-preview":
          return {
            DRAFT_PREVIEW_MODE: "DRAFT_VERSION_PREVIEW",
            DRAFT_PREVIEW_BANNER_VI: "BẢN XEM TRƯỚC — CHƯA XUẤT BẢN",
            parseDraftPreviewRequest: (body: unknown) => {
              const data = (body ?? {}) as Record<string, unknown>;
              if (typeof data.applicationId !== "string" || !data.applicationId) {
                return { ok: false as const, error: { code: "APPLICATION_REQUIRED", error: "Cần applicationId." } };
              }
              const sc = data.signingContext as Record<string, unknown> | undefined;
              if (sc?.signingDate !== undefined && sc.signingDate !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(String(sc.signingDate))) {
                return { ok: false as const, error: { code: "INVALID_SIGNING_CONTEXT", error: "signingDate không hợp lệ." } };
              }
              return { ok: true as const, value: { applicationId: data.applicationId, signingContext: sc ?? {} } };
            },
          };
        default:
          throw new Error(`Unexpected require("${id}") — route must not depend on this module.`);
      }
    },
    process,
    Request,
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
    POST: (moduleObj.exports as { POST: (req: Request, ctx: { params: Promise<{ id: string; versionId: string }> }) => Promise<{ status: number; body: Record<string, unknown> }> }).POST,
    resolveCalls,
  };
}

function requestFor(payload: Record<string, unknown>): Request {
  return new Request("http://localhost/api/document-merge/templates/tpl-1/versions/ver-8/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

const params = (id = "tpl-1", versionId = "ver-8") => ({ params: Promise.resolve({ id, versionId }) });

test("publishTemplateVersion() is never imported or reachable from this route", () => {
  assert.doesNotMatch(routeCode, /publishTemplateVersion|rollbackTemplateVersion|archiveTemplateVersion/);
  assert.doesNotMatch(routeCode, /template-versions/);
});

test("non-admin roles are rejected with 403 before resolveTemplateVersionPreview is ever called", async () => {
  for (const role of ["HR_RECRUITER", "HR_SUPPORT", "DEPT_MANAGER", "HR_DIRECTOR", "ADMINISTRATION", "GUEST"]) {
    const ctx = makeContext({ role });
    const res = await ctx.POST(requestFor({ applicationId: "app-1" }), params());
    assert.equal(res.status, 403, `${role} must be rejected`);
    assert.equal(ctx.resolveCalls.length, 0);
  }
  assert.match(routeCode, /requirePermission\(\["ADMIN"\],\s*"document_merge\.templates\.manage"\)/);
});

test("successful resolution is mapped to the full JSON response shape", async () => {
  const ctx = makeContext();
  const res = await ctx.POST(requestFor({ applicationId: "app-1" }), params());

  assert.equal(res.status, 200);
  assert.equal(res.body.mode, "DRAFT_VERSION_PREVIEW");
  assert.equal(res.body.banner, "BẢN XEM TRƯỚC — CHƯA XUẤT BẢN");
  assert.equal(res.body.isPublishedCanonical, false);
  assert.equal(res.body.publishCalled, false);
  assert.equal(res.body.jobCreated, false);
  assert.equal(res.body.version, 8);
  assert.equal(res.body.versionId, "ver-8");
  assert.equal(res.body.currentPublishedVersion, 7);
  assert.equal(res.body.mappingSource, "CURRENT_MERGE_TEMPLATE_FIELDS");
  assert.deepEqual(res.body.mappingSummary, { total: 1, mapped: 1, required: 1 });
  assert.equal(res.body.renderedHtml, RESOLVED_RESULT.rendered.html);
  assert.equal(res.body.printCss, RESOLVED_RESULT.rendered.printCss);
  assert.deepEqual(res.body.margins, RESOLVED_RESULT.rendered.margins);
  assert.equal(res.body.fullName, "Trần Văn Dũng");
  assert.equal(res.body.pageCount, 1, "countCanonicalPages counts the rendered HTML's .paper divs");
  assert.equal(res.body.renderer, "renderCanonicalDocument (shared Preview + HTML_PDF worker renderer)");
  assert.equal(ctx.resolveCalls.length, 1);
  assert.equal(ctx.resolveCalls[0].templateId, "tpl-1");
  assert.equal(ctx.resolveCalls[0].versionId, "ver-8");
  assert.equal(ctx.resolveCalls[0].applicationId, "app-1");
});

test("PUBLISHED version (unpublished=false) shows no banner", async () => {
  const ctx = makeContext({
    resolveResult: { ...RESOLVED_RESULT, unpublished: false, version: { ...RESOLVED_RESULT.version, status: "PUBLISHED" } },
  });
  const res = await ctx.POST(requestFor({ applicationId: "app-1" }), params());
  assert.equal(res.body.banner, null);
  assert.equal(res.body.isPublishedCanonical, true);
});

test("PreviewResolutionError is translated to its own status/code/action", async () => {
  const ctx = makeContext({ resolveError: new PREVIEW_RESOLUTION_ERROR("APPLICATION_NOT_FOUND", "Không tìm thấy ứng viên.", 404, "Tìm lại.") });
  const res = await ctx.POST(requestFor({ applicationId: "app-1" }), params());
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "APPLICATION_NOT_FOUND");
  assert.equal(res.body.action, "Tìm lại.");
});

test("CanonicalTemplateError (thrown by the shared canonical pipeline) is translated to 422", async () => {
  const ctx = makeContext({ resolveError: new CANONICAL_TEMPLATE_ERROR("CANONICAL_SNAPSHOT_EMPTY", "tpl-1") });
  const res = await ctx.POST(requestFor({ applicationId: "app-1" }), params());
  assert.equal(res.status, 422);
  assert.equal(res.body.code, "CANONICAL_SNAPSHOT_EMPTY");
  assert.equal(res.body.templateId, "tpl-1");
});

test("an unexpected error is a controlled 500, not an unhandled throw", async () => {
  const ctx = makeContext({ resolveError: new Error("boom") });
  const res = await ctx.POST(requestFor({ applicationId: "app-1" }), params());
  assert.equal(res.status, 500);
  assert.equal(res.body.code, "DRAFT_PREVIEW_FAILED");
});

test("missing applicationId → 400 before resolveTemplateVersionPreview is called", async () => {
  const ctx = makeContext();
  const res = await ctx.POST(requestFor({}), params());
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "APPLICATION_REQUIRED");
  assert.equal(ctx.resolveCalls.length, 0);
});

test("a malformed Signing Context is a controlled 400 before resolution — never a 500", async () => {
  const ctx = makeContext();
  const res = await ctx.POST(requestFor({ applicationId: "app-1", signingContext: { signingDate: "not-a-date" } }), params());
  assert.equal(res.status, 400);
  assert.equal(ctx.resolveCalls.length, 0);
});

test("Signing Context supplied in the request body is passed through to resolveTemplateVersionPreview", async () => {
  const ctx = makeContext();
  const signingContext = { signingDate: "2026-08-26", signingLocation: "Đà Lạt" };
  const res = await ctx.POST(requestFor({ applicationId: "app-1", signingContext }), params());
  assert.equal(res.status, 200);
  assert.deepEqual(ctx.resolveCalls[0].signingContext, signingContext);
  assert.equal((res.body.signingContext as { signingDate: string }).signingDate, "2026-08-26");
});

test("route is nodejs runtime + force-dynamic and exposes POST only (no GET side effects)", () => {
  assert.match(routeCode, /export const runtime = "nodejs"/);
  assert.match(routeCode, /export const dynamic = "force-dynamic"/);
  assert.match(routeCode, /export async function POST\(/);
  assert.doesNotMatch(routeCode, /export async function (GET|PUT|PATCH|DELETE)\(/);
});
