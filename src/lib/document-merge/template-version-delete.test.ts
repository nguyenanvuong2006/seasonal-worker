/**
 * TEMPLATE DRAFT VERSION DELETE — regression tests cho "Xóa bản nháp".
 *
 * Service: deleteTemplateDraftVersion() (src/lib/document-merge/template-versions.ts)
 * Route:   DELETE /api/document-merge/templates/[id]/versions/[versionId]
 *
 * Chạy trên ĐÚNG mã nguồn production (transpile + vm sandbox, cùng khuôn mẫu
 * template-version-edit.test.ts). Fake drizzle ghi lại TOÀN BỘ lệnh — "không
 * đụng mapping / không đổi current_published_version" là assertion về các câu
 * lệnh thật sự phát ra, không phải giả định.
 *
 * Bất biến kiểm chứng:
 *   - CHỈ DRAFT bị DELETE. PUBLISHED/ARCHIVED → 409 (kể cả gọi API trực tiếp);
 *   - Version được RE-READ trong transaction ngay trước DELETE + điều kiện
 *     status='DRAFT' nằm ngay trong WHERE của câu DELETE → race DRAFT→PUBLISHED
 *     fail closed;
 *   - document_history reference → chặn 409 (bản ghi tuân thủ phải bảo toàn);
 *   - KHÔNG ghi merge_templates (current_published_version bất động — v8 /
 *     current published unchanged);
 *   - KHÔNG ghi merge_template_fields (mapping template-global dùng chung);
 *   - KHÔNG UPDATE/DELETE merge_template_versions nào khác (snapshot của
 *     version khác nguyên vẹn);
 *   - KHÔNG publish/archive version khác, KHÔNG tạo job/history;
 *   - Audit DELETE_TEMPLATE_DRAFT_VERSION chỉ chứa identity — không HTML/CSS,
 *     không PII ứng viên;
 *   - 2 DRAFT → xoá 1 → còn đúng 1 DRAFT (in-memory model trung thực).
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
} from "../test-support/fake-drizzle.ts";
import { loadModule, serverOnlyStub } from "../test-support/load-module.ts";

/* ==================================================================== *
 * PART 1 — SERVICE: deleteTemplateDraftVersion
 * ==================================================================== */

const schemaStub = {
  documentHistory: makeTable("document_history"),
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
    mappingSnapshot: status === "PUBLISHED" ? [{ placeholder: "Ho_ten" }] : [],
    createdBy: "admin-a",
    publishedAt: status === "PUBLISHED" ? new Date("2026-08-20T00:00:00Z") : null,
    archivedAt: status === "ARCHIVED" ? new Date("2026-08-21T00:00:00Z") : null,
    supersededBy: null,
    createdAt: new Date("2026-08-01T00:00:00Z"),
    updatedAt: new Date("2026-08-20T00:00:00Z"),
    ...overrides,
  };
}

type DeleteModule = {
  deleteTemplateDraftVersion: (
    templateId: string,
    versionId: string,
  ) => Promise<{ id: string; templateId: string; version: number }>;
};

// `deleteTemplateDraftVersion` chạy trong vm sandbox (loadModule) nên object
// nó trả về thuộc realm khác — deepEqual strict-mode so instance/prototype
// nên fail dù cùng cấu trúc. JSON round-trip để so sánh thuần dữ liệu.
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

async function loadService(db: FakeDb): Promise<DeleteModule> {
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
      "./html-renderer.ts": {
        DEFAULT_PAGE_MARGINS: { topMm: 10, bottomMm: 10, leftMm: 12, rightMm: 12 },
      },
    },
  });
  return mod as unknown as DeleteModule;
}

/**
 * Fake DB cho delete. Giả lập AND thật của (id, templateId) khi select;
 * delete chỉ "trả row" khi version vẫn DRAFT — đúng semantics WHERE của
 * service (nếu row đã rồi DRAFT, returning = [] → fail closed).
 */
