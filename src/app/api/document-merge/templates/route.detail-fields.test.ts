/**
 * GET/PUT /api/document-merge/templates/[id]/fields — execute-dependency audit.
 * Node's test runner cannot discover a *.test.ts placed inside a `[id]`
 * bracketed route directory (see route.test.ts's header note for why) —
 * this file lives outside it and reads the sibling route by relative fs path.
 *
 * Reading a template's mapping is a READ-ONLY dependency of BOTH executing a
 * merge (Mapping Inspector auto-loads it once a template is selected in the
 * Merge tab) and managing mapping — so GET must accept document_merge.view,
 * document_merge.execute, OR document_merge.templates.manage. PUT (mutate
 * the mapping) remains templates.manage-only, unaffected by this fix.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createFakeDb, drizzleStub, makeTable, type FakeDb, type QueryCall } from "../../../../lib/test-support/fake-drizzle.ts";

const routeSource = readFileSync(new URL("./[id]/fields/route.ts", import.meta.url), "utf8");
const jsSource = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

const schemaStub = {
  mergeTemplateFields: makeTable("merge_template_fields"),
  mergeTemplates: makeTable("merge_templates"),
};

type Guard = { ok: true; session: { id: string; username: string; role: string } } | { ok: false; status: number; error: string };

function makeContext(opts: { guardResult: Guard; fieldRows?: Record<string, unknown>[] }) {
  const anyPermissionCalls: { roles: string[]; keys: string[] }[] = [];
  const db = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && call.table === "merge_template_fields") return opts.fieldRows ?? [];
      if (call.root === "select" && call.table === "merge_templates") return [{ id: "tpl-1", name: "Template A" }];
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
  const exported = moduleObj.exports as {
    GET: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<{ status: number; body: string }>;
    PUT: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<{ status: number; body: string }>;
  };
  return { GET: exported.GET, PUT: exported.PUT, anyPermissionCalls };
}

test("Regression 3 — execute=true, templates.manage=false: required mapping read (GET fields) returns 200", async () => {
  const ctx = makeContext({
    guardResult: { ok: true, session: { id: "u1", username: "tranmai", role: "ADMINISTRATION" } },
    fieldRows: [{ id: "f1", placeholder: "Ho_ten" }],
  });
  const res = await ctx.GET(new Request("http://localhost/api/document-merge/templates/tpl-1/fields"), { params: Promise.resolve({ id: "tpl-1" }) });
  assert.equal(res.status, 200, res.body);
  assert.deepEqual(Array.from(ctx.anyPermissionCalls[0].keys), ["document_merge.view", "document_merge.execute", "document_merge.templates.manage"]);
});

test("GET fields: no matching permission -> 403", async () => {
  const ctx = makeContext({ guardResult: { ok: false, status: 403, error: "Tài khoản của bạn không có quyền thực hiện thao tác này." } });
  const res = await ctx.GET(new Request("http://localhost/api/document-merge/templates/tpl-1/fields"), { params: Promise.resolve({ id: "tpl-1" }) });
  assert.equal(res.status, 403);
});

test("Regression 9 — execute-only cannot mutate mapping: PUT fields uses plain requirePermission(document_merge.templates.manage), rejected for execute-only", async () => {
  const ctx = makeContext({ guardResult: { ok: false, status: 403, error: "Tài khoản của bạn không có quyền thực hiện thao tác này." } });
  const req = new Request("http://localhost/api/document-merge/templates/tpl-1/fields", { method: "PUT", body: JSON.stringify({ fields: [] }) });
  const res = await ctx.PUT(req, { params: Promise.resolve({ id: "tpl-1" }) });
  assert.equal(res.status, 403);
  // requireAnyPermission must never be involved in PUT — mutation stays single-key only.
  assert.equal(ctx.anyPermissionCalls.length, 0);
});
