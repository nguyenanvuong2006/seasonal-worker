/**
 * TEMPLATE VERSION DRAFT EDIT — regression tests cho "Sửa HTML/CSS".
 *
 * Service: updateTemplateVersionDraft() (src/lib/document-merge/template-versions.ts)
 * Route:   PATCH /api/document-merge/templates/[id]/versions/[versionId]
 *
 * Chạy trên ĐÚNG mã nguồn production (transpile + vm sandbox, cùng khuôn mẫu
 * template-versions.test.ts / draft-preview-route.test.ts). Fake drizzle ghi
 * lại TOÀN BỘ lệnh — "không publish / không đụng mapping_snapshot" là assertion
 * về các câu lệnh thật sự phát ra.
 *
 * Bất biến: chỉ DRAFT được UPDATE. PUBLISHED/ARCHIVED là immutable — server
 * từ chối bằng 409, kể cả khi UI đã mở editor từ trước (guard nằm trong
 * WHERE của câu UPDATE, không chỉ ẩn nút ở frontend).
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
  argOf,
  type FakeDb,
  type QueryCall,
} from "../test-support/fake-drizzle.ts";
import { loadModule, serverOnlyStub } from "../test-support/load-module.ts";

/* ==================================================================== *
 * PART 1 — SERVICE: updateTemplateVersionDraft
 * ==================================================================== */

const schemaStub = {
  mergeTemplates: makeTable("merge_templates"),
  mergeTemplateFields: makeTable("merge_template_fields"),
  mergeTemplateVersions: makeTable("merge_template_versions"),
};

function makeVersion(
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED",
  overrides: Record<string, unknown> = {},
) {
  return {
    id: "ver-9",
    templateId: "tpl-1",
    version: 9,
    status,
    htmlBody: "<div class=\"page\"><p>Họ tên: <<Ho_ten>></p></div>",
    printCss: ".page { width: 210mm; }",
    sourceDocxName: "dang-ky-tap-nghe.docx",
    retentionYears: 3,
    mappingSnapshot: [],
    createdBy: "admin-a",
    publishedAt: status === "PUBLISHED" ? new Date("2026-08-20T00:00:00Z") : null,
    archivedAt: status === "ARCHIVED" ? new Date("2026-08-21T00:00:00Z") : null,
    supersededBy: null,
    createdAt: new Date("2026-08-01T00:00:00Z"),
    updatedAt: new Date("2026-08-20T00:00:00Z"),
    ...overrides,
  };
}

type EditModule = {
  updateTemplateVersionDraft: (
    templateId: string,
    versionId: string,
    input: { htmlBody: string; printCss?: string | null },
  ) => Promise<Record<string, unknown>>;
};

async function loadService(db: FakeDb): Promise<EditModule> {
  const mod = await loadModule(new URL("./template-versions.ts", import.meta.url), {
    stubs: {
      "server-only": serverOnlyStub,
      "drizzle-orm": drizzleStub,
      "@/db": { db },
      "@/db/schema": schemaStub,
      "./placeholder-extractor.ts": {
        extractUniquePlaceholders: (content: string) => {
          const unique = new Set<string>();
          for (const m of content.matchAll(/<<([^>]+)>>/g)) unique.add(m[1].trim());
          return Array.from(unique).sort();
        },
      },
    },
  });
  return mod as unknown as EditModule;
}

/**
 * Fake DB cho edit. Giả lập AND thật của (id, templateId) khi select nguồn;
 * update chỉ "trả row" khi version vẫn DRAFT — đúng semantics WHERE của
 * service (nếu row đã rời DRAFT, returning = []).
 */
function makeEditDb(opts: {
  target?: Record<string, unknown>[];
  /** Ép update trả [] (giả lập race: row rời DRAFT giữa SELECT và UPDATE). */
  updateReturnsEmpty?: boolean;
} = {}) {
  const target = opts.target ?? [makeVersion("DRAFT")];
  return createFakeDb({
    respond: (call) => {
      if (call.root === "select" && call.table === "merge_template_versions") {
        const wantedId = eqValue(call, "merge_template_versions.id");
        const wantedTemplate = eqValue(call, "merge_template_versions.templateId");
        if (wantedId !== undefined) {
          return target.filter(
            (row) =>
              (row as { id: string }).id === wantedId &&
              (wantedTemplate === undefined ||
                (row as { templateId: string }).templateId === wantedTemplate),
          );
        }
        return target;
      }
      if (call.root === "update" && call.table === "merge_template_versions") {
        if (opts.updateReturnsEmpty) return [];
        const set = argOf(call, "set") as Record<string, unknown>;
        const base = (target[0] ?? {}) as Record<string, unknown>;
        return [
          {
            ...base,
            htmlBody: set.htmlBody,
            printCss: set.printCss,
            updatedAt: set.updatedAt,
          },
        ];
      }
      return undefined;
    },
  });
}