function makeDeleteDb(opts: {
  target?: Record<string, unknown>[];
  /** Ép delete trả [] (giả lập race: row rồi DRAFT giữa SELECT và DELETE). */
  deleteReturnsEmpty?: boolean;
  /** Có document_history trỏ tới (templateId, version) hay không. */
  historyRows?: Record<string, unknown>[];
} = {}) {
  const target = opts.target ?? [makeVersion("DRAFT")];
  const historyRows = opts.historyRows ?? [];
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
      if (call.root === "select" && call.table === "document_history") {
        const wantedTemplate = eqValue(call, "document_history.templateId");
        const wantedVersion = eqValue(call, "document_history.templateVersion");
        return historyRows.filter(
          (row) =>
            (wantedTemplate === undefined ||
              (row as { templateId: string }).templateId === wantedTemplate) &&
            (wantedVersion === undefined ||
              (row as { templateVersion: number }).templateVersion === wantedVersion),
        );
      }
      if (call.root === "delete" && call.table === "merge_template_versions") {
        if (opts.deleteReturnsEmpty) return [];
        // returning({ id, version }) của row vừa xoá.
        return [{ id: "ver-9", version: 9 }];
      }
      return undefined;
    },
  });
}

test("delete: DRAFT được xoá — DELETE trong transaction với WHERE id+templateId+status DRAFT, trả về identity", async () => {
  const db = makeDeleteDb();
  const mod = await loadService(db);

  const deleted = await mod.deleteTemplateDraftVersion("tpl-1", "ver-9");
  assert.deepEqual(plain(deleted), { id: "ver-9", templateId: "tpl-1", version: 9 });
  assert.equal(db.transactions, 1, "delete phải chạy trong transaction");

  const deletes = db.writesTo("merge_template_versions");
  assert.equal(deletes.length, 1, "đúng 1 lệnh ghi vào merge_template_versions");
  assert.equal(deletes[0].root, "delete", "lệnh ghi duy nhất phải là DELETE");
  // Guard nằm NGAY trong WHERE của câu DELETE — không chỉ check trước đó.
  assert.equal(eqValue(deletes[0], "merge_template_versions.id"), "ver-9");
  assert.equal(eqValue(deletes[0], "merge_template_versions.templateId"), "tpl-1");
  assert.equal(eqValue(deletes[0], "merge_template_versions.status"), "DRAFT");
});

test("delete: PUBLISHED bị chặn 409 — KHÔNG có lệnh ghi nào (kể cả gọi thẳng service)", async () => {
  const db = makeDeleteDb({ target: [makeVersion("PUBLISHED")] });
  const mod = await loadService(db);

  await assert.rejects(
    mod.deleteTemplateDraftVersion("tpl-1", "ver-9"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { status?: number }).status, 409);
      assert.match(error.message, /DRAFT/);
      assert.match(error.message, /PUBLISHED/);
      return true;
    },
  );
  assert.equal(db.writes.length, 0, "PUBLISHED immutable — không một lệnh ghi nào");
});

test("delete: ARCHIVED bị chặn 409 — KHÔNG có lệnh ghi nào", async () => {
  const db = makeDeleteDb({ target: [makeVersion("ARCHIVED")] });
  const mod = await loadService(db);

  await assert.rejects(
    mod.deleteTemplateDraftVersion("tpl-1", "ver-9"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { status?: number }).status, 409);
      assert.match(error.message, /DRAFT/);
      assert.match(error.message, /ARCHIVED/);
      return true;
    },
  );
  assert.equal(db.writes.length, 0);
});

test("delete: versionId thuộc template khác → 404, không ghi (select cross-check CẢ id LẪN templateId)", async () => {
  const db = makeDeleteDb();
  const mod = await loadService(db);

  await assert.rejects(
    mod.deleteTemplateDraftVersion("tpl-KHAC", "ver-9"),
    (error: unknown) => (error as { status?: number }).status === 404,
  );
  assert.equal(db.writes.length, 0);

  const sourceSelect = db.calls.find(
    (c) => c.root === "select" && c.table === "merge_template_versions" && c.ops.some((o) => o.fn === "limit"),
  );
  assert.ok(sourceSelect, "phải re-read version trước khi xoá");
  assert.equal(eqValue(sourceSelect, "merge_template_versions.id"), "ver-9");
  assert.equal(eqValue(sourceSelect, "merge_template_versions.templateId"), "tpl-KHAC");
});

