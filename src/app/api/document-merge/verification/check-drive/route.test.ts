/**
 * POST /api/document-merge/verification/check-drive — a SKIPPED check (storage
 * provider isn't google_drive) must never report pass:true. It used to, which
 * let the Activation Gate show Google Drive as green even though nothing was
 * actually verified.
 *
 * Same vm-sandbox pattern as run-test/route.test.ts: transpile the real
 * route.ts source, run it with a require() shim for its few external deps.
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

type StorageProviderMock = {
  name: string;
  put?: (...args: unknown[]) => Promise<unknown>;
  getMetadata?: (...args: unknown[]) => Promise<unknown>;
  delete?: (...args: unknown[]) => Promise<unknown>;
  exists?: (...args: unknown[]) => Promise<boolean>;
};

function makeContext(storage: StorageProviderMock) {
  const moduleObj = { exports: {} as Record<string, unknown> };
  const context = vm.createContext({
    module: moduleObj,
    exports: moduleObj.exports,
    require: (id: string) => {
      switch (id) {
        case "next/server":
          return { NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body }) } };
        case "@/lib/auth":
          return { requirePermission: async () => ({ ok: true, session: { username: "admin-test" } }) };
        case "@/lib/verification/helpers":
          return { isVerificationEnabled: () => true };
        case "@/lib/storage/index":
          return { getStorageProvider: () => storage };
        default:
          throw new Error(`Unexpected require("${id}")`);
      }
    },
    process,
    Buffer,
    Date,
    console,
  });
  vm.runInContext(jsSource, context);
  return (moduleObj.exports as { POST: () => Promise<{ status: number; body: Record<string, unknown> }> }).POST;
}

test("check-drive: storage provider != google_drive -> pass:false + skipped:true (NOT pass:true)", async () => {
  const POST = makeContext({ name: "local" });
  const res = await POST();

  assert.equal(res.body.pass, false, "a skipped check must never report pass:true");
  assert.equal(res.body.skipped, true);
  assert.equal(res.body.provider, "local");
  assert.equal(res.body.checkedProcess, "vercel");
  assert.match(String(res.body.error), /google_drive/);
});

test("check-drive: storage provider == google_drive and probe succeeds -> pass:true", async () => {
  const POST = makeContext({
    name: "google_drive",
    put: async () => undefined,
    getMetadata: async () => ({ size: 42, sha256: "abc" }),
    delete: async () => undefined,
    exists: async () => false,
  });
  const res = await POST();

  assert.equal(res.body.pass, true);
  assert.equal(res.body.skipped, undefined);
  assert.equal(res.body.provider, "google_drive");
});

test("check-drive: storage provider == google_drive but probe throws -> pass:false with error, not skipped", async () => {
  const POST = makeContext({
    name: "google_drive",
    put: async () => {
      throw new Error("OAuth refresh token expired");
    },
  });
  const res = await POST();

  assert.equal(res.body.pass, false);
  assert.equal(res.body.skipped, undefined);
  assert.match(String(res.body.error), /OAuth refresh token expired/);
});
