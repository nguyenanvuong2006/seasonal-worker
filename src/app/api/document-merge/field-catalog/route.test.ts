/**
 * GET /api/document-merge/field-catalog — execute-dependency audit.
 * The placeholder catalog is a read-only dependency of the always-visible
 * Mapping Inspector inside the Merge tab (fetched automatically once a
 * template is selected) — an execute-only user must be able to read it.
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
  fieldDefinitions: makeTable("field_definitions"),
  formQuestions: makeTable("form_questions"),
};

type Guard = { ok: true; session: { id: string; username: string; role: string } } | { ok: false; status: number; error: string };

function makeContext(opts: { guardResult: Guard }) {
  const anyPermissionCalls: { roles: string[]; keys: string[] }[] = [];
  const db: FakeDb = createFakeDb({
    respond: (call: QueryCall) => {
      if (call.root === "select" && (call.table === "field_definitions" || call.table === "form_questions")) return [];
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
            requireAnyPermission: async (roles: string[], keys: string[]) => {
              anyPermissionCalls.push({ roles, keys });
              return opts.guardResult;
            },
          };
        case "@/lib/document-merge/field-catalog":
          return { buildFieldCatalogFromDefinitions: () => [] };
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
  const exported = moduleObj.exports as { GET: () => Promise<{ status: number; body: string }> };
  return { GET: exported.GET, anyPermissionCalls };
}

test("Regression — execute-only can read the field catalog (required by the auto-loading Mapping Inspector)", async () => {
  const ctx = makeContext({ guardResult: { ok: true, session: { id: "u1", username: "tranmai", role: "ADMINISTRATION" } } });
  const res = await ctx.GET();
  assert.equal(res.status, 200, res.body);
  assert.deepEqual(Array.from(ctx.anyPermissionCalls[0].keys), ["document_merge.view", "document_merge.execute", "document_merge.templates.manage"]);
});

test("field-catalog: no matching permission -> 403", async () => {
  const ctx = makeContext({ guardResult: { ok: false, status: 403, error: "Tài khoản của bạn không có quyền thực hiện thao tác này." } });
  const res = await ctx.GET();
  assert.equal(res.status, 403);
});