test("delete (race): DRAFT→PUBLISHED giữa SELECT và DELETE → DELETE khớp 0 row → 409 fail closed", async () => {
  const db = makeDeleteDb({ deleteReturnsEmpty: true });
  const mod = await loadService(db);

  await assert.rejects(
    mod.deleteTemplateDraftVersion("tpl-1", "ver-9"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { status?: number }).status, 409);
      assert.match(error.message, /không còn là DRAFT/);
      return true;
    },
  );
  // Câu DELETE vẫn được phát ra với guard status='DRAFT' trong WHERE —
  // 0 row thực tế bị xoá (fake trả []), không ghi đè version đã publish.
  const deletes = db.writesTo("merge_template_versions");
  assert.equal(deletes.length, 1, "DELETE được phát ra với guard trong WHERE");
  assert.equal(deletes[0].root, "delete");
  assert.equal(eqValue(deletes[0], "merge_template_versions.status"), "DRAFT");
});

test("delete: version đã có trong document_history → 409 operator-friendly, không xoá", async () => {
  const db = makeDeleteDb({
    historyRows: [{ id: "dh-1", templateId: "tpl-1", templateVersion: 9 }],
  });
  const mod = await loadService(db);

  await assert.rejects(
    mod.deleteTemplateDraftVersion("tpl-1", "ver-9"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { status?: number }).status, 409);
      assert.match(error.message, /document_history/);
      assert.match(error.message, /truy vết/);
      return true;
    },
  );
  assert.equal(db.writes.length, 0, "bản ghi tuân thủ được bảo toàn — không cascade mù quáng");
});

test("delete: BẤT BIẾN — v8/current published unchanged, mappings unchanged, snapshot version khác unchanged, không tạo job/history", async () => {
  // Trạng thái production-like: v8 PUBLISHED + v9 DRAFT (sai) + v10 DRAFT.
  const v8 = makeVersion("PUBLISHED", { id: "ver-8", version: 8 });
  const v9 = makeVersion("DRAFT", { id: "ver-9", version: 9 });
  const v10 = makeVersion("DRAFT", { id: "ver-10", version: 10 });
  const db = makeDeleteDb({ target: [v8, v9, v10] });
  const mod = await loadService(db);

  await mod.deleteTemplateDraftVersion("tpl-1", "ver-9");

  // Chỉ ĐÚNG 1 lệnh ghi toàn cục: DELETE scope theo id của v9.
  assert.equal(db.writes.length, 1, "toàn bộ thao tác chỉ được phát ra 1 lệnh ghi");
  const onlyWrite = db.writes[0];
  assert.equal(onlyWrite.table, "merge_template_versions");
  assert.equal(onlyWrite.root, "delete");
  assert.equal(eqValue(onlyWrite, "merge_template_versions.id"), "ver-9");

  // merge_templates KHÔNG bị ghi → current_published_version (trỏ v8) bất động.
  assert.equal(db.writesTo("merge_templates").length, 0, "current_published_version bất động");
  // merge_template_fields KHÔNG bị ghi → mapping template-global dùng chung nguyên vẹn.
  assert.equal(db.writesTo("merge_template_fields").length, 0, "không đụng mapping dùng chung");
  // Không UPDATE merge_template_versions nào → mapping_snapshot của v8/v10 và
  // status của version khác không thể bị mutate (DELETE chỉ khớp id='ver-9').
  assert.equal(
    db.writesTo("merge_template_versions").filter((c) => c.root !== "delete").length,
    0,
    "không UPDATE version nào khác",
  );
  // Không publish/archive (đó là UPDATE status) và không tạo job/history.
  assert.equal(db.writesTo("merge_jobs").length, 0);
  assert.equal(db.writesTo("merge_job_records").length, 0);
  assert.equal(db.writesTo("document_history").length, 0);
});