test("edit: DRAFT được sửa — UPDATE htmlBody/printCss/updatedAt với WHERE id+templateId+status DRAFT", async () => {
  const db = makeEditDb();
  const mod = await loadService(db);

  const updated = await mod.updateTemplateVersionDraft("tpl-1", "ver-9", {
    htmlBody: "<div class=\"page\"><p>SỬA: <<Ho_ten>></p></div>",
    printCss: ".page { width: 210mm; margin: 0 auto; }",
  });

  assert.equal(updated.htmlBody, "<div class=\"page\"><p>SỬA: <<Ho_ten>></p></div>");
  assert.equal(db.writesTo("merge_template_versions").length, 1);

  const update = db.writesTo("merge_template_versions")[0];
  const set = argOf(update, "set") as Record<string, unknown>;
  assert.equal(set.htmlBody, "<div class=\"page\"><p>SỬA: <<Ho_ten>></p></div>");
  assert.equal(set.printCss, ".page { width: 210mm; margin: 0 auto; }");
  assert.ok(set.updatedAt instanceof Date);

  // Guard nằm NGAY trong WHERE của câu UPDATE — không chỉ check trước đó.
  assert.equal(eqValue(update, "merge_template_versions.id"), "ver-9");
  assert.equal(eqValue(update, "merge_template_versions.templateId"), "tpl-1");
  assert.equal(eqValue(update, "merge_template_versions.status"), "DRAFT");
});

test("edit: KHÔNG đổi version number, KHÔNG đổi templateId, KHÔNG publish, KHÔNG đụng mapping_snapshot", async () => {
  const db = makeEditDb();
  const mod = await loadService(db);

  await mod.updateTemplateVersionDraft("tpl-1", "ver-9", {
    htmlBody: "<p>new</p>",
    printCss: null,
  });

  const update = db.writesTo("merge_template_versions")[0];
  const set = argOf(update, "set") as Record<string, unknown>;
  // Chỉ được phép set đúng 3 khoá nội dung — không identity/lifecycle/mapping.
  assert.deepEqual(Object.keys(set).sort(), ["htmlBody", "printCss", "updatedAt"]);
  assert.equal(set.status, undefined);
  assert.equal(set.version, undefined);
  assert.equal(set.templateId, undefined);
  assert.equal(set.mappingSnapshot, undefined);
  assert.equal(set.publishedAt, undefined);
  assert.equal(set.archivedAt, undefined);

  // Không bảng nào khác bị ghi — publish là UPDATE status, ở đây phải bằng 0.
  assert.equal(db.writesTo("merge_templates").length, 0, "current_published_version bất động");
  assert.equal(db.writesTo("merge_template_fields").length, 0, "không đụng field mappings");
  assert.equal(db.writesTo("merge_jobs").length, 0);
  assert.equal(db.writesTo("document_history").length, 0);
});

test("edit: PUBLISHED bị từ chối 409 — KHÔNG có lệnh ghi nào", async () => {
  const db = makeEditDb({ target: [makeVersion("PUBLISHED", { mappingSnapshot: [{ placeholder: "Ho_ten" }] })] });
  const mod = await loadService(db);

  await assert.rejects(
    mod.updateTemplateVersionDraft("tpl-1", "ver-9", { htmlBody: "<p>x</p>" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { status?: number }).status, 409);
      assert.match(error.message, /PUBLISHED/);
      return true;
    },
  );
  assert.equal(db.writes.length, 0, "PUBLISHED immutable — không một lệnh ghi nào");
});

test("edit: ARCHIVED bị từ chối 409 — KHÔNG có lệnh ghi nào", async () => {
  const db = makeEditDb({ target: [makeVersion("ARCHIVED")] });
  const mod = await loadService(db);

  await assert.rejects(
    mod.updateTemplateVersionDraft("tpl-1", "ver-9", { htmlBody: "<p>x</p>" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { status?: number }).status, 409);
      assert.match(error.message, /ARCHIVED/);
      return true;
    },
  );
  assert.equal(db.writes.length, 0);
});

