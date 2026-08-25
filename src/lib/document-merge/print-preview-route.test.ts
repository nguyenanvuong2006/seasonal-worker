/**
 * PRINT-ONLY PREVIEW ROUTE — regression tests.
 *
 * GET /api/document-merge/templates/[id]/versions/[versionId]/print
 *
 * Same pattern as the other route tests in this repo: transpile the REAL route
 * source and run it inside a vm sandbox whose `require` shim throws for any
 * module the route is not allowed to depend on. The fake drizzle db records
 * EVERY statement, so "no write happened" is an assertion about the actual
 * emitted SQL calls, not a comment.
 *
 * Proves that the print-only view is the read-only, deterministic path the
 * operator needs for the visual PDF acceptance gate:
 *   1. it requires ADMIN + document_merge.templates.manage (non-admin → 403);
 *   2. it re-loads the EXPLICITLY requested version by id, never the published
 *      pointer, and re-checks the candidate Data Scope;
 *   3. a PUBLISHED version still renders from its frozen mapping_snapshot;
 *   4. a DRAFT version still resolves the CURRENT non-orphaned fields;
 *   5. it emits SELECTs only — zero writes, no job, no publish, no snapshot
 *      mutation, no Google Docs fallback, no transaction;
 *   6. the returned HTML is the canonical Preview document + a screen-only
 *      print toolbar + window.print(), never the admin page;
 *   7. autoprint=1 marks the page to open the dialog; without it the page is
 *      the mobile-safe manual fallback.
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
// The REAL pure modules — the route's mapping/scope/print semantics are what
// these tests assert, so they are NOT stubbed.
import * as draftPreviewModule from "./draft-preview.ts";
import * as printPreviewModule from "./print-preview.ts";

const ROUTE_PATH = "src/app/api/document-merge/templates/[id]/versions/[versionId]/print/route.ts";
const routeSource = readFileSync(new URL(`../../../${ROUTE_PATH}`, import.meta.url), "utf8");

/** Executable route source with comments removed (static assertions inspect CODE). */
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
  versions?: ReturnType<typeof makeVersion>[];
  fields?: (typeof CURRENT_FIELD)[];
  scope?: string[] | null;
  candidateDeptId?: string | null;
  candidateExists?: boolean;
  templateExists?: boolean;
};

type Context = {
  GET: (
    req: Request,
    ctx: { params: Promise<{ id: string; versionId: string }> },
  ) => Promise<{ status: number; body: string; headers: Record<string, string> }>;
  db: FakeDb;
  renderCalls: { templateVersion: number; mappings: { placeholder: string; sourcePath: string | null }[] }[];
  loaderCalls: string[][];
  requiredIds: string[];
};

class NextResponseStub {
  body: string;
  status: number;
  headers: Record<string, string>;
  constructor(body: string, init?: { status?: number; headers?: Record<string, string> }) {
    this.body = body;
    this.status = init?.status ?? 200;
    this.headers = init?.headers ?? {};
  }
  static json(body: unknown, init?: { status?: number }) {
    return new NextResponseStub(JSON.stringify(body), { status: init?.status ?? 200 });
  }
}

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
          return { NextResponse: NextResponseStub };
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
            renderCanonicalDocument: (snapshot: {
              htmlBody: string;
              templateId: string;
              templateVersion: number;
              printCss: string | null;
              mappings: { placeholder: string; sourcePath: string | null }[];
            }) => {
              renderCalls.push({ templateVersion: snapshot.templateVersion, mappings: snapshot.mappings });
              return {
                html: `<!DOCTYPE html><html><head><style>@page{size:A4;margin:12mm 12mm} .paper{width:210mm}</style></head><body>${snapshot.htmlBody}</body></html>`,
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
        case "@/lib/document-merge/print-preview":
          return printPreviewModule;
        default:
          throw new Error(`Unexpected require("${id}") — print route must not depend on this module.`);
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
    GET: (moduleObj.exports as { GET: Context["GET"] }).GET,
    db,
    renderCalls,
    loaderCalls,
    requiredIds,
  };
}

