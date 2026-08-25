/**
 * UNSAVED HTML PREVIEW ROUTE (H2) — regression tests.
 *
 * POST /api/document-merge/templates/[id]/versions/[versionId]/unsaved-preview
 *
 * Same pattern as draft-preview-route.test.ts: transpile the REAL route
 * source and run it inside a vm sandbox whose `require` shim throws for any
 * module the route is not allowed to depend on. The fake drizzle db records
 * EVERY statement, so "no write happened" is an assertion about the actual
 * emitted SQL, not a comment. normalizeFullHtmlDocument / analyzeTemplateSecurity
 * / computeAnalysisHash are the REAL modules (not stubbed) so the normalization
 * + security behavior is genuinely exercised end-to-end.
 *
 * PREVIEW test matrix (Phase 18, items 24-30):
 *   24. zero DB writes;  25. explicit candidate respected;
 *   26. Data Scope enforced;  27. explicit version/template guard (cross-template 404);
 *   28. canonical renderer reused (with the UNSAVED pasted content, not the
 *       persisted version body);  29. no merge job created;  30. no publish.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createFakeDb, drizzleStub, makeTable, eqValue, type FakeDb, type QueryCall } from "../test-support/fake-drizzle.ts";
import * as draftPreviewModule from "./draft-preview.ts";
import * as normalizerModule from "./full-document-normalizer.ts";
import * as securityModule from "./ai-template-security.ts";
import * as analysisHashModule from "./analysis-hash.ts";

const ROUTE_PATH = "src/app/api/document-merge/templates/[id]/versions/[versionId]/unsaved-preview/route.ts";
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
  POST: (req: Request, ctx: { params: Promise<{ id: string; versionId: string }> }) => Promise<{ status: number; body: Record<string, unknown> }>;
  db: FakeDb;
  renderCalls: { templateVersion: number; htmlBody: string; printCss: string | null }[];
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
            renderCanonicalDocument: (snapshot: { htmlBody: string; templateId: string; templateVersion: number; printCss: string | null }) => {
              renderCalls.push({ templateVersion: snapshot.templateVersion, htmlBody: snapshot.htmlBody, printCss: snapshot.printCss });
              return {
                html: `<!DOCTYPE html><html><body>${snapshot.htmlBody}</body></html>`,
                unreplaced: [],
                missingFields: [],
                valid: true,
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
        case "@/lib/document-merge/full-document-normalizer":
          return normalizerModule;
        case "@/lib/document-merge/ai-template-security":
          return securityModule;
        case "@/lib/document-merge/analysis-hash":
          return analysisHashModule;
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
    POST: (moduleObj.exports as { POST: Context["POST"] }).POST,
    db,
    renderCalls,
    loaderCalls,
    requiredIds,
  };
}

function requestFor(payload: Record<string, unknown>): Request {
  return new Request("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
}
const params = (id = "tpl-1", versionId = "ver-8") => ({ params: Promise.resolve({ id, versionId }) });

test("24. unsaved preview emits ZERO database writes", async () => {
  const ctx = makeContext();
  const res = await ctx.POST(requestFor({ applicationId: "app-1", rawHtml: "<html><body><<Ho_ten>></body></html>" }), params());
  assert.equal(res.status, 200);
  assert.equal(ctx.db.writes.length, 0, `expected zero writes, got ${JSON.stringify(ctx.db.writes.map((w) => `${w.root}:${w.table}`))}`);
  for (const table of ["merge_jobs", "merge_job_records", "document_history", "merge_templates", "merge_template_versions", "merge_template_fields", "audit_logs"]) {
    assert.equal(ctx.db.writesTo(table).length, 0, `must not write ${table}`);
  }
});

test("25. explicit candidate is respected — the requested applicationId is what gets rendered/loaded", async () => {
  const ctx = makeContext();
  const res = await ctx.POST(requestFor({ applicationId: "app-1", rawHtml: "<<Ho_ten>>" }), params());
  assert.equal(res.status, 200);
  assert.equal(res.body.applicationId, "app-1");
  assert.equal(JSON.stringify(ctx.loaderCalls), JSON.stringify([["app-1"]]));
});

test("26. Data Scope is enforced — an out-of-scope applicationId is rejected, never rendered", async () => {
  const ctx = makeContext({ scope: ["dept-allowed"], candidateDeptId: "dept-forbidden" });
  const res = await ctx.POST(requestFor({ applicationId: "app-1", rawHtml: "<<Ho_ten>>" }), params());
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "APPLICATION_NOT_FOUND");
  assert.equal(ctx.renderCalls.length, 0);
  assert.equal(ctx.loaderCalls.length, 0);
});

test("27. explicit version/template guard — a version id belonging to another template is rejected", async () => {
  const ctx = makeContext({ versions: [makeVersion(8, "DRAFT", [], "ver-8")] });
  const res = await ctx.POST(requestFor({ applicationId: "app-1", rawHtml: "<<Ho_ten>>" }), params("tpl-1", "ver-from-other-template"));
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "VERSION_NOT_FOUND");
  assert.equal(ctx.renderCalls.length, 0);
});

test("28. canonical renderer is reused, rendering the UNSAVED pasted content — never the persisted version body", async () => {
  const ctx = makeContext();
  const res = await ctx.POST(
    requestFor({ applicationId: "app-1", rawHtml: `<!DOCTYPE html><html><head><style>.a{color:red}</style></head><body>UNSAVED_PASTE_<<Ho_ten>></body></html>` }),
    params(),
  );
  assert.equal(res.status, 200);
  assert.equal(ctx.renderCalls.length, 1);
  assert.match(ctx.renderCalls[0].htmlBody, /UNSAVED_PASTE_/);
  assert.doesNotMatch(ctx.renderCalls[0].htmlBody, /PERSISTED_BODY/);
  assert.match(ctx.renderCalls[0].printCss ?? "", /\.a\{color:red\}/);
  assert.match(routeCode, /from "@\/lib\/document-merge\/canonical-document"/);
  assert.match(routeCode, /buildCanonicalSnapshot/);
  assert.match(routeCode, /renderCanonicalDocument/);
});

test("29. no merge job is created — mode/flags say so and no job-shaped module is reachable", async () => {
  const ctx = makeContext();
  const res = await ctx.POST(requestFor({ applicationId: "app-1", rawHtml: "<<Ho_ten>>" }), params());
  assert.equal(res.body.jobCreated, false);
  assert.equal(res.body.mode, "UNSAVED_HTML_PREVIEW");
  assert.equal(res.body.mutated, false);
  assert.deepEqual(ctx.requiredIds.filter((id) => /job|worker|mail|dispatch|drive|google/i.test(id)), []);
});

test("30. no publish occurs — publishTemplateVersion is never imported or called", async () => {
  const ctx = makeContext();
  const res = await ctx.POST(requestFor({ applicationId: "app-1", rawHtml: "<<Ho_ten>>" }), params());
  assert.equal(res.body.publishCalled, false);
  assert.doesNotMatch(routeCode, /publishTemplateVersion|rollbackTemplateVersion|archiveTemplateVersion/);
  assert.equal(ctx.requiredIds.filter((id) => /template-versions|publish/i.test(id)).length, 0);
});

test("security: a script tag in the pasted content blocks the preview render (defense in depth)", async () => {
  const ctx = makeContext();
  const res = await ctx.POST(requestFor({ applicationId: "app-1", rawHtml: `<html><body><script>evil()</script><<Ho_ten>></body></html>` }), params());
  assert.equal(res.status, 422);
  assert.equal(res.body.code, "SECURITY_BLOCKED");
  assert.equal(ctx.renderCalls.length, 0);
});

test("full-document paste mode: body extracted, external stylesheet flagged, never fetched", async () => {
  const ctx = makeContext();
  const rawHtml = `<!DOCTYPE html><html><head><link rel="stylesheet" href="https://cdn.example.com/x.css"></head><body><<Ho_ten>></body></html>`;
  const res = await ctx.POST(requestFor({ applicationId: "app-1", rawHtml }), params());
  assert.equal(res.status, 200);
  const warnings = res.body.externalResourceWarnings as { code: string; href?: string }[];
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].href, "https://cdn.example.com/x.css");
  assert.match(res.body.analysisHash as string, /^[0-9a-f]{64}$/);
});

test("non-admin/HR_RECRUITER roles are rejected with 403 before any read or render", async () => {
  for (const role of ["HR_SUPPORT", "DEPT_MANAGER", "HR_DIRECTOR", "GUEST"]) {
    const ctx = makeContext({ role });
    const res = await ctx.POST(requestFor({ applicationId: "app-1", rawHtml: "<<Ho_ten>>" }), params());
    assert.equal(res.status, 403, `${role} must be rejected`);
    assert.equal(ctx.renderCalls.length, 0);
    assert.equal(ctx.db.calls.length, 0, `${role} must not reach any query`);
  }
  assert.match(routeCode, /requirePermission\(\["ADMIN", "HR_RECRUITER"\],\s*"document_merge\.templates\.manage"\)/);
});

test("missing applicationId -> 400, nothing rendered", async () => {
  const ctx = makeContext();
  const res = await ctx.POST(requestFor({ rawHtml: "<<Ho_ten>>" }), params());
  assert.equal(res.status, 400);
  assert.equal(ctx.renderCalls.length, 0);
});

test("missing rawHtml -> 400, nothing rendered", async () => {
  const ctx = makeContext();
  const res = await ctx.POST(requestFor({ applicationId: "app-1" }), params());
  assert.equal(res.status, 400);
  assert.equal(ctx.renderCalls.length, 0);
});

test("unknown template -> 404 without rendering", async () => {
  const ctx = makeContext({ templateExists: false });
  const res = await ctx.POST(requestFor({ applicationId: "app-1", rawHtml: "<<Ho_ten>>" }), params());
  assert.equal(res.status, 404);
  assert.equal(res.body.code, "TEMPLATE_NOT_FOUND");
});

test("template without active mapping -> 422 (never renders raw placeholders)", async () => {
  const ctx = makeContext({ fields: [] });
  const res = await ctx.POST(requestFor({ applicationId: "app-1", rawHtml: "<<Ho_ten>>" }), params());
  assert.equal(res.status, 422);
  assert.equal(res.body.code, "MAPPING_MISSING");
  assert.equal(ctx.renderCalls.length, 0);
});

test("route is nodejs runtime + force-dynamic and exposes POST only", () => {
  assert.match(routeCode, /export const runtime = "nodejs"/);
  assert.match(routeCode, /export const dynamic = "force-dynamic"/);
  assert.match(routeCode, /export async function POST\(/);
  assert.doesNotMatch(routeCode, /export async function (GET|PUT|PATCH|DELETE)\(/);
});