test("edit: versionId thuộc template khác → 404, không ghi", async () => {
  const db = makeEditDb();
  const mod = await loadService(db);

  await assert.rejects(
    mod.updateTemplateVersionDraft("tpl-KHAC", "ver-9", { htmlBody: "<p>x</p>" }),
    (error: unknown) => (error as { status?: number }).status === 404,
  );
  assert.equal(db.writes.length, 0);

  // Select nguồn phải cross-check CẢ id LẪN templateId (URL identity).
  const sourceSelect = db.calls.find(
    (c) => c.root === "select" && c.table === "merge_template_versions" && c.ops.some((o) => o.fn === "limit"),
  ) as QueryCall;
  assert.equal(eqValue(sourceSelect, "merge_template_versions.id"), "ver-9");
  assert.equal(eqValue(sourceSelect, "merge_template_versions.templateId"), "tpl-KHAC");
});

test("edit (race): version rời DRAFT giữa SELECT và UPDATE → UPDATE trả rỗng → 409, không ghi đè", async () => {
  // SELECT thấy DRAFT (editor đã mở từ trước), nhưng tới lúc UPDATE thì row
  // đã PUBLISHED — điều kiện status='DRAFT' trong WHERE khiến 0 row khớp.
  const db = makeEditDb({ updateReturnsEmpty: true });
  const mod = await loadService(db);

  await assert.rejects(
    mod.updateTemplateVersionDraft("tpl-1", "ver-9", { htmlBody: "<p>x</p>" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { status?: number }).status, 409);
      assert.match(error.message, /không còn là DRAFT/);
      return true;
    },
  );
  // Câu UPDATE vẫn được phát ra nhưng với guard status='DRAFT' trong WHERE —
  // 0 row thực tế bị thay đổi (fake trả []).
  const update = db.writesTo("merge_template_versions")[0];
  assert.ok(update, "UPDATE được phát ra với guard trong WHERE");
  assert.equal(eqValue(update, "merge_template_versions.status"), "DRAFT");
});

test("edit (lặp NHIỀU LẦN): Save liên tục trên cùng versionId — mỗi lần chỉ UPDATE, KHÔNG INSERT (không tạo version mới), version/mapping/status/current_published giữ nguyên", async () => {
  const db = makeEditDb();
  const mod = await loadService(db);

  // Operator lưu 3 lần liên tiếp (sửa → Lưu → sửa tiếp → Lưu...) trên CÙNG
  // versionId — đúng vòng lặp "Lưu bản nháp" giữ modal mở.
  const first = await mod.updateTemplateVersionDraft("tpl-1", "ver-9", {
    htmlBody: "<div class=\"page\"><p>lần 1</p></div>",
    printCss: ".p1{}",
  });
  const second = await mod.updateTemplateVersionDraft("tpl-1", "ver-9", {
    htmlBody: "<div class=\"page\"><p>lần 2 — sửa tiếp</p></div>",
    printCss: ".p2{}",
  });
  const third = await mod.updateTemplateVersionDraft("tpl-1", "ver-9", {
    htmlBody: "<div class=\"page\"><p>lần 3 — chốt</p></div>",
    printCss: null,
  });

  // Version number KHÔNG đổi qua các lần lưu (không có "version mới" nào sinh ra).
  assert.equal(first.version, 9);
  assert.equal(second.version, 9);
  assert.equal(third.version, 9);
  assert.equal(first.status, "DRAFT");
  assert.equal(second.status, "DRAFT");
  assert.equal(third.status, "DRAFT");
  assert.equal(first.templateId, "tpl-1");
  assert.equal(third.htmlBody, "<div class=\"page\"><p>lần 3 — chốt</p></div>");
  assert.equal(third.printCss, null);
  assert.deepEqual(third.mappingSnapshot, []);

  // Không MỘT lệnh INSERT nào trong cả phiên — Save không bao giờ tạo version mới.
  assert.equal(db.calls.filter((c) => c.root === "insert").length, 0);
  assert.equal(db.calls.filter((c) => c.root === "delete").length, 0);

  // Đúng 3 lệnh UPDATE merge_template_versions, mỗi câu đều guard
  // id+templateId+status='DRAFT' và chỉ set nội dung.
  const updates = db.writesTo("merge_template_versions");
  assert.equal(updates.length, 3);
  for (const update of updates) {
    assert.equal(eqValue(update, "merge_template_versions.id"), "ver-9");
    assert.equal(eqValue(update, "merge_template_versions.templateId"), "tpl-1");
    assert.equal(eqValue(update, "merge_template_versions.status"), "DRAFT");
    const set = argOf(update, "set") as Record<string, unknown>;
    assert.deepEqual(Object.keys(set).sort(), ["htmlBody", "printCss", "updatedAt"]);
    assert.equal(set.status, undefined);
    assert.equal(set.version, undefined);
    assert.equal(set.mappingSnapshot, undefined);
    assert.equal(set.publishedAt, undefined);
    assert.equal(set.archivedAt, undefined);
  }

  // current_published_version (merge_templates) + mapping dùng chung bất động.
  assert.equal(db.writesTo("merge_templates").length, 0, "current_published_version bất động qua nhiều lần lưu");
  assert.equal(db.writesTo("merge_template_fields").length, 0);
  assert.equal(db.writesTo("document_history").length, 0);
});