function requestFor(query: Record<string, string>): Request {
  const params = new URLSearchParams(query).toString();
  return new Request(`http://localhost/api/document-merge/templates/tpl-1/versions/ver-8/print?${params}`, {
    method: "GET",
  });
}

const params = (id = "tpl-1", versionId = "ver-8") => ({ params: Promise.resolve({ id, versionId }) });

/* ------------------------------------------------------------------ *
 * 1. Authorization.
 * ------------------------------------------------------------------ */

test("print: non-admin roles are rejected with 403 before any read, render or write", async () => {
  for (const role of ["HR_RECRUITER", "HR_SUPPORT", "DEPT_MANAGER", "HR_DIRECTOR", "ADMINISTRATION", "GUEST"]) {
    const ctx = makeContext({ role });
    const res = await ctx.GET(requestFor({ applicationId: "app-1" }), params());

    assert.equal(res.status, 403, `${role} must be rejected`);
    assert.equal(ctx.renderCalls.length, 0);
    assert.equal(ctx.loaderCalls.length, 0);
    assert.equal(ctx.db.calls.length, 0, `${role} must not reach any query`);
    assert.equal(ctx.db.writes.length, 0);
  }
  assert.match(
    routeCode,
    /requirePermission\(\["ADMIN"\],\s*"document_merge\.templates\.manage"\)/,
    "print must require ADMIN + document_merge.templates.manage",
  );
});

/* ------------------------------------------------------------------ *
 * 2. Explicit version + data scope (never the published pointer).
 * ------------------------------------------------------------------ */

test("print: loads the EXPLICITLY requested version id (v8 DRAFT), never current_published_version", async () => {
  const ctx = makeContext({
    versions: [makeVersion(8, "DRAFT", [], "ver-8"), makeVersion(7, "PUBLISHED", [FROZEN_SNAPSHOT_ROW], "ver-7")],
  });
  const res = await ctx.GET(requestFor({ applicationId: "app-1" }), params("tpl-1", "ver-8"));

  assert.equal(res.status, 200);
  assert.equal(ctx.renderCalls.length, 1);
  assert.equal(ctx.renderCalls[0].templateVersion, 8);
  assert.match(res.body, /v8/, "the printed document is the requested v8");

  const versionSelect = ctx.db.calls.find(
    (c): c is QueryCall => c.root === "select" && c.table === "merge_template_versions",
  );
  assert.ok(versionSelect);
  assert.equal(eqValue(versionSelect, "merge_template_versions.id"), "ver-8");
  assert.equal(eqValue(versionSelect, "merge_template_versions.templateId"), "tpl-1");
  assert.equal(eqValue(versionSelect, "merge_template_versions.status"), undefined, "never filters by status here");
  assert.doesNotMatch(routeCode, /where[\s\S]{0,200}currentPublishedVersion/);
});

test("print: candidate data scope is enforced — out-of-scope applicationId rejected, never rendered", async () => {
  const ctx = makeContext({ scope: ["dept-allowed"], candidateDeptId: "dept-forbidden" });
  const res = await ctx.GET(requestFor({ applicationId: "app-1" }), params());

  assert.equal(res.status, 404);
  assert.match(res.body, /Không tìm thấy ứng viên/);
  assert.equal(ctx.renderCalls.length, 0, "no document is rendered for an out-of-scope candidate");
  assert.equal(ctx.loaderCalls.length, 0, "the candidate record is never even loaded");
  assert.equal(ctx.db.writes.length, 0);
});

test("print: in-scope and unrestricted-scope candidates render; empty scope renders nobody", async () => {
  const scoped = makeContext({ scope: ["dept-1"], candidateDeptId: "dept-1" });
  const scopedRes = await scoped.GET(requestFor({ applicationId: "app-1" }), params());
  assert.equal(scopedRes.status, 200);
  assert.equal(scoped.renderCalls.length, 1);

  const unrestricted = makeContext({ scope: null });
  const unrestrictedRes = await unrestricted.GET(requestFor({ applicationId: "app-1" }), params());
  assert.equal(unrestrictedRes.status, 200);

  const empty = makeContext({ scope: [], candidateDeptId: "dept-1" });
  const emptyRes = await empty.GET(requestFor({ applicationId: "app-1" }), params());
  assert.equal(emptyRes.status, 404);
  assert.equal(empty.renderCalls.length, 0);
});

