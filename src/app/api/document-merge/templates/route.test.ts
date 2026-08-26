/**
 * GET/POST /api/document-merge/templates — Dynamic RBAC V2 audit (Issue B).
 *
 * Listing templates must be reachable by EITHER document_merge.view OR
 * document_merge.templates.manage (two independent permissions — neither is
 * a parent of the other), so a templates.manage-only grant (no view) can
 * still open the Templates tab and see what it's managing. Creating a
 * template still independently requires document_merge.templates.manage
 * alone — this test also locks in that POST is untouched by the GET fix.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createFakeDb, drizzleStub, makeTable, type FakeDb, type QueryCall } from "../../../../lib/test-support/fake-drizzle.ts";

const routeSource = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
const jsSource = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

const schemaStub = {
  mergeTemplates: makeTable("merge_templates"),
  mergeTemplateFields: makeTable("merge_template_fields"),
};

type Guard = { ok: true; session: { id: string; username: string; role: string } } | { ok: false; status: number; error: string };

type Context = {
  GET: () => Promise<{ status: number; body: string }>;
  POST: (req: Request) => Promise<{ status: number; body: string }>;
  db: FakeDb;
  anyPermissionCalls: { roles: string[]; keys: string[] }[];
};

function makeContext(opts: { guardResult: Guard; templateRows?: Record<string, unknown>[] }): Context {
  const anyPermissionCalls: { roles: string[]; keys: string[] }[] = [];
  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "merge_templates") return opts.templateRows ?? [];
      if (call.root === "select" && call.table === "merge_template_fields") return [];
      if (call.root === "insert" && call.table === "merge_templates") return [{ id: "new-tpl", name: "Mẫu mới" }];
      return undefined;
    },
  });

  const moduleObj = { exports: {} as Record<string, unknown> };
  const context = vm.createContext({
    module: moduleObj,
    exports: moduleObj.exports,
    require: (id: string) => {
      switch (id) {
        case "next/server":
          return { NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body: JSON.stringify(body) }) } };
        case "drizzle-orm":
          return drizzleStub;
        case "@/db":
          return { db };
        case "@/db/schema":
          return schemaStub;
        case "@/lib/auth":
          return {
            requirePermission: async () => opts.guardResult,
            requireAnyPermission: async (roles: string[], keys: string[]) => {
              anyPermissionCalls.push({ roles, keys });
              return opts.guardResult;
            },
            writeAudit: async () => undefined,
          };
        case "@/lib/document-merge/template-routing":
          return { extractGoogleDocId: (s: string) => (s ? s : null) };
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
    Promise,
  });
  vm.runInContext(jsSource, context);
  const exported = moduleObj.exports as { GET: Context["GET"]; POST: Context["POST"] };
  return { GET: exported.GET, POST: exported.POST, db, anyPermissionCalls };
}

test("GET templates: requireAnyPermission is called with [document_merge.view, document_merge.templates.manage] — neither alone is required, both are accepted", async () => {
  const ctx = makeContext({ guardResult: { ok: true, session: { id: "u1", username: "u", role: "HR_SUPPORT" } } });
  const res = await ctx.GET();
  assert.equal(res.status, 200);
  assert.equal(ctx.anyPermissionCalls.length, 1);
  assert.deepEqual(Array.from(ctx.anyPermissionCalls[0].keys), ["document_merge.view", "document_merge.templates.manage"]);
});

test("GET templates: templates.manage-only grant (view=false) must still succeed — this is the exact 'child permission ineffective without parent' bug for the Templates tab's own data fetch", async () => {
  // requireAnyPermission itself decides pass/fail; here we simulate the "only
  // templates.manage granted" outcome by returning ok:true, matching what the
  // real requireAnyPermission would do once EITHER key is present.
  const ctx = makeContext({ guardResult: { ok: true, session: { id: "u1", username: "u", role: "HR_SUPPORT" } }, templateRows: [{ id: "tpl-1", name: "Mẫu A" }] });
  const res = await ctx.GET();
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.length, 1);
  assert.equal(body[0].name, "Mẫu A");
});

test("GET templates: no matching permission at all -> 403, list never returned", async () => {
  const ctx = makeContext({ guardResult: { ok: false, status: 403, error: "Tài khoản của bạn không có quyền thực hiện thao tác này." } });
  const res = await ctx.GET();
  assert.equal(res.status, 403);
});

test("POST templates (create) still independently requires document_merge.templates.manage via requirePermission — unaffected by the GET fix", async () => {
  const ctx = makeContext({ guardResult: { ok: true, session: { id: "u1", username: "admin", role: "ADMIN" } } });
  const req = new Request("http://localhost/api/document-merge/templates", {
    method: "POST",
    body: JSON.stringify({ name: "Mẫu mới", googleDocId: "doc-xyz" }),
  });
  const res = await ctx.POST(req);
  assert.equal(res.status, 201, res.body);
  // requireAnyPermission must NOT be involved in POST — only the plain, single-key requirePermission.
  assert.equal(ctx.anyPermissionCalls.length, 0);
});

/* ------------------------------------------------------------------ *
 * GET /api/document-merge/templates/[id] — same fix, single-template detail
 * (used by PDF Mapper / Templates-edit views). Node's test runner cannot
 * discover a *.test.ts file placed inside a `[id]` bracketed route
 * directory (its glob matcher treats "[id]" as a character class, silently
 * finding 0 files) — this repo has zero such test files anywhere else for
 * that exact reason — so this block lives here instead and reads the
 * sibling route's source by a literal relative fs path (fs.readFileSync is
 * not glob-matched, only Node's own test-file discovery is).
 * ------------------------------------------------------------------ */