/* ==================================================================== *
 * PART 2 — ROUTE: PATCH /versions/[versionId]
 * ==================================================================== */

const EDIT_ROUTE_PATH = "src/app/api/document-merge/templates/[id]/versions/[versionId]/route.ts";
const editRouteSource = readFileSync(new URL(`../../../${EDIT_ROUTE_PATH}`, import.meta.url), "utf8");
const editRouteCode = editRouteSource
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");
const editRouteJs = ts.transpileModule(editRouteSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

type EditRouteContext = {
  PATCH: (
    req: Request,
    ctx: { params: Promise<{ id: string; versionId: string }> },
  ) => Promise<{ status: number; body: Record<string, unknown> }>;
  editCalls: { templateId: string; versionId: string; input: Record<string, unknown> }[];
  auditCalls: { action: string; details: Record<string, unknown> }[];
  requiredIds: string[];
};

function makeEditRouteContext(opts: {
  role?: string;
  permissionDenied?: boolean;
  editResult?: Record<string, unknown>;
  editError?: { status: number; message: string };
} = {}): EditRouteContext {
  const role = opts.role ?? "ADMIN";
  const editCalls: EditRouteContext["editCalls"] = [];
  const auditCalls: EditRouteContext["auditCalls"] = [];
  const requiredIds: string[] = [];

  class FakeTemplateVersionError extends Error {
    public status: number;
    constructor(message: string, status = 400) {
      super(message);
      this.status = status;
    }
  }

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
        case "@/lib/auth":
          return {
            requirePermission: async (roles: string[]) => {
              if (opts.permissionDenied) {
                return { ok: false as const, status: 403, error: "Tài khoản của bạn không có quyền thực hiện thao tác này." };
              }
              if (!roles.includes(role)) {
                return { ok: false as const, status: 403, error: "Từ chối truy cập! Quyền hạn không hợp lệ." };
              }
              return { ok: true as const, session: { id: "u-1", username: role, fullName: role, role, deptId: null } };
            },
            writeAudit: async (
              _session: unknown,
              action: string,
              _targetType: string,
              details: Record<string, unknown>,
            ) => {
              auditCalls.push({ action, details });
            },
          };
        case "@/lib/document-merge/template-versions":
          return {
            TemplateVersionError: FakeTemplateVersionError,
            updateTemplateVersionDraft: async (
              templateId: string,
              versionId: string,
              input: Record<string, unknown>,
            ) => {
              if (opts.editError) {
                throw new FakeTemplateVersionError(opts.editError.message, opts.editError.status);
              }
              editCalls.push({ templateId, versionId, input });
              return (
                opts.editResult ?? {
                  id: versionId,
                  templateId,
                  version: 9,
                  status: "DRAFT",
                  htmlBody: input.htmlBody,
                  printCss: input.printCss ?? null,
                  mappingSnapshot: [],
                }
              );
            },
          };
        default:
          throw new Error(`Unexpected require("${id}") — edit route must not depend on this module.`);
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
    Error,
    TypeError,
    Promise,
  });
  vm.runInContext(editRouteJs, context);
  return {
    PATCH: (moduleObj.exports as { PATCH: EditRouteContext["PATCH"] }).PATCH,
    editCalls,
    auditCalls,
    requiredIds,
  };
}

const editParams = (id = "tpl-1", versionId = "ver-9") => ({ params: Promise.resolve({ id, versionId }) });
const editRequest = (payload: unknown, method = "PATCH") =>
  new Request(`http://localhost/api/document-merge/templates/tpl-1/versions/ver-9`, {
    method,
    headers: { "content-type": "application/json" },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });

