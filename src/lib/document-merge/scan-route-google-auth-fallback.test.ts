/**
 * POST /api/document-merge/templates/[id]/scan — regression tests cho fix
 * "Quét lại Google Docs" báo GOOGLE_AUTH_MISSING dù Cloud Run worker đã có
 * credential Google hoạt động (2026-09).
 *
 * ROOT CAUSE: route này chạy trên Vercel, một runtime TÁCH BIỆT với Cloud
 * Run worker. createGoogleDocsService() đọc GOOGLE_CLIENT_ID/SECRET/
 * REFRESH_TOKEN (hoặc GOOGLE_SERVICE_ACCOUNT_*) từ process.env CỦA RUNTIME
 * ĐANG CHẠY — Vercel không được đảm bảo có bản sao riêng của các biến này
 * (xem docs/DOCUMENT-MERGE-VERCEL-SETUP.md), dù Cloud Run worker đã có sẵn
 * qua GCP Secret Manager và đã dùng thành công để merge/upload PDF.
 *
 * FIX: getGoogleDocPlainText() (trong scan/route.ts) thử credential cục bộ
 * trước (giữ nguyên hành vi cũ khi Vercel CÓ credential); chỉ khi lỗi cụ thể
 * là "thiếu credential Google cục bộ", mới gọi sang Cloud Run worker's POST
 * /read-google-doc qua callWorker() (kênh Vercel→worker đã có sẵn, dùng
 * chung cho /preview-pdf, /run) để dùng lại đúng credential Google đã xác
 * minh hoạt động của worker — không tạo kết nối Google thứ hai, không lộ
 * token/secret.
 *
 * Cùng khuôn mẫu preview/route.test.ts (repo không có jsdom): transpile
 * ĐÚNG source route.ts thật, chạy trong vm sandbox với require() giả cho
 * mọi import ngoài; drizzle dùng fake-drizzle chung của repo.
 *
 * ĐẶT Ở ĐÂY (không cạnh route.ts, dù mọi test route khác trong repo cạnh
 * route.ts của nó): thư mục route thật nằm dưới `templates/[id]/scan/` —
 * `node --test` của Node 22 tự diễn giải `[id]` trong ĐƯỜNG DẪN FILE đưa
 * vào CLI như một glob character class ("i" hoặc "d"), nên không bao giờ
 * khớp được path thật và lặng lẽ chạy 0 test — readFileSync() (dùng bên
 * dưới để nạp route.ts thật) không bị ảnh hưởng, chỉ cơ chế discover file
 * của test runner mới bị. Vì đây là test route ĐẦU TIÊN của repo nằm dưới
 * một thư mục route động ([id]/...), quirk này chưa từng lộ ra trước đây.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createFakeDb, drizzleStub, makeTable, type FakeDb } from "../test-support/fake-drizzle.ts";

const ROUTE_PATH = "src/app/api/document-merge/templates/[id]/scan/route.ts";
const routeSource = readFileSync(new URL(`../../../${ROUTE_PATH}`, import.meta.url), "utf8");
const jsSource = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

const schemaStub = {
  fieldDefinitions: makeTable("field_definitions"),
  formQuestions: makeTable("form_questions"),
  mergeTemplateFields: makeTable("merge_template_fields"),
  mergeTemplates: makeTable("merge_templates"),
};

const TEMPLATE = {
  id: "tpl-1",
  name: "MẪU ĐĂNG KÝ TẬP NGHỀ",
  googleDocId: "real-google-doc-id-1234567890",
};

type GoogleAuthMode = "local-ok" | "local-missing" | "local-forbidden";

type Options = {
  googleAuthMode?: GoogleAuthMode;
  /** What the worker's /read-google-doc returns when called. */
  workerResult?: { ok: boolean; status: number; data: Record<string, unknown> };
};

type Context = {
  POST: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<{ status: number; body: Record<string, unknown> }>;
  db: FakeDb;
  localGoogleCalls: string[];
  workerCalls: { path: string; body: unknown }[];
};

