/**
 * APPLY-TO-DRAFT ROUTE (H2) — regression tests.
 *
 * POST /api/document-merge/templates/[id]/versions/[versionId]/apply-html
 *
 * Same vm-sandbox pattern as template-version-edit.test.ts's route half:
 * `@/lib/document-merge/template-versions` is STUBBED (updateTemplateVersionDraft
 * itself already has its own dedicated, exhaustive test suite in
 * template-version-edit.test.ts — proving its DRAFT-only + cross-template +
 * race guards against the real fake-drizzle db). These tests instead prove
 * everything THIS route adds on top: stale-hash rejection, security
 * revalidation, the single-active-draft guard, and that it delegates
 * persistence to the existing service rather than writing anything itself.
 *
 * full-document-normalizer / analysis-hash / ai-template-security /
 * ai-template-layout / placeholder-extractor / html-scanner / css-scanner are
 * the REAL modules (not stubbed), so normalization+validation is genuinely
 * exercised end-to-end.
 *
 * APPLY test matrix (Phase 18, items 31-40) + RACE (41) + SINGLE DRAFT (42):
 *   31. DRAFT update succeeds;  32. PUBLISHED rejected;  33. ARCHIVED rejected;
 *   34. cross-template rejected;  35. stale analysisHash rejected;
 *   36. security error rejected;  37. mapping_snapshot untouched (service
 *       call never includes it);  38. merge_template_fields untouched (zero
 *       writes to that table);  39. current_published_version untouched
 *       (zero writes to merge_templates);  40. audit contains no HTML/PII;
 *   41. DRAFT becomes PUBLISHED before UPDATE -> zero mutation (service
 *       surfaces this as 409, propagated verbatim);
 *   42. ambiguous active DRAFT state fails closed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createFakeDb, drizzleStub, makeTable, eqValue, hasOp, type FakeDb, type QueryCall } from "../test-support/fake-drizzle.ts";
import * as normalizerModule from "./full-document-normalizer.ts";
import * as analysisHashModule from "./analysis-hash.ts";
import * as securityModule from "./ai-template-security.ts";
import * as layoutModule from "./ai-template-layout.ts";
import * as placeholderExtractorModule from "./placeholder-extractor.ts";
import * as htmlScannerModule from "./html-scanner.ts";
import * as cssScannerModule from "./css-scanner.ts";
import { computeAnalysisHash } from "./analysis-hash.ts";

const ROUTE_PATH = "src/app/api/document-merge/templates/[id]/versions/[versionId]/apply-html/route.ts";
const routeSource = readFileSync(new URL(`../../../${ROUTE_PATH}`, import.meta.url), "utf8");
const routeCode = routeSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const jsSource = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

const schemaStub = {
  mergeTemplateFields: makeTable("merge_template_fields"),
  mergeTemplates: makeTable("merge_templates"),
  mergeTemplateVersions: makeTable("merge_template_versions"),
};

const TEMPLATE = { id: "tpl-1", name: "Đăng ký tập nghề", documentKind: "B" };

function makeVersion(version: number, status: string, id = `ver-${version}`) {
  return { id, templateId: "tpl-1", version, status, htmlBody: `PERSISTED_v${version}`, printCss: "PERSISTED_CSS", retentionYears: 3, mappingSnapshot: [] };
}

class FakeTemplateVersionError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

type Options = {
  role?: string;
  templateExists?: boolean;
  versions?: ReturnType<typeof makeVersion>[];
  /** All merge_template_versions rows with status DRAFT for the ambiguity-count query. */
  draftVersions?: ReturnType<typeof makeVersion>[];
  fields?: { placeholder: string }[];
  updateError?: { status: number; message: string };
};

type Context = {
  POST: (req: Request, ctx: { params: Promise<{ id: string; versionId: string }> }) => Promise<{ status: number; body: Record<string, unknown> }>;
  db: FakeDb;
  updateCalls: { templateId: string; versionId: string; input: Record<string, unknown> }[];
  auditCalls: { action: string; details: Record<string, unknown> }[];
  requiredIds: string[];
};