/**
 * Mô hình in-memory TRUNG THỰC của các câu lệnh SQL mà service phát ra:
 * store rows → select/delete hành xử đúng theo điều kiện WHERE. Cho phép
 * khẳng định hành vi cuối cùng trên STATE thay vì chỉ soi lệnh — kịch bản
 * production: 2 DRAFT → xoá 1 → còn đúng 1 DRAFT.
 */
function makeStatefulDb(initialRows: Record<string, unknown>[]) {
  const rows = [...initialRows];
  const db = createFakeDb({
    respond: (call) => {
      if (call.root === "select" && call.table === "merge_template_versions") {
        const wantedId = eqValue(call, "merge_template_versions.id");
        const wantedTemplate = eqValue(call, "merge_template_versions.templateId");
        const wantedStatus = eqValue(call, "merge_template_versions.status");
        return rows.filter(
          (row) =>
            (wantedId === undefined || (row as { id: string }).id === wantedId) &&
            (wantedTemplate === undefined ||
              (row as { templateId: string }).templateId === wantedTemplate) &&
            (wantedStatus === undefined || (row as { status: string }).status === wantedStatus),
        );
      }
      if (call.root === "select" && call.table === "document_history") {
        return [];
      }
      if (call.root === "delete" && call.table === "merge_template_versions") {
        const wantedId = eqValue(call, "merge_template_versions.id");
        const wantedTemplate = eqValue(call, "merge_template_versions.templateId");
        const wantedStatus = eqValue(call, "merge_template_versions.status");
        const removed: Record<string, unknown>[] = [];
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          const row = rows[i] as { id: string; templateId: string; status: string; version: number };
          if (
            (wantedId === undefined || row.id === wantedId) &&
            (wantedTemplate === undefined || row.templateId === wantedTemplate) &&
            (wantedStatus === undefined || row.status === wantedStatus)
          ) {
            removed.push(row);
            rows.splice(i, 1);
          }
        }
        // returning({ id, version })
        return removed.map((r) => ({ id: (r as { id: string }).id, version: (r as { version: number }).version }));
      }
      return undefined;
    },
  });
  return { db, rows };
}

test("delete: 2 DRAFT → xoá 1 → còn đúng 1 DRAFT làm việc (v8 PUBLISHED nguyên vẹn); xoá lần 2 → 404", async () => {
  // Trạng thái production mô phỏng: v8 PUBLISHED, v9 DRAFT sai, v10 DRAFT đang hiệu chỉnh.
  const v8 = makeVersion("PUBLISHED", { id: "ver-8", version: 8 });
  const v9 = makeVersion("DRAFT", { id: "ver-9", version: 9 });
  const v10 = makeVersion("DRAFT", { id: "ver-10", version: 10 });
  const { db, rows } = makeStatefulDb([v8, v9, v10]);
  const mod = await loadService(db);

  // Trước xoá: 2 DRAFT — guard SINGLE_ACTIVE_DRAFT (đếm status='DRAFT') đang block.
  const draftsBefore = rows.filter((r) => (r as { status: string }).status === "DRAFT");
  assert.equal(draftsBefore.length, 2);

  await mod.deleteTemplateDraftVersion("tpl-1", "ver-9");

  // Sau xoá: v9 biến mất HOÀN TOÀN khỏi state; v8 + v10 nguyên vẹn.
  assert.equal(rows.length, 2);
  const draftsAfter = rows.filter((r) => (r as { status: string }).status === "DRAFT");
  assert.equal(draftsAfter.length, 1, "còn đúng 1 DRAFT — single-active-draft guard hết block tự nhiên");
  assert.equal((draftsAfter[0] as { id: string }).id, "ver-10");
  const published = rows.filter((r) => (r as { status: string }).status === "PUBLISHED");
  assert.equal(published.length, 1);
  assert.equal((published[0] as { version: number }).version, 8, "v8/current published unchanged");
  assert.deepEqual(
    (published[0] as { mappingSnapshot: unknown[] }).mappingSnapshot,
    [{ placeholder: "Ho_ten" }],
    "mapping_snapshot của v8 nguyên vẹn",
  );

  // Xoá lại v9 → 404 (idempotent-safe: không âm thầm thành công).
  await assert.rejects(
    mod.deleteTemplateDraftVersion("tpl-1", "ver-9"),
    (error: unknown) => (error as { status?: number }).status === 404,
  );
});