function makeContext(opts: Options = {}): Context {
  const db = createFakeDb({
    respond: (call) => {
      if (call.root === "select" && call.table === "merge_templates") return [TEMPLATE];
      if (call.root === "select" && call.table === "merge_template_fields") return [];
      if (call.root === "select" && call.table === "field_definitions") return [];
      if (call.root === "select" && call.table === "form_questions") return [];
      if (call.root === "insert" && call.table === "merge_template_fields") {
        return [{ id: "new-field-1", templateId: "tpl-1", placeholder: "Ho_ten" }];
      }
      return [];
    },
  });

  const localGoogleCalls: string[] = [];
  const workerCalls: Context["workerCalls"] = [];
  const authMode = opts.googleAuthMode ?? "local-ok";

  const moduleObj = { exports: {} as Record<string, unknown> };
  const context = vm.createContext({
    module: moduleObj,
    exports: moduleObj.exports,
    require: (id: string) => {
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
            requirePermission: async () => ({
              ok: true as const,
              session: { id: "admin-1", username: "admin", fullName: "Admin", role: "ADMIN", deptId: null },
            }),
            writeAudit: async () => {},
          };
        case "@/lib/document-merge/placeholder-extractor":
          return {
            extractUniquePlaceholders: (content: string) => {
              const matches = content.match(/<<\s*([^<>]+?)\s*>>/g) ?? [];
              return [...new Set(matches.map((m) => m.replace(/^<<\s*|\s*>>$/g, "")))];
            },
          };
        case "@/lib/document-merge/google-docs-service":
          return {
            createGoogleDocsService: () => ({
              getDocumentContent: async (docId: string) => {
                localGoogleCalls.push(docId);
                if (authMode === "local-ok") return "HỌ TÊN: <<Ho_ten>>";
                if (authMode === "local-forbidden") {
                  throw new Error("Google API 403: forbidden — service account not shared on this doc");
                }
                // local-missing — the exact failure mode Vercel hits today
                // when it has no local Google credential configured.
                throw new Error(
                  "Document Merge chưa kết nối Google Docs/Drive (missing Google OAuth credentials). Ưu tiên cấu hình GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + GOOGLE_REFRESH_TOKEN; Service Account chỉ là fallback.",
                );
              },
            }),
          };
        case "@/lib/document-merge/auto-mapping":
          return { autoMapAllPlaceholders: () => [] };
        case "@/lib/document-merge/template-routing":
          return { extractGoogleDocId: (input: string) => String(input ?? "").trim() || null };
        case "@/lib/verification/helpers":
          return {
            callWorker: async (path: string, body: unknown) => {
              workerCalls.push({ path, body });
              return opts.workerResult ?? { ok: false, status: 503, data: { error: "worker not configured in this test" } };
            },
          };
        default:
          throw new Error(`Unexpected require("${id}") — route không được phụ thuộc module này.`);
      }
    },
    process,
    Request,
    console,
    Date,
    JSON,
    Buffer,
    Math,
  });
  vm.runInContext(jsSource, context);
  return {
    POST: (moduleObj.exports as { POST: Context["POST"] }).POST,
    db,
    localGoogleCalls,
    workerCalls,
  };
}

function requestFor(body: Record<string, unknown> = {}): Request {
  return new Request("http://localhost/api/document-merge/templates/tpl-1/scan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function callPost(ctx: Context, body: Record<string, unknown> = {}) {
  return ctx.POST(requestFor(body), { params: Promise.resolve({ id: "tpl-1" }) });
}

test("local Google credential present → scan reads directly, worker is never called", async () => {
  const ctx = makeContext({ googleAuthMode: "local-ok" });
  const res = await callPost(ctx);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.placeholders, ["Ho_ten"]);
  assert.equal(ctx.localGoogleCalls.length, 1);
  assert.equal(ctx.workerCalls.length, 0, "must not call the worker when Vercel already has a working Google credential");
});

test("local Google credential missing → falls back to Cloud Run worker's /read-google-doc, scan succeeds", async () => {
  const ctx = makeContext({
    googleAuthMode: "local-missing",
    workerResult: { ok: true, status: 200, data: { content: "HỌ TÊN: <<Ho_ten>> - NGÀY: <<Ngay_sinh>>" } },
  });
  const res = await callPost(ctx);

  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.placeholders, ["Ho_ten", "Ngay_sinh"]);
  assert.equal(ctx.localGoogleCalls.length, 1, "must still try the local credential first");
  assert.equal(ctx.workerCalls.length, 1, "must fall back to the worker exactly once");
  assert.equal(ctx.workerCalls[0].path, "/read-google-doc");
  // JSON round-trip, not assert.deepEqual: the request body object is
  // constructed INSIDE the vm sandbox (a separate realm), so it is
  // structurally but never reference-equal to a host-realm object literal.
  assert.equal(JSON.stringify(ctx.workerCalls[0].body), JSON.stringify({ docId: "real-google-doc-id-1234567890" }));
});

test("a non-auth Google error (403 forbidden) never falls back to the worker — surfaces the real permission error", async () => {
  const ctx = makeContext({ googleAuthMode: "local-forbidden" });
  const res = await callPost(ctx);

  assert.equal(res.status, 500);
  assert.equal(res.body.code, "GOOGLE_TEMPLATE_FORBIDDEN");
  assert.equal(ctx.workerCalls.length, 0, "a permission error is not a missing-credential error — must not retry via worker");
});

test("local credential missing AND worker fallback also fails → surfaces the worker's own error (e.g. template not found)", async () => {
  const ctx = makeContext({
    googleAuthMode: "local-missing",
    workerResult: { ok: false, status: 502, data: { error: "Không đọc được Google Docs (404): not found" } },
  });
  const res = await callPost(ctx);

  assert.equal(res.status, 500);
  assert.equal(res.body.code, "GOOGLE_TEMPLATE_NOT_FOUND");
  assert.equal(ctx.workerCalls.length, 1);
});

test("worker fallback call carries only { docId } — never a Google credential/token value, matching callWorker()'s own no-secrets-in-body contract", async () => {
  const ctx = makeContext({
    googleAuthMode: "local-missing",
    workerResult: { ok: true, status: 200, data: { content: "<<Ho_ten>>" } },
  });
  await callPost(ctx);
  assert.equal(ctx.workerCalls.length, 1);
  assert.equal(Object.keys(ctx.workerCalls[0].body as object).length, 1, "request body must carry only docId");
});
