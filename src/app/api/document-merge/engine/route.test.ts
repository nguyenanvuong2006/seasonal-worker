/**
 * GET /api/document-merge/engine — execute-dependency audit.
 * The Merge workspace calls this on load to pick GOOGLE_DOCS vs async
 * HTML_PDF execution — an execute-only user must read it too, or the
 * workspace silently falls back to the wrong engine (its fetch swallows
 * a 403 via .catch()), which can send an HTML_PDF-configured merge down
 * the legacy synchronous path.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const routeSource = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
const jsSource = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

type Guard = { ok: true; session: { id: string; username: string; role: string } } | { ok: false; status: number; error: string };

function makeContext(opts: { guardResult: Guard; engine?: "GOOGLE_DOCS" | "HTML_PDF" }) {
  const anyPermissionCalls: { roles: string[]; keys: string[] }[] = [];
  const moduleObj = { exports: {} as Record<string, unknown> };
  const context = vm.createContext({
    module: moduleObj,
    exports: moduleObj.exports,
    require: (id: string) => {
      switch (id) {
        case "next/server":
          return { NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body: JSON.stringify(body) }) } };
        case "@/lib/auth":
          return {
            requireAnyPermission: async (roles: string[], keys: string[]) => {
              anyPermissionCalls.push({ roles, keys });
              return opts.guardResult;
            },
          };
        case "@/lib/document-merge/engine-config":
          return { getDocumentMergeEngine: () => opts.engine ?? "GOOGLE_DOCS" };
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

test("Regression — execute-only can read the configured engine (HTML_PDF vs GOOGLE_DOCS)", async () => {
  const ctx = makeContext({ guardResult: { ok: true, session: { id: "u1", username: "tranmai", role: "ADMINISTRATION" } }, engine: "HTML_PDF" });
  const res = await ctx.GET();
  assert.equal(res.status, 200, res.body);
  const body = JSON.parse(res.body);
  assert.equal(body.engine, "HTML_PDF", "execute-only must see the REAL configured engine, not a silent GOOGLE_DOCS fallback from a swallowed 403");
  assert.deepEqual(Array.from(ctx.anyPermissionCalls[0].keys), ["document_merge.view", "document_merge.execute"]);
});

test("engine: no matching permission -> 403", async () => {
  const ctx = makeContext({ guardResult: { ok: false, status: 403, error: "Tài khoản của bạn không có quyền thực hiện thao tác này." } });
  const res = await ctx.GET();
  assert.equal(res.status, 403);
});