const detailRouteSource = readFileSync(new URL("./[id]/route.ts", import.meta.url), "utf8");
const detailJsSource = ts.transpileModule(detailRouteSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

const detailSchemaStub = {
  mergeTemplates: makeTable("merge_templates"),
  mergeTemplateFields: makeTable("merge_template_fields"),
  mergeJobs: makeTable("merge_jobs"),
  documentHistory: makeTable("document_history"),
};

function makeDetailContext(opts: { guardResult: Guard; templateRow?: Record<string, unknown> }) {
  const anyPermissionCalls: { roles: string[]; keys: string[] }[] = [];
  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "merge_templates") return opts.templateRow ? [opts.templateRow] : [];
      if (call.root === "select" && call.table === "merge_template_fields") return [];
      return undefined;
    },
  });

  const moduleObj = { exports: {} as Record<string, unknown> };
  const context = vm.createContext({
    module: moduleObj,
    exports: moduleObj.exports,
    require: (id: string) => {
      switch (id) {
        case "next/server":
          return { NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body: JSON.stringify(body) }) } };
        case "drizzle-orm":
          return drizzleStub;
        case "@/db":
          return { db };
        case "@/db/schema":
          return detailSchemaStub;
        case "@/lib/auth":
          return {
            requirePermission: async () => opts.guardResult,
            requireAnyPermission: async (roles: string[], keys: string[]) => {
              anyPermissionCalls.push({ roles, keys });
              return opts.guardResult;
            },
            writeAudit: async () => undefined,
          };
        case "@/lib/document-merge/placeholder-extractor":
          return { extractUniquePlaceholders: () => [] };
        case "@/lib/document-merge/google-docs-service":
          return { createGoogleDocsService: () => ({}) };
        case "@/lib/document-merge/auto-mapping":
          return { autoMapAllPlaceholders: () => [] };
        case "@/lib/document-merge/template-routing":
          return { extractGoogleDocId: (s: string) => (s ? s : null) };
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
    Promise,
  });
  vm.runInContext(detailJsSource, context);
  const exported = moduleObj.exports as { GET: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<{ status: number; body: string }> };
  return { GET: exported.GET, anyPermissionCalls };
}

test("GET template detail ([id]): requireAnyPermission called with [document_merge.view, document_merge.templates.manage]", async () => {
  const ctx = makeDetailContext({ guardResult: { ok: true, session: { id: "u1", username: "u", role: "HR_SUPPORT" } }, templateRow: { id: "tpl-1", name: "Mẫu A" } });
  const res = await ctx.GET(new Request("http://localhost/api/document-merge/templates/tpl-1"), { params: Promise.resolve({ id: "tpl-1" }) });
  assert.equal(res.status, 200, res.body);
  assert.equal(ctx.anyPermissionCalls.length, 1);
  assert.deepEqual(Array.from(ctx.anyPermissionCalls[0].keys), ["document_merge.view", "document_merge.templates.manage"]);
});

test("GET template detail ([id]): no matching permission -> 403", async () => {
  const ctx = makeDetailContext({ guardResult: { ok: false, status: 403, error: "Tài khoản của bạn không có quyền thực hiện thao tác này." } });
  const res = await ctx.GET(new Request("http://localhost/api/document-merge/templates/tpl-1"), { params: Promise.resolve({ id: "tpl-1" }) });
  assert.equal(res.status, 403);
});