test("edit route: DRAFT hợp lệ → 200, cập nhật html/css, audit UPDATE_TEMPLATE_VERSION_DRAFT", async () => {
  const ctx = makeEditRouteContext();
  const res = await ctx.PATCH(
    editRequest({ htmlBody: "<div class=\"page\"><p>v9 mới</p></div>", printCss: ".page{}" }),
    editParams(),
  );

  assert.equal(res.status, 200);
  assert.equal(res.body.status, "DRAFT");
  assert.equal(ctx.editCalls.length, 1);
  assert.equal(ctx.editCalls[0].templateId, "tpl-1");
  assert.equal(ctx.editCalls[0].versionId, "ver-9");
  assert.equal(ctx.editCalls[0].input.htmlBody, "<div class=\"page\"><p>v9 mới</p></div>");
  assert.equal(ctx.auditCalls[0]?.action, "UPDATE_TEMPLATE_VERSION_DRAFT");
});

test("edit route: PUBLISHED → 409 từ service (server-side, không phải chỉ UI)", async () => {
  const ctx = makeEditRouteContext({
    editError: { status: 409, message: "Chỉ version DRAFT mới được sửa HTML/CSS. Version v9 hiện đang PUBLISHED và là bất biến." },
  });
  const res = await ctx.PATCH(editRequest({ htmlBody: "<p>x</p>" }), editParams());
  assert.equal(res.status, 409);
  assert.match(String(res.body.error), /PUBLISHED/);
});

test("edit route: ARCHIVED → 409 từ service", async () => {
  const ctx = makeEditRouteContext({
    editError: { status: 409, message: "Chỉ version DRAFT mới được sửa HTML/CSS. Version v9 hiện đang ARCHIVED và là bất biến." },
  });
  const res = await ctx.PATCH(editRequest({ htmlBody: "<p>x</p>" }), editParams());
  assert.equal(res.status, 409);
  assert.match(String(res.body.error), /ARCHIVED/);
});

test("edit route: race — service trả 409 'không còn DRAFT' được truyền nguyên vẹn", async () => {
  const ctx = makeEditRouteContext({
    editError: { status: 409, message: "Version đã không còn là DRAFT (có thể vừa được publish/archive) — không thể lưu." },
  });
  const res = await ctx.PATCH(editRequest({ htmlBody: "<p>x</p>" }), editParams());
  assert.equal(res.status, 409);
});

test("edit route: unauthorized role → 403 TRƯỚC khi gọi service", async () => {
  const ctx = makeEditRouteContext({ role: "WORKER" });
  const res = await ctx.PATCH(editRequest({ htmlBody: "<p>x</p>" }), editParams());
  assert.equal(res.status, 403);
  assert.equal(ctx.editCalls.length, 0);
  assert.equal(ctx.auditCalls.length, 0);
});

test("edit route: permission bị tắt → 403 (dynamic RBAC fail-closed)", async () => {
  const ctx = makeEditRouteContext({ permissionDenied: true });
  const res = await ctx.PATCH(editRequest({ htmlBody: "<p>x</p>" }), editParams());
  assert.equal(res.status, 403);
  assert.equal(ctx.editCalls.length, 0);
});

test("edit route: validation — thiếu htmlBody / body rỗng / printCss sai kiểu → 400, không gọi service", async () => {
  const ctx = makeEditRouteContext();

  const missingHtml = await ctx.PATCH(editRequest({ printCss: ".x{}" }), editParams());
  assert.equal(missingHtml.status, 400);

  const emptyHtml = await ctx.PATCH(editRequest({ htmlBody: "   " }), editParams());
  assert.equal(emptyHtml.status, 400);

  const notJson = await ctx.PATCH(editRequest("{not-json", "PATCH"), editParams());
  assert.equal(notJson.status, 400);

  const badCss = await ctx.PATCH(editRequest({ htmlBody: "<p>x</p>", printCss: 123 }), editParams());
  assert.equal(badCss.status, 400);

  assert.equal(ctx.editCalls.length, 0, "service không được gọi khi validation fail");
});

test("edit route: KHÔNG import publish service — không thể publish qua PATCH", async () => {
  const ctx = makeEditRouteContext();
  await ctx.PATCH(editRequest({ htmlBody: "<p>x</p>" }), editParams());
  assert.deepEqual(
    ctx.requiredIds.filter((id) => /publish|rollback|archive|worker|queue|history/i.test(id)),
    [],
  );
  assert.doesNotMatch(editRouteCode, /publishTemplateVersion|rollbackTemplateVersion|archiveTemplateVersion|cloneTemplateVersion/);
});