function makeContext(opts: Options = {}): Context {
  const role = opts.role ?? "ADMIN";
  const versions = opts.versions ?? [makeVersion(9, "DRAFT", "ver-9")];
  const draftVersions = opts.draftVersions ?? versions.filter((v) => v.status === "DRAFT");
  const fields = opts.fields ?? [];

  const db = createFakeDb({
    respond: (call) => {
      if (call.root !== "select") return undefined;
      if (call.table === "merge_templates") return opts.templateExists === false ? [] : [TEMPLATE];
      if (call.table === "merge_template_versions") {
        if (hasOp(call, "limit")) {
          const wantedId = eqValue(call, "merge_template_versions.id");
          const wantedTemplate = eqValue(call, "merge_template_versions.templateId");
          return versions.filter((v) => v.id === wantedId && v.templateId === wantedTemplate);
        }
        // The ambiguity-count query: templateId + status='DRAFT', no .limit().
        return draftVersions;
      }
      if (call.table === "merge_template_fields") return fields;
      return [];
    },
  });

  const updateCalls: Context["updateCalls"] = [];
  const auditCalls: Context["auditCalls"] = [];
  const requiredIds: string[] = [];

  const moduleObj = { exports: {} as Record<string, unknown> };
  const context = vm.createContext({
    module: moduleObj,
    exports: moduleObj.exports,
    require: (id: string) => {
      requiredIds.push(id);
      switch (id) {
        case "next/server":
          return { NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body }) } };
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
            writeAudit: async (_session: unknown, action: string, _targetType: string, details: Record<string, unknown>) => {
              auditCalls.push({ action, details });
            },
          };
        case "@/lib/document-merge/template-versions":
          return {
            TEMPLATE_VERSION_STATUS: { DRAFT: "DRAFT", PUBLISHED: "PUBLISHED", ARCHIVED: "ARCHIVED" },
            TemplateVersionError: FakeTemplateVersionError,
            updateTemplateVersionDraft: async (templateId: string, versionId: string, input: Record<string, unknown>) => {
              if (opts.updateError) throw new FakeTemplateVersionError(opts.updateError.message, opts.updateError.status);
              updateCalls.push({ templateId, versionId, input });
              return { id: versionId, templateId, version: 9, status: "DRAFT", htmlBody: input.htmlBody, printCss: input.printCss ?? null };
            },
          };
        case "@/lib/document-merge/full-document-normalizer":
          return normalizerModule;
        case "@/lib/document-merge/analysis-hash":
          return analysisHashModule;
        case "@/lib/document-merge/ai-template-security":
          return securityModule;
        case "@/lib/document-merge/ai-template-layout":
          return layoutModule;
        case "@/lib/document-merge/placeholder-extractor":
          return placeholderExtractorModule;
        case "@/lib/document-merge/html-scanner":
          return htmlScannerModule;
        case "@/lib/document-merge/css-scanner":
          return cssScannerModule;
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
    Error,
    TypeError,
    Promise,
  });
  vm.runInContext(jsSource, context);
  return {
    POST: (moduleObj.exports as { POST: Context["POST"] }).POST,
    db,
    updateCalls,
    auditCalls,
    requiredIds,
  };
}

function requestFor(payload: Record<string, unknown>): Request {
  return new Request("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
}
const params = (id = "tpl-1", versionId = "ver-9") => ({ params: Promise.resolve({ id, versionId }) });

function hashFor(rawHtml: string, explicitCss = ""): string {
  const normalized = normalizerModule.normalizeFullHtmlDocument(rawHtml);
  const printCss = [explicitCss, normalized.extractedCss].filter((s) => s && s.trim()).join("\n\n");
  return computeAnalysisHash(normalized.htmlBody, printCss);
}

test("31. DRAFT update succeeds — content delegated to updateTemplateVersionDraft, response reflects the applied version", async () => {
  const ctx = makeContext();
  const rawHtml = `<html><body>NEW_CONTENT_<<Ho_ten>></body></html>`;
  const res = await ctx.POST(requestFor({ rawHtml, analysisHash: hashFor(rawHtml) }), params());
  assert.equal(res.status, 200);
  assert.equal(res.body.applied, true);
  assert.equal(res.body.mutated, true);
  assert.equal(res.body.published, false);
  assert.equal(ctx.updateCalls.length, 1);
  assert.match(ctx.updateCalls[0].input.htmlBody as string, /NEW_CONTENT_/);
});

test("32. PUBLISHED version is rejected — 409, zero content mutation", async () => {
  const ctx = makeContext({ versions: [makeVersion(9, "PUBLISHED", "ver-9")], draftVersions: [] });
  const rawHtml = `<<Ho_ten>>`;
  const res = await ctx.POST(requestFor({ rawHtml, analysisHash: hashFor(rawHtml) }), params());
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "VERSION_NOT_DRAFT");
  assert.equal(ctx.updateCalls.length, 0);
});