/* ------------------------------------------------------------------ *
 * 3/4. Mapping semantics.
 * ------------------------------------------------------------------ */

test("print: DRAFT resolves the CURRENT non-orphaned merge_template_fields", async () => {
  const ctx = makeContext({
    fields: [CURRENT_FIELD, { ...CURRENT_FIELD, id: "f2", placeholder: "Ngay_sinh", sourcePath: "dob" }],
  });
  const res = await ctx.GET(requestFor({ applicationId: "app-1" }), params());

  assert.equal(res.status, 200);
  assert.equal(res.headers["x-print-mode"], "DRAFT_VERSION_PREVIEW");
  assert.deepEqual(
    ctx.renderCalls[0].mappings.map((m) => m.placeholder),
    ["Ho_ten", "Ngay_sinh"],
  );

  const fieldSelect = ctx.db.calls.find(
    (c): c is QueryCall => c.root === "select" && c.table === "merge_template_fields",
  );
  assert.ok(fieldSelect, "must query merge_template_fields");
  assert.equal(eqValue(fieldSelect, "merge_template_fields.templateId"), "tpl-1");
  assert.equal(eqValue(fieldSelect, "merge_template_fields.isOrphaned"), false);
});

test("print: PUBLISHED version still renders its FROZEN mapping_snapshot, ignoring live field edits", async () => {
  const ctx = makeContext({
    versions: [makeVersion(7, "PUBLISHED", [FROZEN_SNAPSHOT_ROW], "ver-7")],
    fields: [{ ...CURRENT_FIELD, sourcePath: "EDITED_AFTER_PUBLISH" }],
  });
  const res = await ctx.GET(requestFor({ applicationId: "app-1" }), params("tpl-1", "ver-7"));

  assert.equal(res.status, 200);
  assert.equal(res.headers["x-print-mode"], "PUBLISHED_PREVIEW");
  assert.equal(ctx.renderCalls[0].mappings[0].sourcePath, "FROZEN_AT_PUBLISH");
  assert.equal(ctx.db.writes.length, 0);
});

/* ------------------------------------------------------------------ *
 * 5. No mutation: zero writes, no job, no publish, no snapshot change.
 * ------------------------------------------------------------------ */

test("print: the whole request emits SELECTs only — zero writes, no transaction", async () => {
  const ctx = makeContext();
  const res = await ctx.GET(requestFor({ applicationId: "app-1" }), params());

  assert.equal(res.status, 200);
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
  assert.equal(ctx.db.transactions, 0, "read-only print opens no transaction");
});

test("print: never reaches the publish service, the worker, dispatch, mail or Google Docs", async () => {
  const ctx = makeContext();
  await ctx.GET(requestFor({ applicationId: "app-1" }), params());

  assert.doesNotMatch(routeCode, /publishTemplateVersion|rollbackTemplateVersion|archiveTemplateVersion/);
  assert.doesNotMatch(routeCode, /createAsyncMergeJob|async-job|worker-trigger|google-(docs|drive)|mail/i);
  assert.deepEqual(
    ctx.requiredIds.filter((id) => /job|worker|mail|dispatch|drive|google|publish/i.test(id)),
    [],
  );
});

/* ------------------------------------------------------------------ *
 * 6/7. The print HTML is the canonical Preview document + print tooling.
 * ------------------------------------------------------------------ */

