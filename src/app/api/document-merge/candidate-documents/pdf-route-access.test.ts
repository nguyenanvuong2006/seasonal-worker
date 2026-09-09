/**
 * GET /api/document-merge/candidate-documents/[id]/pdf — regression tests
 * (2026-09, "Lịch sử Merge" persistent reopen feature).
 *
 * This is the STAFF-facing equivalent of the candidate-facing
 * GET /api/candidate-consent/documents/[id]/pdf route: same
 * getStorageProvider().get(storageKey) streaming pattern, gated by staff
 * RBAC instead of a candidate access session, and — critically — NEVER
 * mutates the document's lifecycle status (a staff preview must never be
 * recorded as the candidate having viewed the document).
 *
 * ĐẶT Ở ĐÂY (không cạnh route.ts): thư mục route thật nằm dưới
 * `candidate-documents/[id]/pdf/` — `node --test` diễn giải `[id]` trong
 * đường dẫn file như character class, không bao giờ khớp path thật (xem
 * scan-route-google-auth-fallback.test.ts cho quirk giống hệt).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createFakeDb, drizzleStub, makeTable, type FakeDb } from "../../../../lib/test-support/fake-drizzle.ts";

const ROUTE_PATH = "src/app/api/document-merge/candidate-documents/[id]/pdf/route.ts";
const routeSource = readFileSync(new URL(`../../../../../${ROUTE_PATH}`, import.meta.url), "utf8");
const jsSource = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

const schemaStub = { candidateDocuments: makeTable("candidate_documents") };

type Options = {
  role?: string;
  permissions?: string[];
  doc?: Record<string, unknown> | null;
  storageBytes?: Buffer | null;
  storageThrows?: boolean;
  /** Custom error thrown by the local storage.get() call — overrides storageThrows's default GOOGLE_DRIVE_FILE_NOT_FOUND. */
  storageError?: string;
  workerResult?: { ok: boolean; status: number; data: Record<string, unknown> };
};

type Context = {
  GET: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<NextResponseLike>;
  db: FakeDb;
  updates: Record<string, unknown>[];
  storageGetCalls: string[];
  workerCalls: { path: string; body: unknown }[];
};

type NextResponseLike = { status: number; headers: Map<string, string>; bodyBytes?: Uint8Array; jsonBody?: unknown };

const DOC = {
  id: "cdoc-1",
  storageKey: "candidate-documents/cdoc-1.pdf",
  filename: "cdoc-1.pdf",
  status: "READY",
};