test("33. ARCHIVED version is rejected — 409, zero content mutation", async () => {
  const ctx = makeContext({ versions: [makeVersion(9, "ARCHIVED", "ver-9")], draftVersions: [] });
  const rawHtml = `<<Ho_ten>>`;
  const res = await ctx.POST(requestFor({ rawHtml, analysisHash: hashFor(rawHtml) }), params());
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "VERSION_NOT_DRAFT");
  assert.equal(ctx.updateCalls.length, 0);
});

test("34. cross-template version id is rejected — 404, zero content mutation", async () => {
  const ctx = makeContext({ versions: [makeVersion(9, "DRAFT", "ver-9")] });
  const rawHtml = `<<Ho_ten>>`;
  const res = await ctx.POST(requestFor({ rawHtml, analysisHash: hashFor(rawHtml) }), params("tpl-1", "ver-from-other-template"));
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "VERSION_NOT_FOUND");
  assert.equal(ctx.updateCalls.length, 0);
});

test("35. stale analysisHash is rejected — 409, zero content mutation, operator-friendly Vietnamese message", async () => {
  const ctx = makeContext();
  const res = await ctx.POST(requestFor({ rawHtml: `<<Ho_ten>>`, analysisHash: "deadbeef".repeat(8) }), params());
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "STALE_ANALYSIS");
  assert.match(String(res.body.error), /Phân tích lại/);
  assert.doesNotMatch(String(res.body.error), /stack|Error:/i);
  assert.equal(ctx.updateCalls.length, 0);
});

test("36. hard security error blocks Apply — 409/422 zero content mutation, no partial write", async () => {
  const ctx = makeContext();
  const rawHtml = `<html><body><script>evil()</script><<Ho_ten>></body></html>`;
  const res = await ctx.POST(requestFor({ rawHtml, analysisHash: hashFor(rawHtml) }), params());
  assert.equal(res.status, 422);
  assert.equal(res.body.code, "SECURITY_BLOCKED");
  assert.equal(ctx.updateCalls.length, 0);
});

test("37/38/39. mapping_snapshot / merge_template_fields / current_published_version are never written — only the delegated service call carries content, and it never receives mapping/status fields", async () => {
  const ctx = makeContext();
  const rawHtml = `<<Ho_ten>>`;
  await ctx.POST(requestFor({ rawHtml, analysisHash: hashFor(rawHtml) }), params());
  assert.equal(ctx.db.writesTo("merge_templates").length, 0);
  assert.equal(ctx.db.writesTo("merge_template_fields").length, 0);
  assert.equal(ctx.db.writesTo("merge_template_versions").length, 0, "the route itself must not write directly — only via the delegated service");
  const input = ctx.updateCalls[0].input;
  assert.deepEqual(Object.keys(input).sort(), ["htmlBody", "printCss"]);
});

test("40. audit event contains NO html/css body and no candidate PII", async () => {
  const ctx = makeContext();
  const rawHtml = `<html><body>SECRET_HTML_CONTENT_<<Ho_ten>></body></html>`;
  await ctx.POST(requestFor({ rawHtml, explicitCss: "SECRET_CSS_CONTENT", analysisHash: hashFor(rawHtml, "SECRET_CSS_CONTENT") }), params());
  assert.equal(ctx.auditCalls.length, 1);
  assert.equal(ctx.auditCalls[0].action, "APPLY_TEMPLATE_HTML_DRAFT");
  const detailsJson = JSON.stringify(ctx.auditCalls[0].details);
  assert.doesNotMatch(detailsJson, /SECRET_HTML_CONTENT|SECRET_CSS_CONTENT/);
  assert.doesNotMatch(detailsJson, /fullName|cccd|phone|email|address/i);
});

test("41. RACE — version leaves DRAFT between this route's read and the service's write -> service's 409 is propagated verbatim, zero mutation", async () => {
  const ctx = makeContext({ updateError: { status: 409, message: "Version đã không còn là DRAFT (có thể vừa được publish/archive) — không thể lưu." } });
  const rawHtml = `<<Ho_ten>>`;
  const res = await ctx.POST(requestFor({ rawHtml, analysisHash: hashFor(rawHtml) }), params());
  assert.equal(res.status, 409);
  assert.match(String(res.body.error), /không còn là DRAFT/);
});

test("42. SINGLE DRAFT — more than one DRAFT version for the template fails closed without applying", async () => {
  const ctx = makeContext({
    versions: [makeVersion(9, "DRAFT", "ver-9"), makeVersion(10, "DRAFT", "ver-10")],
    draftVersions: [makeVersion(9, "DRAFT", "ver-9"), makeVersion(10, "DRAFT", "ver-10")],
  });
  const rawHtml = `<<Ho_ten>>`;
  const res = await ctx.POST(requestFor({ rawHtml, analysisHash: hashFor(rawHtml) }), params("tpl-1", "ver-9"));
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "SINGLE_DRAFT_AMBIGUOUS");
  assert.equal(ctx.updateCalls.length, 0);
});