/* ==================================================================== *
 * PART 2 — ROUTE: DELETE /versions/[versionId]
 * ==================================================================== */

const DELETE_ROUTE_PATH = "src/app/api/document-merge/templates/[id]/versions/[versionId]/route.ts";
const deleteRouteSource = readFileSync(new URL(`../../../${DELETE_ROUTE_PATH}`, import.meta.url), "utf8");
const deleteRouteJs = ts.transpileModule(deleteRouteSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

type DeleteRouteContext = {
  DELETE: (
    req: Request,
    ctx: { params: Promise<{ id: string; versionId: string }> },
  ) => Promise<{ status: number; body: Record<string, unknown> }>;
  deleteCalls: { templateId: string; versionId: string }[];
  auditCalls: { action: string; targetType: string; details: Record<string, unknown> }[];
  requiredIds: string[];
};

function makeDeleteRouteContext(opts: {
  role?: string;
  permissionDenied?: boolean;
  deleteResult?: { id: string; templateId: string; version: number };
  deleteError?: { status: number; message: string };
} = {}): DeleteRouteContext {
  const role = opts.role ?? "ADMIN";
  const deleteCalls: DeleteRouteContext["deleteCalls"] = [];
  const auditCalls: DeleteRouteContext["auditCalls"] = [];
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
              targetType: string,
              details: Record<string, unknown>,
            ) => {
              auditCalls.push({ action, targetType, details });
            },
          };
        case "@/lib/document-merge/template-versions":
          return {
            TemplateVersionError: FakeTemplateVersionError,
            updateTemplateVersionDraft: async () => {
              throw new Error("DELETE route must never call updateTemplateVersionDraft");
            },
            deleteTemplateDraftVersion: async (templateId: string, versionId: string) => {
              if (opts.deleteError) {
                throw new FakeTemplateVersionError(opts.deleteError.message, opts.deleteError.status);
              }
              deleteCalls.push({ templateId, versionId });
              return opts.deleteResult ?? { id: versionId, templateId, version: 9 };
            },
          };
        default:
          throw new Error(`Unexpected require("${id}") — delete route must not depend on this module.`);
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
  vm.runInContext(deleteRouteJs, context);
  return {
    DELETE: (moduleObj.exports as { DELETE: DeleteRouteContext["DELETE"] }).DELETE,
    deleteCalls,
    auditCalls,
    requiredIds,
  };
}

const deleteParams = (id = "tpl-1", versionId = "ver-9") => ({ params: Promise.resolve({ id, versionId }) });
const deleteRequest = () =>
  new Request("http://localhost/api/document-merge/templates/tpl-1/versions/ver-9", { method: "DELETE" });

test("delete route: DRAFT hợp lệ → 200, gọi service đúng (id, versionId), audit DELETE_TEMPLATE_DRAFT_VERSION", async () => {
  const ctx = makeDeleteRouteContext();
  const res = await ctx.DELETE(deleteRequest(), deleteParams());
  assert.equal(res.status, 200);
  assert.equal(res.body.deleted, true);
  assert.equal(res.body.version, 9);
  assert.equal(res.body.published, false, "không bao giờ tự publish");

  assert.equal(ctx.deleteCalls.length, 1);
  // Identity luôn lấy từ URL params — client không gửi body nào.
  assert.deepEqual(ctx.deleteCalls[0], { templateId: "tpl-1", versionId: "ver-9" });

  assert.equal(ctx.auditCalls.length, 1, "ghi audit đúng 1 lần khi thành công");
  const audit = ctx.auditCalls[0];
  assert.equal(audit.action, "DELETE_TEMPLATE_DRAFT_VERSION");
  assert.equal(audit.targetType, "merge_template_versions");
  assert.deepEqual(plain(audit.details), { templateId: "tpl-1", versionId: "ver-9", version: 9 });
});