function makeContext(opts: Options = {}): Context {
  const updates: Record<string, unknown>[] = [];
  const doc = opts.doc === undefined ? DOC : opts.doc;
  const db = createFakeDb({
    respond: (call) => {
      if (call.root === "select" && call.table === "candidate_documents") return doc ? [doc] : [];
      if (call.root === "update" && call.table === "candidate_documents") {
        updates.push(call.ops[0].args[0] as Record<string, unknown>);
        return [];
      }
      return [];
    },
  });

  const storageGetCalls: string[] = [];
  const workerCalls: { path: string; body: unknown }[] = [];
  const bytes = opts.storageBytes === undefined ? Buffer.from("%PDF-1.4 fake bytes") : opts.storageBytes;

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
        case "@/lib/auth":
          return {
            requirePermission: async () => {
              if (opts.role === "DENIED") {
                return { ok: false as const, error: "Không có quyền.", status: 403 };
              }
              return {
                ok: true as const,
                session: { id: "staff-1", username: "staff", fullName: "Staff", role: opts.role ?? "ADMIN", deptId: null },
              };
            },
          };
        case "@/lib/storage":
          return {
            getStorageProvider: () => ({
              get: async (key: string) => {
                storageGetCalls.push(key);
                if (opts.storageThrows) throw new Error(opts.storageError ?? "GOOGLE_DRIVE_FILE_NOT_FOUND");
                if (bytes === null) throw new Error("no bytes configured");
                return bytes;
              },
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

  return { GET, db, updates, storageGetCalls, workerCalls };
}

function requestFor(mode?: string): Request {
  const url = mode ? `http://localhost/api/document-merge/candidate-documents/cdoc-1/pdf?mode=${mode}` : "http://localhost/api/document-merge/candidate-documents/cdoc-1/pdf";
  return new Request(url);
}

function callGet(ctx: Context, mode?: string) {
  return ctx.GET(requestFor(mode), { params: Promise.resolve({ id: "cdoc-1" }) });
}

test("READY document with mode=view → streams PDF bytes inline, no DB write", async () => {
  const ctx = makeContext();
  const res = await callGet(ctx, "view");

  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/pdf");
  assert.match(res.headers.get("content-disposition") ?? "", /^inline;/);
  assert.equal(new TextDecoder().decode(res.bodyBytes), "%PDF-1.4 fake bytes");
  assert.equal(ctx.updates.length, 0, "staff preview must NEVER mutate the document (no VIEWED transition)");
});

test("mode=download → attachment disposition, same bytes, no DB write", async () => {
  const ctx = makeContext();
  const res = await callGet(ctx, "download");

  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition") ?? "", /^attachment;/);
  assert.equal(ctx.updates.length, 0);
});

test("default mode (no query param) is view (inline) — satisfies both View and Print (native PDF viewer print button)", async () => {
  const ctx = makeContext();
  const res = await callGet(ctx);

  assert.match(res.headers.get("content-disposition") ?? "", /^inline;/);
});

test("document not found → 404, storage never touched", async () => {
  const ctx = makeContext({ doc: null });
  const res = await callGet(ctx);

  assert.equal(res.status, 404);
  assert.equal(ctx.storageGetCalls.length, 0);
});

test("document exists but has no storageKey yet (e.g. GENERATING/FAILED) → 404, never attempts storage read", async () => {
  const ctx = makeContext({ doc: { ...DOC, storageKey: null, status: "GENERATING" } });
  const res = await callGet(ctx);

  assert.equal(res.status, 404);
  assert.equal(ctx.storageGetCalls.length, 0);
});

test("staff without document_merge.candidate_documents.view_status → 403, storage never touched", async () => {
  const ctx = makeContext({ role: "DENIED" });
  const res = await callGet(ctx);

  assert.equal(res.status, 403);
  assert.equal(ctx.storageGetCalls.length, 0);
});

test("storage read failure (e.g. artifact deleted from Drive) → 502, never a crash", async () => {
  const ctx = makeContext({ storageThrows: true });
  const res = await callGet(ctx);

  assert.equal(res.status, 502);
});

test("uses the document's own storageKey — the route never trusts a client-supplied storage key (IDOR safety)", async () => {
  const ctx = makeContext();
  await callGet(ctx);

  assert.deepEqual(ctx.storageGetCalls, [DOC.storageKey]);
});

test("READY (not yet ISSUED) document is still viewable by staff — unlike the candidate-facing route which requires ISSUED+", async () => {
  const ctx = makeContext({ doc: { ...DOC, status: "READY" } });
  const res = await callGet(ctx, "view");
  assert.equal(res.status, 200);
});

/* ============================================================ *
 * Worker fallback (2026-09, Defect 1 fix) — same mechanism as the
 * candidate-facing route (PR #170): local read first, worker
 * /read-stored-pdf only on a confirmed Google-auth failure.
 * ============================================================ */

test("healthy local storage read → 200 PDF bytes, worker never called", async () => {
  const ctx = makeContext();
  const res = await callGet(ctx, "view");

  assert.equal(res.status, 200);
  assert.deepEqual(ctx.storageGetCalls, [DOC.storageKey]);
  assert.equal(ctx.workerCalls.length, 0, "healthy local read must never call the worker");
});

test("local invalid_grant → falls back to worker /read-stored-pdf → valid PDF → 200", async () => {
  const ctx = makeContext({
    storageThrows: true,
    storageError: "GOOGLE_DRIVE_AUTH_FAILED: invalid_grant — Bad Request",
    workerResult: { ok: true, status: 200, data: { pdfBase64: Buffer.from("%PDF-1.4 fake bytes").toString("base64") } },
  });
  const res = await callGet(ctx, "view");

  assert.equal(res.status, 200);
  assert.equal(new TextDecoder().decode(res.bodyBytes), "%PDF-1.4 fake bytes");
  assert.equal(ctx.workerCalls.length, 1);
  assert.equal(ctx.workerCalls[0].path, "/read-stored-pdf");
  assert.equal((ctx.workerCalls[0].body as { key?: string }).key, DOC.storageKey);
  assert.equal(ctx.updates.length, 0, "worker-fallback view must still never mutate the document");
});

test("local non-auth failure (file genuinely missing) does NOT fall back to the worker — 502 directly", async () => {
  const ctx = makeContext({ storageThrows: true, storageError: "GOOGLE_DRIVE_FILE_NOT_FOUND" });
  const res = await callGet(ctx, "view");

  assert.equal(res.status, 502);
  assert.equal(ctx.workerCalls.length, 0, "a non-auth failure must never trigger the worker fallback");
});

test("worker fallback itself fails → clean 502, no crash, no mutation", async () => {
  const ctx = makeContext({
    storageThrows: true,
    storageError: "Token has been expired or revoked.",
    workerResult: { ok: false, status: 502, data: { error: "worker could not reach storage either" } },
  });
  const res = await callGet(ctx, "view");

  assert.equal(res.status, 502);
  assert.equal(ctx.workerCalls.length, 1);
  assert.equal(ctx.updates.length, 0);
});

test("invalid PDF body (bad signature) from the worker fallback is rejected — 502, not streamed to staff", async () => {
  const ctx = makeContext({
    storageThrows: true,
    storageError: "GOOGLE_DRIVE_AUTH_FAILED: invalid_grant — Bad Request",
    workerResult: { ok: true, status: 200, data: { pdfBase64: Buffer.from("not a pdf at all").toString("base64") } },
  });
  const res = await callGet(ctx, "view");

  assert.equal(res.status, 502);
});

test("mode=download still works via the worker fallback path — attachment disposition, same bytes", async () => {
  const ctx = makeContext({
    storageThrows: true,
    storageError: "GOOGLE_DRIVE_AUTH_FAILED: invalid_grant — Bad Request",
    workerResult: { ok: true, status: 200, data: { pdfBase64: Buffer.from("%PDF-1.4 fake bytes").toString("base64") } },
  });
  const res = await callGet(ctx, "download");

  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition") ?? "", /^attachment;/);
  assert.equal(new TextDecoder().decode(res.bodyBytes), "%PDF-1.4 fake bytes");
});

test("route never calls any render/generation function — no regeneration, only the persisted artifact is ever streamed", () => {
  const routeSource = readFileSync(new URL(`../../../../../${ROUTE_PATH}`, import.meta.url), "utf8");
  assert.doesNotMatch(routeSource, /renderPdfBytes|renderApplicantHtml|exportGoogleDocAsPdf/);
});