test("Phase 15: SINGLE DRAFT guard response is operator-safe — names the ambiguous versions and a non-destructive next step, without archiving/deleting anything", async () => {
  const ctx = makeContext({
    versions: [makeVersion(9, "DRAFT", "ver-9"), makeVersion(10, "DRAFT", "ver-10")],
    draftVersions: [makeVersion(9, "DRAFT", "ver-9"), makeVersion(10, "DRAFT", "ver-10")],
  });
  const rawHtml = `<<Ho_ten>>`;
  const res = await ctx.POST(requestFor({ rawHtml, analysisHash: hashFor(rawHtml) }), params("tpl-1", "ver-10"));
  assert.equal(res.status, 409);
  assert.deepEqual(res.body.draftVersions, [9, 10]);
  assert.match(String(res.body.error), /2 bản nháp/);
  assert.match(String(res.body.action), /Archive/);
  // Never destructive — no write of any kind, whichever DRAFT was targeted.
  assert.equal(ctx.updateCalls.length, 0);
  assert.equal(ctx.db.writes.length, 0);
});

test("new placeholders are reported but never auto-mapped (Phase 14) — no mapping write, response surfaces the count", async () => {
  const ctx = makeContext({ fields: [{ placeholder: "Ho_ten" }] });
  const rawHtml = `<<Ho_ten>><<Ngay_sinh>>`;
  const res = await ctx.POST(requestFor({ rawHtml, analysisHash: hashFor(rawHtml) }), params());
  assert.equal(res.status, 200);
  assert.equal((res.body.placeholders as { new: number }).new, 1);
  assert.equal(ctx.db.writesTo("merge_template_fields").length, 0);
});

test("missing analysisHash -> 400, ANALYSIS_REQUIRED, nothing applied", async () => {
  const ctx = makeContext();
  const res = await ctx.POST(requestFor({ rawHtml: `<<Ho_ten>>` }), params());
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "ANALYSIS_REQUIRED");
  assert.equal(ctx.updateCalls.length, 0);
});

test("missing rawHtml -> 400, nothing applied", async () => {
  const ctx = makeContext();
  const res = await ctx.POST(requestFor({ analysisHash: "x" }), params());
  assert.equal(res.status, 400);
  assert.equal(ctx.updateCalls.length, 0);
});

test("unknown template -> 404, nothing applied", async () => {
  const ctx = makeContext({ templateExists: false });
  const rawHtml = `<<Ho_ten>>`;
  const res = await ctx.POST(requestFor({ rawHtml, analysisHash: hashFor(rawHtml) }), params());
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "TEMPLATE_NOT_FOUND");
  assert.equal(ctx.updateCalls.length, 0);
});

test("non-admin/HR_RECRUITER roles are rejected with 403 before any read or write", async () => {
  for (const role of ["HR_SUPPORT", "DEPT_MANAGER", "HR_DIRECTOR", "GUEST"]) {
    const ctx = makeContext({ role });
    const rawHtml = `<<Ho_ten>>`;
    const res = await ctx.POST(requestFor({ rawHtml, analysisHash: hashFor(rawHtml) }), params());
    assert.equal(res.status, 403, `${role} must be rejected`);
    assert.equal(ctx.updateCalls.length, 0);
    assert.equal(ctx.db.calls.length, 0);
  }
  assert.match(routeCode, /requirePermission\(\["ADMIN", "HR_RECRUITER"\],\s*"document_merge\.templates\.manage"\)/);
});

test("route never imports the publish service — apply cannot publish", async () => {
  const ctx = makeContext();
  const rawHtml = `<<Ho_ten>>`;
  await ctx.POST(requestFor({ rawHtml, analysisHash: hashFor(rawHtml) }), params());
  assert.doesNotMatch(routeCode, /publishTemplateVersion|rollbackTemplateVersion|archiveTemplateVersion|cloneTemplateVersion/);
  assert.equal(ctx.requiredIds.filter((id) => /publish/i.test(id)).length, 0);
});

test("route is nodejs runtime + force-dynamic and exposes POST only", () => {
  assert.match(routeCode, /export const runtime = "nodejs"/);
  assert.match(routeCode, /export const dynamic = "force-dynamic"/);
  assert.match(routeCode, /export async function POST\(/);
  assert.doesNotMatch(routeCode, /export async function (GET|PUT|PATCH|DELETE)\(/);
});