test("delete route: PUBLISHED/ARCHIVED (409 từ service) được truyền nguyên trạng — KHÔNG ghi audit", async () => {
  const published = makeDeleteRouteContext({
    deleteError: { status: 409, message: "Chỉ version DRAFT mới được xoá vĩnh viễn. Version v8 hiện đang PUBLISHED và là bất biến." },
  });
  const resPublished = await published.DELETE(deleteRequest(), deleteParams("tpl-1", "ver-8"));
  assert.equal(resPublished.status, 409);
  assert.match(String(resPublished.body.error), /PUBLISHED/);
  assert.equal(published.auditCalls.length, 0, "thất bại → không ghi audit");

  const archived = makeDeleteRouteContext({
    deleteError: { status: 409, message: "Chỉ version DRAFT mới được xoá vĩnh viễn. Version v7 hiện đang ARCHIVED." },
  });
  const resArchived = await archived.DELETE(deleteRequest(), deleteParams("tpl-1", "ver-7"));
  assert.equal(resArchived.status, 409);
  assert.equal(archived.auditCalls.length, 0);
});

test("delete route: cross-template 404 + race 409 từ service được truyền đúng status", async () => {
  const notFound = makeDeleteRouteContext({ deleteError: { status: 404, message: "Template version not found" } });
  const res404 = await notFound.DELETE(deleteRequest(), deleteParams("tpl-1", "ver-cua-template-khac"));
  assert.equal(res404.status, 404);
  assert.equal(notFound.auditCalls.length, 0);

  const race = makeDeleteRouteContext({
    deleteError: { status: 409, message: "Version đã không còn là DRAFT (có thể vừa được publish/archive) — không thể xoá. Hãy tải lại danh sách phiên bản." },
  });
  const res409 = await race.DELETE(deleteRequest(), deleteParams());
  assert.equal(res409.status, 409);
  assert.match(String(res409.body.error), /không còn là DRAFT/);
});

test("delete route: bị từ chối quyền → KHÔNG gọi service, KHÔNG ghi audit", async () => {
  const ctx = makeDeleteRouteContext({ permissionDenied: true });
  const res = await ctx.DELETE(deleteRequest(), deleteParams());
  assert.equal(res.status, 403);
  assert.equal(ctx.deleteCalls.length, 0);
  assert.equal(ctx.auditCalls.length, 0);
});

test("delete route: audit KHÔNG chứa HTML/CSS nội dung version, KHÔNG chứa PII ứng viên, KHÔNG chứa stack trace", async () => {
  const ctx = makeDeleteRouteContext();
  const res = await ctx.DELETE(deleteRequest(), deleteParams());
  assert.equal(res.status, 200);
  assert.equal(ctx.auditCalls.length, 1);

  const detailsJson = JSON.stringify(ctx.auditCalls[0].details);
  // Chỉ chứa identity — không một dấu hiệu nào của nội dung template.
  assert.deepEqual(Object.keys(ctx.auditCalls[0].details).sort(), ["templateId", "version", "versionId"]);
  assert.doesNotMatch(detailsJson, /htmlBody|printCss|<div|<p|SECRET/i);
  // Không PII ứng viên.
  assert.doesNotMatch(detailsJson, /fullName|cccd|phone|email|address|ho_ten/i);
  // Response cũng không rò rỉ nội dung version.
  const bodyJson = JSON.stringify(res.body);
  assert.doesNotMatch(bodyJson, /htmlBody|printCss/i);

  // Route không được phụ thuộc module ngoài danh sách cho phép
  // (next/server, @/lib/auth, template-versions service).
  const unexpected = ctx.requiredIds.filter(
    (id) => !["next/server", "@/lib/auth", "@/lib/document-merge/template-versions"].includes(id),
  );
  assert.deepEqual(unexpected, [], "route chỉ phụ thuộc service + auth — ghi DB do service đảm nhiệm");
});
