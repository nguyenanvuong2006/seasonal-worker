/**
 * GET /api/candidate-consent/documents/[id]/pdf — worker-fallback regression
 * tests (2026-09, blank-PDF credential-architecture fix, same class of
 * problem PR #162 fixed for finalize's GOOGLE_DOCS export/upload).
 *
 * Covers: local storage read healthy (no worker call), local Google-auth
 * failure falling back to the worker's /read-stored-pdf endpoint, a
 * non-auth local failure NOT falling back (worker never called), worker
 * failure surfacing as a clean 502, an invalid PDF body from either source
 * being rejected, IDOR staying enforced before any storage/worker call, and
 * VIEWED being written if-and-only-if a valid PDF was actually retrieved.
 *
 * ĐẶT Ở ĐÂY (không cạnh route.ts): thư mục route thật nằm dưới
 * `documents/[id]/pdf/` — `node --test` diễn giải `[id]` trong đường dẫn
 * file như character class, không bao giờ khớp path thật (xem
 * pdf-route-access.test.ts cho quirk giống hệt, route tương ứng phía staff).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { argOf, createFakeDb, drizzleStub, makeTable, type FakeDb } from "../../../../lib/test-support/fake-drizzle.ts";

const ROUTE_PATH = "src/app/api/candidate-consent/documents/[id]/pdf/route.ts";
const routeSource = readFileSync(new URL(`../../../../../${ROUTE_PATH}`, import.meta.url), "utf8");
const jsSource = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

const schemaStub = { auditLogs: makeTable("audit_logs"), candidateDocuments: makeTable("candidate_documents") };

type NextResponseLike = { status: number; headers: Map<string, string>; bodyBytes?: Uint8Array; jsonBody?: unknown };

const VALID_PDF = Buffer.from("%PDF-1.4 fake bytes");

const DOC = {
  id: "cdoc-1",
  applicationId: "app-1",
  storageKey: "Candidate Documents/2026/09/09/some-file.pdf",
  filename: "some-file.pdf",
  status: "ISSUED",
  viewedAt: null as Date | null,
};

type Options = {
  sessionValid?: boolean;
  scopedApplicationIds?: string[];
  doc?: Record<string, unknown> | null;
  localGet?: (key: string) => Promise<Buffer>;
  workerResult?: { ok: boolean; status: number; data: Record<string, unknown> };
};

type Context = {
  GET: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<NextResponseLike>;
  updates: Record<string, unknown>[];
  auditInserts: Record<string, unknown>[];
  localStorageGetCalls: string[];
  workerCalls: { path: string; body: unknown }[];
};

function makeContext(opts: Options = {}): Context {
  const updates: Record<string, unknown>[] = [];
  const auditInserts: Record<string, unknown>[] = [];
  const doc = opts.doc === undefined ? DOC : opts.doc;
  const db = createFakeDb({
    respond: (call) => {
      if (call.root === "select" && call.table === "candidate_documents") return doc ? [doc] : [];
      if (call.root === "update" && call.table === "candidate_documents") {
        updates.push(argOf(call, "set") as Record<string, unknown>);
        return [];
      }
      if (call.root === "insert" && call.table === "audit_logs") {
        auditInserts.push(argOf(call, "values") as Record<string, unknown>);
        return [];
      }
      return [];
    },
  });

  const localStorageGetCalls: string[] = [];
  const workerCalls: { path: string; body: unknown }[] = [];

  const defaultLocalGet = async (key: string) => {
    localStorageGetCalls.push(key);
    return VALID_PDF;
  };
  const localGet = opts.localGet ?? defaultLocalGet;

  const moduleObj = { exports: {} as Record<string, unknown> };
  const context = vm.createContext({
    module: moduleObj,
    exports: moduleObj.exports,
    require: (id: string) => {
      switch (id) {
        case "next/server": {
          class NextResponseStub extends Response {}
          (NextResponseStub as unknown as { json: (body: unknown, init?: { status?: number }) => NextResponseLike }).json = (
            body: unknown,
            init?: { status?: number },
          ) => ({ status: init?.status ?? 200, headers: new Map(), jsonBody: body });
          return { NextResponse: NextResponseStub };
        }
        case "drizzle-orm":
          return drizzleStub;
        case "@/db":
          return { db };
        case "@/db/schema":
          return schemaStub;
        case "@/lib/candidate-consent/lifecycle":
          return {
            canView: (status: string) => ["ISSUED", "VIEWED", "CONFIRMED"].includes(status),
            nextStatusOnView: (status: string) => (status === "ISSUED" ? "VIEWED" : status),
          };
        case "@/lib/candidate-consent/session-store":
          return {
            resolveAccessSession: async () =>
              opts.sessionValid === false ? null : { id: "sess-1", scopedApplicationIds: opts.scopedApplicationIds ?? [DOC.applicationId] },
            sessionCanAccess: (session: { scopedApplicationIds: string[] }, applicationId: string) =>
              session.scopedApplicationIds.includes(applicationId),
          };
        case "@/lib/storage":
          return {
            getStorageProvider: () => ({
              get: async (key: string) => localGet(key),
            }),
          };
        case "@/lib/verification/helpers":
          return {
            callWorker: async (path: string, body: unknown) => {
              workerCalls.push({ path, body });
              if (opts.workerResult) return opts.workerResult;
              return { ok: false, status: 503, data: { error: "no worker mock configured for this test" } };
            },
          };
        default:
          throw new Error(`Unexpected require("${id}") — route không được phụ thuộc module này.`);
      }
    },
    process,
    Request,
    Response,
    Buffer,
    Uint8Array,
    URL,
    console,
  });
  vm.runInContext(jsSource, context);

  const rawGET = (moduleObj.exports as { GET: (req: Request, ctx: unknown) => Promise<Response | NextResponseLike> }).GET;
  const GET = async (req: Request, ctx: { params: Promise<{ id: string }> }): Promise<NextResponseLike> => {
    const result = await rawGET(req, ctx);
    if (result instanceof Response) {
      const headers = new Map<string, string>();
      result.headers.forEach((v, k) => headers.set(k, v));
      const bodyBytes = new Uint8Array(await result.arrayBuffer());
      return { status: result.status, headers, bodyBytes };
    }
    return result as NextResponseLike;
  };

  return { GET, updates, auditInserts, localStorageGetCalls, workerCalls };
}

function callGet(ctx: Context) {
  return ctx.GET(new Request("http://localhost/api/candidate-consent/documents/cdoc-1/pdf"), {
    params: Promise.resolve({ id: "cdoc-1" }),
  });
}

test("healthy local storage read → 200 PDF bytes, worker never called, VIEWED written", async () => {
  const ctx = makeContext();
  const res = await callGet(ctx);

  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/pdf");
  assert.deepEqual(ctx.localStorageGetCalls, [DOC.storageKey]);
  assert.equal(ctx.workerCalls.length, 0, "healthy local read must never call the worker");
  assert.equal(ctx.updates.length, 1);
  assert.equal((ctx.updates[0] as { status: string }).status, "VIEWED");
});

test("local invalid_grant → falls back to worker /read-stored-pdf → valid PDF → 200, VIEWED written", async () => {
  const ctx = makeContext({
    localGet: async () => {
      throw new Error("GOOGLE_DRIVE_AUTH_FAILED: invalid_grant — Bad Request");
    },
    workerResult: { ok: true, status: 200, data: { pdfBase64: VALID_PDF.toString("base64"), byteLength: VALID_PDF.byteLength } },
  });
  const res = await callGet(ctx);

  assert.equal(res.status, 200);
  assert.equal(new TextDecoder().decode(res.bodyBytes), "%PDF-1.4 fake bytes");
  assert.equal(ctx.workerCalls.length, 1);
  assert.equal(ctx.workerCalls[0].path, "/read-stored-pdf");
  // Not deepEqual: the body object literal is constructed inside the vm
  // sandbox realm, whose Object.prototype differs from the host realm's —
  // compare the field directly instead of the whole object identity.
  assert.equal((ctx.workerCalls[0].body as { key?: string }).key, DOC.storageKey);
  assert.equal(ctx.updates.length, 1);
  assert.equal((ctx.updates[0] as { status: string }).status, "VIEWED");
});

test("local 'Token has been expired or revoked' auth failure also falls back to the worker (same isMissingGoogleAuthError matcher as finalize/route.ts)", async () => {
  const ctx = makeContext({
    localGet: async () => {
      throw new Error("Token has been expired or revoked.");
    },
    workerResult: { ok: true, status: 200, data: { pdfBase64: VALID_PDF.toString("base64") } },
  });
  const res = await callGet(ctx);

  assert.equal(res.status, 200);
  assert.equal(ctx.workerCalls.length, 1);
});

test("local NON-auth failure (e.g. file genuinely missing) does NOT fall back to the worker — surfaces as 502 directly", async () => {
  const ctx = makeContext({
    localGet: async () => {
      throw new Error("GOOGLE_DRIVE_FILE_NOT_FOUND");
    },
  });
  const res = await callGet(ctx);

  assert.equal(res.status, 502);
  assert.equal(ctx.workerCalls.length, 0, "a non-auth failure must never trigger the worker fallback");
  assert.equal(ctx.updates.length, 0, "failed retrieval must never write VIEWED");
});

test("worker fallback itself fails → clean 502, no VIEWED write", async () => {
  const ctx = makeContext({
    localGet: async () => {
      throw new Error("GOOGLE_DRIVE_AUTH_FAILED: invalid_grant — Bad Request");
    },
    workerResult: { ok: false, status: 502, data: { error: "worker could not reach storage either" } },
  });
  const res = await callGet(ctx);

  assert.equal(res.status, 502);
  assert.equal(ctx.workerCalls.length, 1);
  assert.equal(ctx.updates.length, 0, "a failed worker fallback must never write VIEWED");
});

test("invalid PDF body (bad signature) from the worker fallback is rejected — 502, no VIEWED write", async () => {
  const ctx = makeContext({
    localGet: async () => {
      throw new Error("GOOGLE_DRIVE_AUTH_FAILED: invalid_grant — Bad Request");
    },
    workerResult: { ok: true, status: 200, data: { pdfBase64: Buffer.from("not a pdf at all").toString("base64") } },
  });
  const res = await callGet(ctx);

  assert.equal(res.status, 502);
  assert.equal(ctx.updates.length, 0, "an invalid PDF body must never be treated as a successful view");
});

test("invalid PDF body (bad signature) from LOCAL storage is also rejected — 502, no VIEWED write, worker never called", async () => {
  const ctx = makeContext({
    localGet: async () => Buffer.from("not a pdf at all"),
  });
  const res = await callGet(ctx);

  assert.equal(res.status, 502);
  assert.equal(ctx.workerCalls.length, 0);
  assert.equal(ctx.updates.length, 0);
});

test("candidate IDOR remains blocked BEFORE any storage or worker call — a session outside scope never triggers a read", async () => {
  const ctx = makeContext({ scopedApplicationIds: ["some-other-application"] });
  const res = await callGet(ctx);

  assert.equal(res.status, 404);
  assert.equal(ctx.localStorageGetCalls.length, 0);
  assert.equal(ctx.workerCalls.length, 0);
  assert.equal(ctx.updates.length, 0);
});

test("no session at all → 401, storage/worker never touched", async () => {
  const ctx = makeContext({ sessionValid: false });
  const res = await callGet(ctx);

  assert.equal(res.status, 401);
  assert.equal(ctx.localStorageGetCalls.length, 0);
  assert.equal(ctx.workerCalls.length, 0);
});

test("VIEWED is written exactly once (re-viewing an already-VIEWED document does not re-write it) — success path only, still no duplicate worker calls", async () => {
  const ctx = makeContext({ doc: { ...DOC, status: "VIEWED", viewedAt: new Date("2026-01-01") } });
  const res = await callGet(ctx);

  assert.equal(res.status, 200);
  assert.equal(ctx.updates.length, 0, "an already-VIEWED document must not be re-written on every subsequent view");
});

test("no secret, storage key, or credential is ever present in an error response body sent to the client", async () => {
  const ctx = makeContext({
    localGet: async () => {
      throw new Error("GOOGLE_DRIVE_AUTH_FAILED: invalid_grant — Bad Request");
    },
    workerResult: { ok: false, status: 502, data: { error: "some worker error" } },
  });
  const res = await callGet(ctx);

  assert.equal(res.status, 502);
  const bodyText = JSON.stringify(res.jsonBody ?? {});
  assert.doesNotMatch(bodyText, /Candidate Documents\//, "storage key path must never appear in the client-facing error body");
  assert.doesNotMatch(bodyText, /invalid_grant/i, "the raw Google OAuth error must never reach the client");
});