test("print: returns the canonical Preview document with A4 print CSS and window.print() — NOT the admin page", async () => {
  const ctx = makeContext();
  const res = await ctx.GET(requestFor({ applicationId: "app-1", autoprint: "1" }), params());

  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"], /text\/html/);
  assert.equal(res.headers["x-print-document"], "preview");
  assert.equal(res.headers["x-print-version"], "8");
  assert.equal(res.headers["x-print-status"], "DRAFT");

  // The canonical merged document body is present and its A4 CSS is intact.
  assert.match(res.body, /<div class="paper">/);
  assert.match(res.body, /@page\s*\{[^}]*size:\s*A4/);
  assert.match(res.body, /{{Ho_ten}}/, "placeholder replaced by the canonical renderer (kept as the token in the stub)");
  // The print tooling is added.
  assert.match(res.body, /class="print-toolbar"/);
  assert.match(res.body, /In \/ Lưu PDF/);
  assert.match(res.body, /window\.print\(\)/);
  assert.match(res.body, /@media print\s*\{\s*\.print-toolbar[^}]*display:\s*none\s*!important/);
  // autoprint=1 marks the body to open the dialog on load.
  assert.match(res.body, /data-autoprint="1"/);
  // It never prints the admin page.
  assert.doesNotMatch(res.body, /Danh sách Mẫu tài liệu/);
  assert.doesNotMatch(res.body, /Trộn tài liệu/);
});

test("print: without autoprint it is the mobile-safe manual fallback (no auto-print marker)", async () => {
  const ctx = makeContext();
  const res = await ctx.GET(requestFor({ applicationId: "app-1" }), params());

  assert.equal(res.status, 200);
  assert.doesNotMatch(res.body, /data-autoprint="1"/, "manual fallback must not auto-open the dialog");
  assert.match(res.body, /window\.print\(\)/, "the in-page button still prints");
  assert.match(res.body, /id="pt-print-btn"/);
});

/* ------------------------------------------------------------------ *
 * Failure modes.
 * ------------------------------------------------------------------ */

test("print: missing applicationId → 400, nothing loaded/written", async () => {
  const ctx = makeContext();
  const res = await ctx.GET(requestFor({}), params());

  assert.equal(res.status, 400);
  assert.equal(ctx.renderCalls.length, 0);
  assert.equal(ctx.loaderCalls.length, 0);
  assert.equal(ctx.db.writes.length, 0);
});

test("print: unknown template → 404 without rendering", async () => {
  const ctx = makeContext({ templateExists: false });
  const res = await ctx.GET(requestFor({ applicationId: "app-1" }), params());

  assert.equal(res.status, 404);
  assert.equal(ctx.renderCalls.length, 0);
});

test("print: template without active mapping → 422 (never renders raw placeholders)", async () => {
  const ctx = makeContext({ fields: [] });
  const res = await ctx.GET(requestFor({ applicationId: "app-1" }), params());

  assert.equal(res.status, 422);
  assert.equal(ctx.renderCalls.length, 0);
  assert.equal(ctx.db.writes.length, 0);
});

test("print: uses the SHARED canonical renderer + the SAME record loader as the worker", async () => {
  const ctx = makeContext();
  const res = await ctx.GET(requestFor({ applicationId: "app-1" }), params());

  assert.equal(res.status, 200);
  assert.equal(JSON.stringify(ctx.loaderCalls), JSON.stringify([["app-1"]]));
  assert.match(routeCode, /from "@\/lib\/document-merge\/canonical-document"/);
  assert.match(routeCode, /loadDailyApplicationRecords/);
  assert.match(routeCode, /renderCanonicalDocument/);

  const workerSource = readFileSync(new URL("../../../worker/src/index.ts", import.meta.url), "utf8");
  assert.match(
    workerSource,
    /renderCanonicalDocument[\s\S]*from "\.\.\/\.\.\/src\/lib\/document-merge\/canonical-document\.ts"/,
    "worker must import the SAME renderCanonicalDocument",
  );
});

test("route is nodejs runtime + force-dynamic and exposes GET only (no POST side effects)", () => {
  assert.match(routeCode, /export const runtime = "nodejs"/);
  assert.match(routeCode, /export const dynamic = "force-dynamic"/);
  assert.match(routeCode, /export async function GET\(/);
  assert.doesNotMatch(routeCode, /export async function (POST|PUT|PATCH|DELETE)\(/);
});
