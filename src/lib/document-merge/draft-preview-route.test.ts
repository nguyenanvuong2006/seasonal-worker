/**
 * DRAFT VERSION PREVIEW ROUTE — regression tests.
 *
 * POST /api/document-merge/templates/[id]/versions/[versionId]/preview
 *
 * Same pattern as the other route tests in this repo: transpile the REAL route
 * source and run it inside a vm sandbox whose `require` shim throws for any
 * module the route is not allowed to depend on. The fake drizzle db records
 * EVERY statement, so "no write happened" is an assertion about the actual
 * emitted SQL calls, not a comment.
 *
 * Proves, for the v8-style DRAFT preview:
 *   1. publishTemplateVersion() is never imported or called;
 *   2. current_published_version cannot change (no UPDATE merge_templates);
 *   3. a DRAFT's mapping_snapshot stays [] (no UPDATE merge_template_versions);
 *   4. no merge job / job record / document_history row is created;
 *   5. the EXPLICITLY requested version is loaded, not the published one;
 *   6. a DRAFT resolves the CURRENT non-orphaned merge_template_fields;
 *   7. a PUBLISHED version still renders from its frozen mapping_snapshot;
 *   8. non-admin callers are rejected before any read/render;
 *   9. candidate data scope is enforced server-side.
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
  eqValue,
  type FakeDb,
  type QueryCall,
} from "../test-support/fake-drizzle.ts";
// The REAL pure decision module — the route's mapping/scope semantics are what
// these tests assert, so it is NOT stubbed.
import * as draftPreviewModule from "./draft-preview.ts";

/**
 * The route lives under a dynamic path segment (`[id]/[versionId]`), which
 * `node --test`'s shell glob cannot expand, so the test file itself lives here
 * next to the pure module and reads the real route source by path.
 */
const ROUTE_PATH =
  "src/app/api/document-merge/templates/[id]/versions/[versionId]/preview/route.ts";
const routeSource = readFileSync(new URL(`../../../${ROUTE_PATH}`, import.meta.url), "utf8");

/**
 * Executable route source with comments removed. Static "this identifier can
 * never appear" assertions must inspect CODE, not the documentation that
 * explains why the code avoids it.
 */
const routeCode = routeSource
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");
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
  name: "Giấy đăng ký tập nghề + Quy định + Hồ sơ thuế",
  googleDocId: "doc-1",
  documentKind: "B",
  isActive: true,
  // Production reality: v7 is the published pointer while v8 is the DRAFT.
  currentPublishedVersion: 7,
};

