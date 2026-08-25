/**
 * UNSAVED PRINT/PDF ACCEPTANCE ROUTE (H2) — regression tests.
 *
 * POST /api/document-merge/templates/[id]/versions/[versionId]/unsaved-print
 *
 * Same vm-sandbox pattern as print-preview-route.test.ts, adapted for a POST
 * body (form-encoded, as a real <form method="post" target="_blank"> submit
 * would send, plus a JSON fallback for programmatic callers) instead of GET
 * query params — this route exists because the saved print route's GET query
 * string cannot carry a megabyte-scale pasted HTML document and there is no
 * persisted versionId to read unsaved content back from (Phase 8).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createFakeDb, drizzleStub, makeTable, eqValue, type FakeDb, type QueryCall } from "../test-support/fake-drizzle.ts";
import * as draftPreviewModule from "./draft-preview.ts";
import * as printPreviewModule from "./print-preview.ts";
import * as normalizerModule from "./full-document-normalizer.ts";
import * as securityModule from "./ai-template-security.ts";
import * as unresolvedGuardModule from "./unresolved-placeholder-guard.ts";
import * as signingContextModule from "./signing-context.ts";

const ROUTE_PATH = "src/app/api/document-merge/templates/[id]/versions/[versionId]/unsaved-print/route.ts";
const routeSource = readFileSync(new URL(`../../../${ROUTE_PATH}`, import.meta.url), "utf8");
const routeCode = routeSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const jsSource = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

const schemaStub = {
  dailyApplications: makeTable("daily_applications"),
  departments: makeTable("departments"),
  mergeTemplateFields: makeTable("merge_template_fields"),
  mergeTemplates: makeTable("merge_templates"),
  mergeTemplateVersions: makeTable("merge_template_versions"),
};

const TEMPLATE = {
  id: "tpl-1",
  name: "Đăng ký tập nghề",
  googleDocId: "doc-1",
  documentKind: "B",
  isActive: true,
  currentPublishedVersion: 7,
};

function makeVersion(version: number, status: string, mappingSnapshot: unknown[] = [], id = `ver-${version}`) {
  return {
    id,
    templateId: "tpl-1",
    version,
    status,
    htmlBody: `PERSISTED_BODY_v${version}`,
    printCss: "PERSISTED_CSS",
    sourceDocxName: null,
    retentionYears: 3,
    mappingSnapshot,
    createdBy: "admin",
    publishedAt: status === "PUBLISHED" ? new Date("2026-08-20T00:00:00Z") : null,
    archivedAt: null,
    supersededBy: null,
    createdAt: new Date("2026-08-24T00:00:00Z"),
    updatedAt: new Date("2026-08-24T00:00:00Z"),
  };
}

const CURRENT_FIELD = {
  id: "f1",
  templateId: "tpl-1",
  placeholder: "Ho_ten",
  sourceType: "CORE_FIELD",
  sourceEntity: null,
  sourceField: null,
  sourcePath: "fullName",
  optionValue: null,
  formatType: null,
  fallbackValue: null,
  isRequired: true,
  isOrphaned: false,
  isSuggested: false,
};

type Options = {
  role?: string;
  versions?: ReturnType<typeof makeVersion>[];
  fields?: (typeof CURRENT_FIELD)[];
  scope?: string[] | null;
  candidateDeptId?: string | null;
  candidateExists?: boolean;
  templateExists?: boolean;
};

type Context = {
  POST: (req: Request, ctx: { params: Promise<{ id: string; versionId: string }> }) => Promise<Response>;
  db: FakeDb;
  renderCalls: { templateVersion: number; htmlBody: string; printCss: string | null; context: Record<string, unknown> }[];
  loaderCalls: string[][];
  requiredIds: string[];
};

function makeContext(opts: Options = {}): Context {
  const role = opts.role ?? "ADMIN";
  const versions = opts.versions ?? [makeVersion(8, "DRAFT")];
  const fields = opts.fields ?? [CURRENT_FIELD];

  const db = createFakeDb({
    respond: (call) => {
      if (call.root !== "select") return undefined;
      if (call.table === "merge_templates") return opts.templateExists === false ? [] : [TEMPLATE];
      if (call.table === "merge_template_versions") {
        const wantedId = eqValue(call, "merge_template_versions.id");
        return versions.filter((row) => row.id === wantedId);
      }
      if (call.table === "merge_template_fields") return fields;
      if (call.table === "daily_applications") {
        if (opts.candidateExists === false) return [];
        return [{ id: "app-1", deptId: opts.candidateDeptId === undefined ? "dept-1" : opts.candidateDeptId }];
      }
      return [];
    },
  });

  const renderCalls: Context["renderCalls"] = [];
  const loaderCalls: Context["loaderCalls"] = [];
  const requiredIds: string[] = [];

  const moduleObj = { exports: {} as Record<string, unknown> };
  const context = vm.createContext({
    module: moduleObj,
    exports: moduleObj.exports,
    require: (id: string) => {
      requiredIds.push(id);
      switch (id) {
        case "next/server":
          return {
            NextResponse: class {
              body: string;
              status: number;
              headers: Record<string, string>;
              constructor(body: string, init?: { status?: number; headers?: Record<string, string> }) {
                this.body = body;
                this.status = init?.status ?? 200;
                this.headers = init?.headers ?? {};
              }
              static json(body: unknown, init?: { status?: number }) {
                return { status: init?.status ?? 200, body: JSON.stringify(body), headers: {} };
              }
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
            requirePermission: async (roles: string[]) => {
              if (!roles.includes(role)) return { ok: false as const, status: 403, error: "Từ chối truy cập." };
              return { ok: true as const, session: { id: "u-1", username: role, fullName: role, role, deptId: null } };
            },
            getUserScope: async () => (opts.scope === undefined ? null : opts.scope),
          };
        case "@/lib/document-merge/canonical-document":
          return {
            CANONICAL_ACTION_VI: "ACTION",
            countCanonicalPages: () => 1,
            isCanonicalTemplateError: (e: unknown) => Boolean(e) && (e as { name?: string }).name === "CanonicalTemplateError",
            buildCanonicalSnapshot: (input: {
              templateId: string;
              version: { version: number; htmlBody: string; printCss: string | null };
              mappings: unknown[];
              formatting: Record<string, unknown>;
            }) => ({
              templateId: input.templateId,
              templateVersion: input.version.version,
              htmlBody: input.version.htmlBody,
              printCss: input.version.printCss,
              mappings: input.mappings,
              formatting: input.formatting,
            }),
            renderCanonicalDocument: (
              snapshot: { htmlBody: string; templateId: string; templateVersion: number; printCss: string | null },
              _recordData: unknown,
              renderContext: Record<string, unknown>,
            ) => {
              renderCalls.push({ templateVersion: snapshot.templateVersion, htmlBody: snapshot.htmlBody, printCss: snapshot.printCss, context: renderContext });
              const unreplaced = [...new Set([...snapshot.htmlBody.matchAll(/<<\s*([^>]+?)\s*>>/g)].map((m) => m[1]))];
              return {
                html: `<!DOCTYPE html><html><body>${snapshot.htmlBody}</body></html>`,
                unreplaced,
                missingFields: [],
                valid: unreplaced.length === 0,
                templateId: snapshot.templateId,
                templateVersion: snapshot.templateVersion,
                printCss: snapshot.printCss,
              };
            },
          };
        case "@/lib/document-merge/record-loader":
          return {
            loadDailyApplicationRecords: async (ids: string[]) => {
              loaderCalls.push(ids);
              return new Map([[ids[0], { id: ids[0], fullName: "Trần Văn Dũng", cccd: "068098012345" }]]);
            },
          };
        case "@/document-templates/registry":
          return { getHtmlTemplateContractByGoogleDocId: () => null };
        case "@/lib/document-merge/draft-preview":
          return draftPreviewModule;
        case "@/lib/document-merge/print-preview":
          return printPreviewModule;
        case "@/lib/document-merge/full-document-normalizer":
          return normalizerModule;
        case "@/lib/document-merge/ai-template-security":
          return securityModule;
        case "@/lib/document-merge/unresolved-placeholder-guard":
          return unresolvedGuardModule;
        case "@/lib/document-merge/signing-context":
          return signingContextModule;
        default:
          throw new Error(`Unexpected require("${id}") — route must not depend on this module.`);
      }
    },
    process,
    Request,
    Response,
    Headers,
    URL,
    URLSearchParams,
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
    RegExp,
  });
  vm.runInContext(jsSource, context);
  return {
    POST: (moduleObj.exports as { POST: Context["POST"] }).POST,
    db,
    renderCalls,
    loaderCalls,
    requiredIds,
  };
}

function jsonRequest(payload: Record<string, unknown>): Request {
  return new Request("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
}

function formRequest(fields: Record<string, string>): Request {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return new Request("http://localhost/x", { method: "POST", body: form });
}

const params = (id = "tpl-1", versionId = "ver-8") => ({ params: Promise.resolve({ id, versionId }) });

test("unsaved-print: non-admin/HR_RECRUITER roles are rejected with 403 before any read or render", async () => {
  for (const role of ["HR_SUPPORT", "DEPT_MANAGER", "HR_DIRECTOR", "GUEST"]) {
    const ctx = makeContext({ role });
    const res = await ctx.POST(jsonRequest({ applicationId: "app-1", rawHtml: "<<Ho_ten>>" }), params());
    assert.equal(res.status, 403, `${role} must be rejected`);
    assert.equal(ctx.renderCalls.length, 0);
    assert.equal(ctx.db.calls.length, 0);
  }
  assert.match(routeCode, /requirePermission\(\["ADMIN", "HR_RECRUITER"\],\s*"document_merge\.templates\.manage"\)/);
});

test("unsaved-print: a REAL multipart form submission (as a hidden <form> would send) is accepted and rendered", async () => {
  const ctx = makeContext();
  const res = await ctx.POST(
    formRequest({ applicationId: "app-1", rawHtml: `<html><body>FORM_SUBMIT_<<Ho_ten>></body></html>`, autoprint: "1" }),
    params(),
  );
  assert.equal(res.status, 200);
  assert.equal(ctx.renderCalls.length, 1);
  assert.match(ctx.renderCalls[0].htmlBody, /FORM_SUBMIT_/);
  const body = (res as unknown as { body: string }).body;
  assert.match(body, /data-autoprint="1"/);
});

test("unsaved-print: JSON body (programmatic caller) is also accepted", async () => {
  const ctx = makeContext();
  const res = await ctx.POST(jsonRequest({ applicationId: "app-1", rawHtml: `<html><body>JSON_CALL_<<Ho_ten>></body></html>` }), params());
  assert.equal(res.status, 200);
  assert.match(ctx.renderCalls[0].htmlBody, /JSON_CALL_/);
});

test("unsaved-print: renders the UNSAVED pasted content, never the persisted version body", async () => {
  const ctx = makeContext();
  const res = await ctx.POST(jsonRequest({ applicationId: "app-1", rawHtml: `<<Ho_ten>>` }), params());
  assert.equal(res.status, 200);
  assert.doesNotMatch(ctx.renderCalls[0].htmlBody, /PERSISTED_BODY/);
});

test("unsaved-print: candidate data scope is enforced — out-of-scope applicationId rejected, never rendered", async () => {
  const ctx = makeContext({ scope: ["dept-allowed"], candidateDeptId: "dept-forbidden" });
  const res = await ctx.POST(jsonRequest({ applicationId: "app-1", rawHtml: "<<Ho_ten>>" }), params());
  assert.equal(res.status, 404);
  assert.equal(ctx.renderCalls.length, 0);
});

test("unsaved-print: a version id belonging to another template is rejected (no cross-template print)", async () => {
  const ctx = makeContext({ versions: [makeVersion(8, "DRAFT", [], "ver-8")] });
  const res = await ctx.POST(jsonRequest({ applicationId: "app-1", rawHtml: "<<Ho_ten>>" }), params("tpl-1", "ver-from-other-template"));
  assert.equal(res.status, 404);
  assert.equal(ctx.renderCalls.length, 0);
});

test("unsaved-print: a script tag in the pasted content blocks the print render", async () => {
  const ctx = makeContext();
  const res = await ctx.POST(jsonRequest({ applicationId: "app-1", rawHtml: `<html><body><script>evil()</script><<Ho_ten>></body></html>` }), params());
  assert.equal(res.status, 422);
  assert.equal(ctx.renderCalls.length, 0);
});

test("unsaved-print: zero database writes for the whole request", async () => {
  const ctx = makeContext();
  await ctx.POST(jsonRequest({ applicationId: "app-1", rawHtml: "<<Ho_ten>>" }), params());
  assert.equal(ctx.db.writes.length, 0);
});

test("unsaved-print: response headers mark this as the UNSAVED_HTML_PREVIEW print mode, never persisted", async () => {
  const ctx = makeContext();
  const res = await ctx.POST(jsonRequest({ applicationId: "app-1", rawHtml: "<<Ho_ten>>" }), params());
  const headers = (res as unknown as { headers: Record<string, string> }).headers;
  assert.equal(headers["x-print-mode"], "UNSAVED_HTML_PREVIEW");
  assert.equal(headers["x-print-document"], "unsaved-preview");
});

test("DEFECT A FIX / print parity: a genuinely unmapped placeholder produces a prominent red warning banner in the print toolbar", async () => {
  const ctx = makeContext();
  const rawHtml = `<html><body><<Ho_ten>></body></html>`;
  const res = await ctx.POST(jsonRequest({ applicationId: "app-1", rawHtml }), params());
  assert.equal(res.status, 200);
  const body = (res as unknown as { body: string }).body;
  assert.match(body, /<div class="pt-warning">/);
  assert.match(body, /còn 1 trường chưa được thay thế/);
});

test("DEFECT A FIX: a fully-resolved print view has no warning banner element", async () => {
  const ctx = makeContext();
  const rawHtml = `<html><body>Ho ten: JA VALUE</body></html>`;
  const res = await ctx.POST(jsonRequest({ applicationId: "app-1", rawHtml }), params());
  assert.equal(res.status, 200);
  const body = (res as unknown as { body: string }).body;
  assert.doesNotMatch(body, /<div class="pt-warning">/);
});

test("unsaved-print: route is nodejs runtime + force-dynamic and exposes POST only", () => {
  assert.match(routeCode, /export const runtime = "nodejs"/);
  assert.match(routeCode, /export const dynamic = "force-dynamic"/);
  assert.match(routeCode, /export async function POST\(/);
  assert.doesNotMatch(routeCode, /export async function (GET|PUT|PATCH|DELETE)\(/);
});

test("H3: a JSON body's signingContext reaches the renderer", async () => {
  const ctx = makeContext();
  const res = await ctx.POST(
    jsonRequest({
      applicationId: "app-1",
      rawHtml: "<<Ho_ten>>",
      signingContext: { signingDate: "2026-08-26", signingLocation: "Đà Lạt" },
    }),
    params(),
  );
  assert.equal(res.status, 200);
  assert.equal(ctx.renderCalls.length, 1);
  const signingContext = ctx.renderCalls[0].context.signingContext as Record<string, unknown>;
  assert.equal(signingContext.signingDate, "2026-08-26");
  assert.equal(signingContext.signingLocation, "Đà Lạt");
});

test("H3: a real <form> submission's flat signingContext fields reach the renderer", async () => {
  const ctx = makeContext();
  const res = await ctx.POST(
    formRequest({
      applicationId: "app-1",
      rawHtml: "<<Ho_ten>>",
      signingDate: "2026-08-26",
      signingLocation: "Đà Lạt",
      receivedDate: "2026-08-20",
      receivedBy: "Nguyễn Văn A",
    }),
    params(),
  );
  assert.equal(res.status, 200);
  const signingContext = ctx.renderCalls[0].context.signingContext as Record<string, unknown>;
  assert.equal(signingContext.signingDate, "2026-08-26");
  assert.equal(signingContext.signingLocation, "Đà Lạt");
  assert.equal(signingContext.receivedDate, "2026-08-20");
  assert.equal(signingContext.receivedBy, "Nguyễn Văn A");
});

test("H3: signingContext defaults to an empty (all-null) context when omitted", async () => {
  const ctx = makeContext();
  const res = await ctx.POST(jsonRequest({ applicationId: "app-1", rawHtml: "<<Ho_ten>>" }), params());
  assert.equal(res.status, 200);
  const signingContext = ctx.renderCalls[0].context.signingContext as Record<string, unknown>;
  assert.equal(signingContext.signingDate, null);
  assert.equal(signingContext.signingLocation, null);
});

test("H3: a malformed signingContext is rejected with a 400 error page, never rendered", async () => {
  const ctx = makeContext();
  const res = await ctx.POST(
    jsonRequest({ applicationId: "app-1", rawHtml: "<<Ho_ten>>", signingContext: { signingDate: "not-a-date" } }),
    params(),
  );
  assert.equal(res.status, 400);
  assert.equal(ctx.renderCalls.length, 0);
  const body = (res as unknown as { body: string }).body;
  assert.match(body, /Ngày ký/);
});