function makeVersion(
  version: number,
  status: string,
  mappingSnapshot: unknown[] = [],
  id = `ver-${version}`,
) {
  return {
    id,
    templateId: "tpl-1",
    version,
    status,
    htmlBody: `<div class="paper"><p>{{Ho_ten}}</p></div><div class="paper regulations-page"><p>v${version}</p></div>`,
    printCss: ".paper { width: 210mm; }",
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

const FROZEN_SNAPSHOT_ROW = {
  placeholder: "Ho_ten",
  sourceType: "CORE_FIELD",
  sourceEntity: null,
  sourceField: null,
  sourcePath: "FROZEN_AT_PUBLISH",
  optionValue: null,
  formatType: null,
  fallbackValue: null,
  isRequired: true,
};

type Options = {
  role?: string;
  /** Rows returned for merge_template_versions selects, keyed by version id. */
  versions?: ReturnType<typeof makeVersion>[];
  fields?: (typeof CURRENT_FIELD)[];
  scope?: string[] | null;
  candidateDeptId?: string | null;
  candidateExists?: boolean;
  templateExists?: boolean;
};

type Context = {
  POST: (
    req: Request,
    ctx: { params: Promise<{ id: string; versionId: string }> },
  ) => Promise<{ status: number; body: Record<string, unknown> }>;
  db: FakeDb;
  renderCalls: { templateVersion: number; mappings: { placeholder: string; sourcePath: string | null }[]; context: Record<string, unknown> }[];
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
            requirePermission: async (roles: string[]) => {
              if (!roles.includes(role)) {
                return { ok: false as const, status: 403, error: "Từ chối truy cập! Quyền hạn không hợp lệ." };
              }
              return {
                ok: true as const,
                session: { id: "u-1", username: role, fullName: role, role, deptId: null },
              };
            },
            getUserScope: async () => (opts.scope === undefined ? null : opts.scope),
          };
        case "@/lib/document-merge/canonical-document":
          return {
            CANONICAL_ACTION_VI: "ACTION",
            countCanonicalPages: (html: string) => (html.match(/class="paper/g) ?? []).length,
            isCanonicalTemplateError: (e: unknown) =>
              Boolean(e) && (e as { name?: string }).name === "CanonicalTemplateError",
            buildCanonicalSnapshot: (input: {
              templateId: string;
              version: ReturnType<typeof makeVersion>;
              mappings: { placeholder: string; sourcePath: string | null }[];
              formatting: Record<string, unknown>;
              allowUnpublishedForVerification?: boolean;
            }) => ({
              templateId: input.templateId,
              templateVersion: input.version.version,
              htmlBody: input.version.htmlBody,
              printCss: input.version.printCss,
              mappings: input.mappings,
              formatting: input.formatting,
              allowUnpublished: Boolean(input.allowUnpublishedForVerification),
            }),
            renderCanonicalDocument: (
              snapshot: {
                htmlBody: string;
                templateId: string;
                templateVersion: number;
                printCss: string | null;
                mappings: { placeholder: string; sourcePath: string | null }[];
              },
              _recordData: unknown,
              context: Record<string, unknown>,
            ) => {
              renderCalls.push({ templateVersion: snapshot.templateVersion, mappings: snapshot.mappings, context });
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
    POST: (moduleObj.exports as Context["POST"] extends never ? never : { POST: Context["POST"] }).POST,
    db,
    renderCalls,
    loaderCalls,
    requiredIds,
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

/* ------------------------------------------------------------------ *
 * 1. DRAFT preview does NOT publish.
 * ------------------------------------------------------------------ */

test("1. DRAFT preview never calls publishTemplateVersion() and never imports the publish service", async () => {
  const ctx = makeContext();
  const res = await ctx.POST(requestFor({ applicationId: "app-1" }), params());

  assert.equal(res.status, 200);
  assert.equal(res.body.publishCalled, false);
  assert.equal(res.body.versionStatus, "DRAFT");
  // Static proof: the route source cannot reach the publish service at all.
  assert.doesNotMatch(routeCode, /publishTemplateVersion|rollbackTemplateVersion|archiveTemplateVersion/);
  assert.doesNotMatch(routeCode, /template-versions/);
  assert.equal(
    ctx.requiredIds.filter((id) => /template-versions|publish/i.test(id)).length,
    0,
    "route must not require the publish/version-mutation service",
  );
});

/* ------------------------------------------------------------------ *
 * 2/3/4. Nothing is mutated: no publish pointer, no snapshot, no job.
 * ------------------------------------------------------------------ */

test("2. current_published_version cannot change — zero writes to merge_templates", async () => {
  const ctx = makeContext();
  const res = await ctx.POST(requestFor({ applicationId: "app-1" }), params());

  assert.equal(res.status, 200);
  assert.equal(ctx.db.writesTo("merge_templates").length, 0);
  // The published pointer is only ECHOED for operator context, never rendered from.
  assert.equal(res.body.currentPublishedVersion, 7);
  assert.equal(res.body.version, 8, "preview rendered the DRAFT, not the published pointer");
});

test("3. DRAFT mapping_snapshot stays [] — zero writes to merge_template_versions", async () => {
  const ctx = makeContext();
  const res = await ctx.POST(requestFor({ applicationId: "app-1" }), params());

  assert.equal(res.status, 200);
  assert.equal(res.body.mappingSnapshotCount, 0, "DRAFT snapshot must remain empty");
  assert.equal(ctx.db.writesTo("merge_template_versions").length, 0);
});

test("4. no merge job is created — the whole request emits SELECTs only", async () => {
  const ctx = makeContext();
  const res = await ctx.POST(requestFor({ applicationId: "app-1" }), params());

  assert.equal(res.status, 200);
  assert.equal(res.body.jobCreated, false);
  assert.equal(
    ctx.db.writes.length,
    0,
    `expected zero writes, got ${JSON.stringify(ctx.db.writes.map((w) => `${w.root}:${w.table}`))}`,
  );
  for (const table of [
    "merge_jobs",
    "merge_job_records",
    "document_history",
    "daily_applications",
    "merge_template_fields",
    "merge_templates",
    "merge_template_versions",
    "audit_logs",
  ]) {
    assert.equal(ctx.db.writesTo(table).length, 0, `must not write ${table}`);
  }
  assert.equal(ctx.db.transactions, 0, "read-only preview opens no transaction");
  // No job-creation / worker / dispatch / external module may be reachable.
  assert.doesNotMatch(routeCode, /createAsyncMergeJob|async-job|worker-trigger|google-(docs|drive)|mail/i);
  assert.deepEqual(
    ctx.requiredIds.filter((id) => /job|worker|mail|dispatch|drive|google/i.test(id)),
    [],
  );
});

/* ------------------------------------------------------------------ *
 * 5. Explicit version, never the published one.
 * ------------------------------------------------------------------ */

test("5. preview loads the EXPLICITLY requested version id (v8 DRAFT), never current_published_version", async () => {
  const ctx = makeContext({
    versions: [makeVersion(8, "DRAFT", [], "ver-8"), makeVersion(7, "PUBLISHED", [FROZEN_SNAPSHOT_ROW], "ver-7")],
  });
  const res = await ctx.POST(requestFor({ applicationId: "app-1" }), params("tpl-1", "ver-8"));

  assert.equal(res.status, 200);
  assert.equal(res.body.version, 8);
  assert.equal(res.body.versionId, "ver-8");
  assert.match(String(res.body.renderedHtml), /v8/);
  assert.doesNotMatch(String(res.body.renderedHtml), /v7/);
  assert.equal(ctx.renderCalls.length, 1);
  assert.equal(ctx.renderCalls[0].templateVersion, 8);

  const versionSelect = ctx.db.calls.find(
    (c): c is QueryCall => c.root === "select" && c.table === "merge_template_versions",
  );
  assert.ok(versionSelect);
  assert.equal(eqValue(versionSelect, "merge_template_versions.id"), "ver-8");
  // Cross-check: the version must also belong to the template in the path.
  assert.equal(eqValue(versionSelect, "merge_template_versions.templateId"), "tpl-1");
  // The route must never filter versions by status/PUBLISHED for this branch.
  assert.equal(eqValue(versionSelect, "merge_template_versions.status"), undefined);
  // The published pointer may only be ECHOED in the response, never used to
  // select the version that gets rendered.
  assert.doesNotMatch(routeCode, /where[\s\S]{0,200}currentPublishedVersion/);
});

test("5b. a version id belonging to another template is rejected (no cross-template preview)", async () => {
  const ctx = makeContext({ versions: [makeVersion(8, "DRAFT", [], "ver-8")] });
  const res = await ctx.POST(requestFor({ applicationId: "app-1" }), params("tpl-1", "ver-from-other-template"));

  assert.equal(res.status, 404);
  assert.equal(res.body.code, "VERSION_NOT_FOUND");
  assert.equal(ctx.renderCalls.length, 0);
  assert.equal(ctx.db.writes.length, 0);
});

/* ------------------------------------------------------------------ *
 * 6/7. Mapping semantics.
 * ------------------------------------------------------------------ */

test("6. DRAFT preview resolves the CURRENT non-orphaned merge_template_fields", async () => {
  const ctx = makeContext({
    fields: [CURRENT_FIELD, { ...CURRENT_FIELD, id: "f2", placeholder: "Ngay_sinh", sourcePath: "dob" }],
  });
  const res = await ctx.POST(requestFor({ applicationId: "app-1" }), params());

  assert.equal(res.status, 200);
  assert.equal(res.body.mappingSource, "CURRENT_MERGE_TEMPLATE_FIELDS");
  assert.deepEqual(res.body.mappingSummary, { total: 2, mapped: 2, required: 2 });
  assert.deepEqual(
    ctx.renderCalls[0].mappings.map((m) => m.placeholder),
    ["Ho_ten", "Ngay_sinh"],
  );

  const fieldSelect = ctx.db.calls.find(
    (c): c is QueryCall => c.root === "select" && c.table === "merge_template_fields",
  );
  assert.ok(fieldSelect);
  assert.equal(eqValue(fieldSelect, "merge_template_fields.templateId"), "tpl-1");
  assert.equal(
    eqValue(fieldSelect, "merge_template_fields.isOrphaned"),
    false,
    "same non-orphaned filter as pre-publish validation",
  );
});

test("7. PUBLISHED behaviour unchanged — renders its FROZEN mapping_snapshot, ignoring live field edits", async () => {
  const ctx = makeContext({
    versions: [makeVersion(7, "PUBLISHED", [FROZEN_SNAPSHOT_ROW], "ver-7")],
    fields: [{ ...CURRENT_FIELD, sourcePath: "EDITED_AFTER_PUBLISH" }],
  });
  const res = await ctx.POST(requestFor({ applicationId: "app-1" }), params("tpl-1", "ver-7"));

  assert.equal(res.status, 200);
  assert.equal(res.body.mappingSource, "PUBLISHED_MAPPING_SNAPSHOT");
  assert.equal(res.body.isPublishedCanonical, true);
  assert.equal(res.body.banner, null, "a published version shows no draft banner");
  assert.equal(ctx.renderCalls[0].mappings[0].sourcePath, "FROZEN_AT_PUBLISH");
  assert.equal(ctx.db.writes.length, 0);
});

test("7b. DRAFT preview surfaces the CHƯA XUẤT BẢN banner", async () => {
  const ctx = makeContext();
  const res = await ctx.POST(requestFor({ applicationId: "app-1" }), params());
  assert.equal(res.body.banner, "BẢN XEM TRƯỚC — CHƯA XUẤT BẢN");
  assert.equal(res.body.isPublishedCanonical, false);
  assert.equal(res.body.mode, "DRAFT_VERSION_PREVIEW");
});

/* ------------------------------------------------------------------ *
 * 8. Authorization.
 * ------------------------------------------------------------------ */

test("8. non-admin roles are rejected with 403 before any read, render or write", async () => {
  for (const role of ["HR_RECRUITER", "HR_SUPPORT", "DEPT_MANAGER", "HR_DIRECTOR", "ADMINISTRATION", "GUEST"]) {
    const ctx = makeContext({ role });
    const res = await ctx.POST(requestFor({ applicationId: "app-1" }), params());

    assert.equal(res.status, 403, `${role} must be rejected`);
    assert.equal(ctx.renderCalls.length, 0);
    assert.equal(ctx.loaderCalls.length, 0);
    assert.equal(ctx.db.calls.length, 0, `${role} must not reach any query`);
    assert.equal(ctx.db.writes.length, 0);
  }
  // Guard is the FIRST statement of the handler and demands ADMIN + permission.
  assert.match(
    routeCode,
    /requirePermission\(\["ADMIN"\],\s*"document_merge\.templates\.manage"\)/,
    "preview must require ADMIN + document_merge.templates.manage",
  );
});

/* ------------------------------------------------------------------ *
 * 9. Data scope.
 * ------------------------------------------------------------------ */

test("9. candidate data scope is enforced — out-of-scope applicationId is rejected, never rendered", async () => {
  const ctx = makeContext({ scope: ["dept-allowed"], candidateDeptId: "dept-forbidden" });
  const res = await ctx.POST(requestFor({ applicationId: "app-1" }), params());

  assert.equal(res.status, 404);
  assert.equal(res.body.code, "APPLICATION_NOT_FOUND");
  assert.equal(ctx.renderCalls.length, 0, "no document is rendered for an out-of-scope candidate");
  assert.equal(ctx.loaderCalls.length, 0, "the candidate record is never even loaded");
  assert.equal(ctx.db.writes.length, 0);
});

test("9b. an in-scope candidate renders; an unrestricted scope (null) also renders", async () => {
  const scoped = makeContext({ scope: ["dept-1"], candidateDeptId: "dept-1" });
  const scopedRes = await scoped.POST(requestFor({ applicationId: "app-1" }), params());
  assert.equal(scopedRes.status, 200);
  assert.equal(scoped.renderCalls.length, 1);

  const unrestricted = makeContext({ scope: null });
  const unrestrictedRes = await unrestricted.POST(requestFor({ applicationId: "app-1" }), params());
  assert.equal(unrestrictedRes.status, 200);
});

test("9c. an empty data scope can preview nobody", async () => {
  const ctx = makeContext({ scope: [], candidateDeptId: "dept-1" });
  const res = await ctx.POST(requestFor({ applicationId: "app-1" }), params());
  assert.equal(res.status, 404);
  assert.equal(ctx.renderCalls.length, 0);
});

test("9d. soft-deleted candidates are filtered in SQL (deleted_at IS NULL)", async () => {
  const ctx = makeContext();
  await ctx.POST(requestFor({ applicationId: "app-1" }), params());
  const select = ctx.db.calls.find(
    (c): c is QueryCall => c.root === "select" && c.table === "daily_applications",
  );
  assert.ok(select);
  assert.equal(eqValue(select, "daily_applications.id"), "app-1");
  assert.match(routeCode, /isNull\(dailyApplications\.deletedAt\)/);
});

/* ------------------------------------------------------------------ *
 * Input validation & failure modes.
 * ------------------------------------------------------------------ */

test("missing applicationId → 400, nothing loaded, nothing written", async () => {
  const ctx = makeContext();
  const res = await ctx.POST(requestFor({}), params());

  assert.equal(res.status, 400);
  assert.equal(res.body.code, "APPLICATION_REQUIRED");
  assert.equal(ctx.renderCalls.length, 0);
  assert.equal(ctx.db.writes.length, 0);
});

test("unknown template → 404 without rendering", async () => {
  const ctx = makeContext({ templateExists: false });
  const res = await ctx.POST(requestFor({ applicationId: "app-1" }), params());

  assert.equal(res.status, 404);
  assert.equal(res.body.code, "TEMPLATE_NOT_FOUND");
  assert.equal(ctx.renderCalls.length, 0);
});

test("template without active mapping → 422 (never renders raw placeholders)", async () => {
  const ctx = makeContext({ fields: [] });
  const res = await ctx.POST(requestFor({ applicationId: "app-1" }), params());

  assert.equal(res.status, 422);
  assert.equal(res.body.code, "MAPPING_MISSING");
  assert.equal(ctx.renderCalls.length, 0);
  assert.equal(ctx.db.writes.length, 0);
});

test("H3: a Signing Context supplied in the request body reaches renderCanonicalDocument's context and is echoed back in the response", async () => {
  const ctx = makeContext();
  const signingContext = { signingDate: "2026-08-26", signingLocation: "Đà Lạt" };
  const res = await ctx.POST(requestFor({ applicationId: "app-1", signingContext }), params());

  assert.equal(res.status, 200);
  assert.equal(ctx.renderCalls.length, 1);
  const passedContext = ctx.renderCalls[0].context.signingContext as { signingDate: string; signingLocation: string };
  assert.equal(passedContext.signingDate, "2026-08-26");
  assert.equal(passedContext.signingLocation, "Đà Lạt");
  assert.equal((res.body.signingContext as { signingDate: string }).signingDate, "2026-08-26");
});

test("H3: an omitted Signing Context resolves to the all-null empty context — never blocks Preview", async () => {
  const ctx = makeContext();
  const res = await ctx.POST(requestFor({ applicationId: "app-1" }), params());
  assert.equal(res.status, 200);
  const passedContext = ctx.renderCalls[0].context.signingContext as { signingDate: unknown };
  assert.equal(passedContext.signingDate, null);
});

test("H3: a malformed Signing Context is a controlled 400, not a 500 or a render", async () => {
  const ctx = makeContext();
  const res = await ctx.POST(requestFor({ applicationId: "app-1", signingContext: { signingDate: "not-a-date" } }), params());
  assert.equal(res.status, 400);
  assert.equal(ctx.renderCalls.length, 0);
});

test("preview uses the SHARED canonical renderer + the SAME record loader as the worker", async () => {
  const ctx = makeContext();
  const res = await ctx.POST(requestFor({ applicationId: "app-1" }), params());

  assert.equal(res.status, 200);
  assert.equal(res.body.renderer, "renderCanonicalDocument (shared Preview + HTML_PDF worker renderer)");
  assert.equal(JSON.stringify(ctx.loaderCalls), JSON.stringify([["app-1"]]));
  assert.match(routeCode, /from "@\/lib\/document-merge\/canonical-document"/);
  assert.match(routeCode, /loadDailyApplicationRecords/);

  const workerSource = readFileSync(new URL("../../../worker/src/index.ts", import.meta.url), "utf8");
  assert.match(
    workerSource,
    /renderCanonicalDocument[\s\S]*from "\.\.\/\.\.\/src\/lib\/document-merge\/canonical-document\.ts"/,
    "worker must import the SAME renderCanonicalDocument",
  );
});

test("route is nodejs runtime + force-dynamic and exposes POST only (no GET side effects)", () => {
  assert.match(routeCode, /export const runtime = "nodejs"/);
  assert.match(routeCode, /export const dynamic = "force-dynamic"/);
  assert.match(routeCode, /export async function POST\(/);
  assert.doesNotMatch(routeCode, /export async function (GET|PUT|PATCH|DELETE)\(/);
});
