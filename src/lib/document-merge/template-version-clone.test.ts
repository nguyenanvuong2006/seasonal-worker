/**
 * TEMPLATE VERSION CLONE — regression tests cho "Tạo bản nháp từ phiên bản này".
 *
 * Service: cloneTemplateVersion() (src/lib/document-merge/template-versions.ts)
 * Route:   POST /api/document-merge/templates/[id]/versions/[versionId]/clone
 *
 * Chạy trên ĐÚNG mã nguồn production (transpile + vm sandbox, cùng khuôn mẫu
 * template-versions.test.ts / draft-preview-route.test.ts). Fake drizzle ghi
 * lại TOÀN BỘ lệnh, nên "không có UPDATE/INSERT nào vào bảng X" là assertion
 * về các câu lệnh thật sự phát ra, không phải lời bình luận.
 *
 * Bối cảnh Production mà spec mô tả: v8 = PUBLISHED (đang render), operator
 * muốn sửa HTML → clone v8 → v9 DRAFT → sửa → preview → publish v9.
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
// Module quyết định thuần (PR #99) — KHÔNG stub để test composition clone+preview.
import * as draftPreviewModule from "./draft-preview.ts";

/* ==================================================================== *
 * PART 1 — SERVICE: cloneTemplateVersion
 * ==================================================================== */

const schemaStub = {
  mergeTemplates: makeTable("merge_templates"),
  mergeTemplateFields: makeTable("merge_template_fields"),
  mergeTemplateVersions: makeTable("merge_template_versions"),
};

const SOURCE_HTML =
  '<div class="page"><p>Họ tên: <<Ho_ten>></p><p>Số CCCD: <<CCCD>></p></div>';
const SOURCE_CSS = ".page { width: 210mm; min-height: 297mm; }";
const FROZEN_SNAPSHOT = [
  {
    placeholder: "Ho_ten",
    sourceType: "CORE_FIELD",
    sourceEntity: null,
    sourceField: null,
    sourcePath: "fullName",
    optionValue: null,
    formatType: null,
    fallbackValue: null,
    isRequired: true,
  },
  {
    placeholder: "CCCD",
    sourceType: "CORE_FIELD",
    sourceEntity: null,
    sourceField: null,
    sourcePath: "cccd",
    optionValue: null,
    formatType: null,
    fallbackValue: null,
    isRequired: false,
  },
];

/** v8 PUBLISHED — đúng production reality: frozen mapping_snapshot 49-field style. */
function makeSourceVersion() {
  return {
    id: "ver-8",
    templateId: "tpl-1",
    version: 8,
    status: "PUBLISHED",
    htmlBody: SOURCE_HTML,
    printCss: SOURCE_CSS,
    sourceDocxName: "dang-ky-tap-nghe.docx",
    retentionYears: 3,
    mappingSnapshot: FROZEN_SNAPSHOT,
    createdBy: "admin-a",
    publishedAt: new Date("2026-08-20T00:00:00Z"),
    archivedAt: null,
    supersededBy: null,
    createdAt: new Date("2026-08-01T00:00:00Z"),
    updatedAt: new Date("2026-08-20T00:00:00Z"),
  };
}

type CloneModule = {
  cloneTemplateVersion: (
    templateId: string,
    versionId: string,
    createdBy: string,
  ) => Promise<Record<string, unknown>>;
  updateTemplateVersionDraft: (
    templateId: string,
    versionId: string,
    input: { htmlBody: string; printCss?: string | null },
  ) => Promise<Record<string, unknown>>;
  isUniqueViolation: (error: unknown) => boolean;
};

async function loadService(db: FakeDb): Promise<CloneModule> {
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
  return mod as unknown as CloneModule;
}

/**
 * Fake DB cho happy path: source v8 PUBLISHED tồn tại, các version hiện có
 * 1..8; INSERT trả về row mới với id "ver-9".
 */
function makeCloneDb(overrides: {
  source?: unknown[];
  existingVersions?: number[];
  onInsert?: (attempt: number, call: QueryCall) => unknown;
} = {}) {
  const source = overrides.source ?? [makeSourceVersion()];
  const existingVersions = overrides.existingVersions ?? [1, 2, 3, 4, 5, 6, 7, 8];
  let insertAttempt = 0;
  return createFakeDb({
    respond: (call) => {
      if (call.root === "select" && call.table === "merge_template_versions") {
        // Select version nguồn (WHERE id = ... AND template_id = ...) — giả lập
        // AND thật: row phải khớp CẢ id LẪN templateId.
        const wantedId = eqValue(call, "merge_template_versions.id");
        if (wantedId !== undefined) {
          const wantedTemplate = eqValue(call, "merge_template_versions.templateId");
          return source.filter(
            (row) =>
              (row as { id: string }).id === wantedId &&
              (wantedTemplate === undefined || (row as { templateId: string }).templateId === wantedTemplate),
          );
        }
        // Select danh sách version trong transaction (WHERE template_id = ...)
        return existingVersions.map((v) => ({ version: v }));
      }
      if (call.root === "insert" && call.table === "merge_template_versions") {
        insertAttempt += 1;
        if (overrides.onInsert) return overrides.onInsert(insertAttempt, call);
        const values = argOf(call, "values") as Record<string, unknown>;
        return [
          {
            id: "ver-new",
            templateId: values.templateId,
            version: values.version,
            status: values.status,
            htmlBody: values.htmlBody,
            printCss: values.printCss,
            sourceDocxName: values.sourceDocxName,
            retentionYears: values.retentionYears,
            mappingSnapshot: values.mappingSnapshot,
            createdBy: values.createdBy,
            publishedAt: values.publishedAt ?? null,
            archivedAt: values.archivedAt ?? null,
            supersededBy: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ];
      }
      return undefined;
    },
  });
}

test("clone: v8 PUBLISHED → version DRAFT mới (v9), status/publishedAt/archivedAt đúng lifecycle", async () => {
  const db = makeCloneDb();
  const mod = await loadService(db);

  const cloned = await mod.cloneTemplateVersion("tpl-1", "ver-8", "admin-b");

  assert.equal(cloned.version, 9);
  assert.equal(cloned.status, "DRAFT");
  assert.equal(cloned.sourceVersionNumber, 8);

  const insert = db.writesTo("merge_template_versions");
  assert.equal(insert.length, 1, "đúng MỘT insert — clone là CREATE, không phải edit");
  const values = argOf(insert[0], "values") as Record<string, unknown>;
  assert.equal(values.version, 9);
  assert.equal(values.status, "DRAFT");
  assert.equal(values.publishedAt, null);
  assert.equal(values.archivedAt, null);
  assert.equal(values.supersededBy, null);
  assert.equal(values.createdBy, "admin-b");
  assert.notEqual(values.id, "ver-8");
});

test("clone: source v8 KHÔNG bị UPDATE/DELETE — không có bất kỳ lệnh ghi nào ngoài INSERT version mới", async () => {
  const db = makeCloneDb();
  const mod = await loadService(db);

  await mod.cloneTemplateVersion("tpl-1", "ver-8", "admin-b");

  // Toàn bộ ghi = đúng 1 INSERT vào merge_template_versions. Không UPDATE,
  // không DELETE, không INSERT vào bảng nào khác.
  assert.equal(db.writes.length, 1);
  assert.equal(db.writes[0].root, "insert");
  assert.equal(db.writes[0].table, "merge_template_versions");
});

test("clone: source HTML/CSS không bị mutate — bản sao bằng từng ký tự với nguồn", async () => {
  const source = makeSourceVersion();
  const db = makeCloneDb({ source: [source] });
  const mod = await loadService(db);

  await mod.cloneTemplateVersion("tpl-1", "ver-8", "admin-b");

  // Nguồn nguyên vẹn trong fixture…
  assert.equal(source.htmlBody, SOURCE_HTML);
  assert.equal(source.printCss, SOURCE_CSS);
  // …và giá trị insert là bản sao đúng bằng (string immutable — kiểm tra cả
  // tham chiếu không dùng chung mảng mapping snapshot).
  const values = argOf(db.writesTo("merge_template_versions")[0], "values") as Record<string, unknown>;
  assert.equal(values.htmlBody, SOURCE_HTML);
  assert.equal(values.printCss, SOURCE_CSS);
  assert.equal(values.retentionYears, 3);
  assert.equal(values.sourceDocxName, "dang-ky-tap-nghe.docx");
});

test("clone: mapping_snapshot của DRAFT mới = [] — KHÔNG copy frozen snapshot của v8", async () => {
  const db = makeCloneDb();
  const mod = await loadService(db);

  const cloned = await mod.cloneTemplateVersion("tpl-1", "ver-8", "admin-b");

  const values = argOf(db.writesTo("merge_template_versions")[0], "values") as Record<string, unknown>;
  // So sánh realm-an toàn: mảng tạo trong vm sandbox có prototype khác host.
  assert.ok(Array.isArray(values.mappingSnapshot) && values.mappingSnapshot.length === 0);
  assert.ok(Array.isArray(cloned.mappingSnapshot) && cloned.mappingSnapshot.length === 0);
  // Frozen snapshot của nguồn vẫn đủ 2 row — không bị thay đổi.
  assert.equal(FROZEN_SNAPSHOT.length, 2);
  // Và giá trị insert không dùng chung tham chiếu với snapshot nguồn.
  assert.notEqual(values.mappingSnapshot, FROZEN_SNAPSHOT);
});

test("clone: KHÔNG đổi current_published_version, KHÔNG tạo merge job / document_history", async () => {
  const db = makeCloneDb();
  const mod = await loadService(db);

  await mod.cloneTemplateVersion("tpl-1", "ver-8", "admin-b");

  assert.equal(db.writesTo("merge_templates").length, 0, "current_published_version bất động");
  assert.equal(db.writesTo("merge_jobs").length, 0, "không tạo merge job");
  assert.equal(db.writesTo("merge_job_records").length, 0, "không tạo merge job record");
  assert.equal(db.writesTo("document_history").length, 0, "không tạo document_history");
  assert.equal(db.writesTo("merge_template_fields").length, 0, "không đụng 49 field mappings");
});

test("clone: KHÔNG publish — không có UPDATE status/version nào được phát ra", async () => {
  const db = makeCloneDb();
  const mod = await loadService(db);

  await mod.cloneTemplateVersion("tpl-1", "ver-8", "admin-b");

  const versionUpdates = db.calls.filter(
    (c) => c.root === "update" && c.table === "merge_template_versions",
  );
  assert.equal(versionUpdates.length, 0, "publish = UPDATE status; ở đây phải bằng 0");
});

test("clone: versionId thuộc template khác → 404 (cross-check templateId trong SQL)", async () => {
  const db = makeCloneDb();
  const mod = await loadService(db);

  await assert.rejects(
    mod.cloneTemplateVersion("tpl-KHAC", "ver-8", "admin-b"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { status?: number }).status, 404);
      return true;
    },
  );
  // Không có ghi nào khi reject.
  assert.equal(db.writes.length, 0);
  // Select nguồn phải cross-check CẢ id LẪN templateId.
  const sourceSelect = db.calls.find(
    (c) => c.root === "select" && c.table === "merge_template_versions" && c.ops.some((o) => o.fn === "limit"),
  ) as QueryCall;
  assert.ok(sourceSelect, "phải select version nguồn");
  assert.equal(eqValue(sourceSelect, "merge_template_versions.id"), "ver-8");
  assert.equal(eqValue(sourceSelect, "merge_template_versions.templateId"), "tpl-KHAC");
});

test("clone: version không có HTML → 400, không tạo version rỗng", async () => {
  const empty = { ...makeSourceVersion(), id: "ver-empty", htmlBody: null };
  const db = makeCloneDb({ source: [empty] });
  const mod = await loadService(db);

  await assert.rejects(
    mod.cloneTemplateVersion("tpl-1", "ver-empty", "admin-b"),
    (error: unknown) => (error as { status?: number }).status === 400,
  );
  assert.equal(db.writes.length, 0);
});

test("clone (concurrency): admin A và B cùng tính v9 → unique violation → retry tạo v10, KHÔNG overwrite v9", async () => {
  // Lượt 1: DB còn version 1..8; INSERT v9 ném 23505 vì admin A vừa commit v9.
  // Lượt 2: select thấy 1..9; INSERT v10 thành công.
  const existingPerAttempt: number[][] = [
    [1, 2, 3, 4, 5, 6, 7, 8],
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
  ];
  const attemptedVersions: number[] = [];
  let txIndex = -1;
  const db = createFakeDb({
    respond: (call) => {
      if (call.root === "select" && call.table === "merge_template_versions") {
        const wantedId = eqValue(call, "merge_template_versions.id");
        if (wantedId !== undefined) return [makeSourceVersion()];
        // Mỗi transaction retry đọc lại trạng thái DB MỚI.
        txIndex += 1;
        const list = existingPerAttempt[Math.min(txIndex, existingPerAttempt.length - 1)];
        return list.map((v) => ({ version: v }));
      }
      if (call.root === "insert" && call.table === "merge_template_versions") {
        const values = argOf(call, "values") as Record<string, unknown>;
        attemptedVersions.push(values.version as number);
        if (values.version === 9) {
          // Postgres unique_violation — admin A đã chiếm v9.
          throw Object.assign(new Error('duplicate key value violates unique constraint "merge_template_version_uq"'), {
            code: "23505",
          });
        }
        return [
          {
            id: "ver-10",
            templateId: values.templateId,
            version: values.version,
            status: values.status,
            htmlBody: values.htmlBody,
            printCss: values.printCss,
            sourceDocxName: values.sourceDocxName,
            retentionYears: values.retentionYears,
            mappingSnapshot: values.mappingSnapshot,
            createdBy: values.createdBy,
            publishedAt: null,
            archivedAt: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ];
      }
      return undefined;
    },
  });
  const mod = await loadService(db);

  const cloned = await mod.cloneTemplateVersion("tpl-1", "ver-8", "admin-b");

  assert.equal(cloned.version, 10, "retry phải tạo v10 sau khi v9 bị chiếm");
  assert.deepEqual(attemptedVersions, [9, 10], "thử v9 (bị từ chối) rồi v10 — không overwrite v9");
  assert.ok(db.transactions >= 2, "phải mở transaction mới cho mỗi lần retry");
});

test("clone (concurrency): unique violation kéo dài → 409 rõ ràng, không loop vô hạn", async () => {
  let insertCount = 0;
  const db = createFakeDb({
    respond: (call) => {
      if (call.root === "select" && call.table === "merge_template_versions") {
        const wantedId = eqValue(call, "merge_template_versions.id");
        if (wantedId !== undefined) return [makeSourceVersion()];
        return [{ version: 8 }];
      }
      if (call.root === "insert" && call.table === "merge_template_versions") {
        insertCount += 1;
        throw Object.assign(
          new Error('duplicate key value violates unique constraint "merge_template_version_uq"'),
          { code: "23505" },
        );
      }
      return undefined;
    },
  });
  const mod = await loadService(db);

  await assert.rejects(
    mod.cloneTemplateVersion("tpl-1", "ver-8", "admin-b"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { status?: number }).status, 409, "hết lượt thử → 409 có kiểm soát");
      // KHÔNG lộ chi tiết driver (tên constraint / lỗi pg) ra thông điệp client.
      assert.ok(!error.message.includes("duplicate key"));
      assert.ok(!error.message.includes("merge_template_version_uq"));
      assert.ok(!error.message.includes("23505"));
      return true;
    },
  );
  assert.equal(insertCount, 5, "giới hạn 5 lần thử");
});

test("clone: v8 DRAFT (chưa publish) cũng clone được → DRAFT mới, không copy lifecycle", async () => {
  const draftSource = {
    ...makeSourceVersion(),
    id: "ver-draft-8",
    version: 8,
    status: "DRAFT",
    mappingSnapshot: [],
    publishedAt: null,
  };
  const db = makeCloneDb({ source: [draftSource] });
  const mod = await loadService(db);

  const cloned = await mod.cloneTemplateVersion("tpl-1", "ver-draft-8", "admin-b");

  assert.equal(cloned.version, 9);
  assert.equal(cloned.status, "DRAFT");
  const values = argOf(db.writesTo("merge_template_versions")[0], "values") as Record<string, unknown>;
  assert.equal(values.status, "DRAFT");
  assert.ok(Array.isArray(values.mappingSnapshot) && values.mappingSnapshot.length === 0);
  assert.equal(values.htmlBody, SOURCE_HTML, "HTML của DRAFT nguồn được copy nguyên vẹn");
  assert.equal(values.publishedAt, null);
});

test("clone (concurrency): lỗi DB THƯỜNG (không phải 23505) KHÔNG retry — ném thẳng sau đúng 1 lần", async () => {
  let insertCount = 0;
  const db = createFakeDb({
    respond: (call) => {
      if (call.root === "select" && call.table === "merge_template_versions") {
        const wantedId = eqValue(call, "merge_template_versions.id");
        if (wantedId !== undefined) return [makeSourceVersion()];
        return [{ version: 8 }];
      }
      if (call.root === "insert" && call.table === "merge_template_versions") {
        insertCount += 1;
        throw Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
      }
      return undefined;
    },
  });
  const mod = await loadService(db);

  await assert.rejects(
    mod.cloneTemplateVersion("tpl-1", "ver-8", "admin-b"),
    (error: unknown) => {
      // Lỗi gốc được ném thẳng (route sẽ map 500), KHÔNG phải 409 của retry.
      assert.equal((error as { code?: string }).code, "ECONNREFUSED");
      return true;
    },
  );
  assert.equal(insertCount, 1, "không retry lỗi không phải unique violation");
  assert.equal(db.transactions, 1);
});

test("isUniqueViolation: nhận 23505 trực tiếp, qua drizzle cause, và từ chối lỗi khác", async () => {
  const mod = await loadService(createFakeDb());
  assert.equal(mod.isUniqueViolation(Object.assign(new Error("x"), { code: "23505" })), true);
  assert.equal(
    mod.isUniqueViolation(new Error("drizzle wraps", { cause: Object.assign(new Error("pg"), { code: "23505" }) })),
    true,
  );
  assert.equal(mod.isUniqueViolation(Object.assign(new Error("x"), { code: "23503" })), false);
  assert.equal(mod.isUniqueViolation(new Error("plain")), false);
});

/* ==================================================================== *
 * PART 2 — COMPOSITION với Safe DRAFT Preview (PR #99)
 * ==================================================================== */

test("preview composition: DRAFT v9 (mapping_snapshot=[]) resolve CURRENT non-orphaned fields — dùng lại selectPreviewMappings thật", () => {
  const clonedV9 = {
    id: "ver-9",
    templateId: "tpl-1",
    version: 9,
    status: "DRAFT",
    htmlBody: SOURCE_HTML,
    printCss: SOURCE_CSS,
    mappingSnapshot: [], // ← clone KHÔNG copy frozen snapshot
  };
  const currentFields = [
    {
      placeholder: "Ho_ten",
      sourceType: "CORE_FIELD",
      sourceEntity: null,
      sourceField: null,
      sourcePath: "fullName_NEW", // mapping đã đổi sau khi v8 publish
      optionValue: null,
      formatType: null,
      fallbackValue: null,
      isRequired: true,
      isOrphaned: false,
    },
    {
      placeholder: "CCCD",
      sourceType: "CORE_FIELD",
      sourceEntity: null,
      sourceField: null,
      sourcePath: "cccd",
      optionValue: null,
      formatType: null,
      fallbackValue: null,
      isRequired: false,
      isOrphaned: true, // orphaned → bị bỏ qua
    },
  ];

  const { mappings, source } = draftPreviewModule.selectPreviewMappings(
    clonedV9 as Parameters<typeof draftPreviewModule.selectPreviewMappings>[0],
    currentFields as Parameters<typeof draftPreviewModule.selectPreviewMappings>[1],
  );

  assert.equal(source, draftPreviewModule.DRAFT_PREVIEW_MAPPING_SOURCE.CURRENT_FIELDS);
  assert.equal(mappings.length, 1, "chỉ field non-orphaned");
  assert.equal(mappings[0].sourcePath, "fullName_NEW");

  // Trong khi đó v8 PUBLISHED vẫn render từ frozen snapshot — immutable.
  const publishedV8 = { ...clonedV9, id: "ver-8", version: 8, status: "PUBLISHED", mappingSnapshot: FROZEN_SNAPSHOT };
  const frozen = draftPreviewModule.selectPreviewMappings(
    publishedV8 as Parameters<typeof draftPreviewModule.selectPreviewMappings>[0],
    currentFields as Parameters<typeof draftPreviewModule.selectPreviewMappings>[1],
  );
  assert.equal(frozen.source, draftPreviewModule.DRAFT_PREVIEW_MAPPING_SOURCE.SNAPSHOT);
  assert.equal(frozen.mappings[0].sourcePath, "fullName", "frozen snapshot thắng, current fields không đụng được");
});

/* ==================================================================== *
 * PART 3 — ROUTE: POST /versions/[versionId]/clone
 * ==================================================================== */

const CLONE_ROUTE_PATH =
  "src/app/api/document-merge/templates/[id]/versions/[versionId]/clone/route.ts";
const cloneRouteSource = readFileSync(
  new URL(`../../../${CLONE_ROUTE_PATH}`, import.meta.url),
  "utf8",
);
const cloneRouteCode = cloneRouteSource
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");
const cloneRouteJs = ts.transpileModule(cloneRouteSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

type CloneRouteContext = {
  POST: (
    req: Request,
    ctx: { params: Promise<{ id: string; versionId: string }> },
  ) => Promise<{ status: number; body: Record<string, unknown> }>;
  cloneCalls: { templateId: string; versionId: string; username: string }[];
  auditCalls: { action: string; details: Record<string, unknown> }[];
  requiredIds: string[];
};

function makeCloneRouteContext(opts: {
  role?: string;
  permissionDenied?: boolean;
  cloneResult?: Record<string, unknown>;
  cloneError?: { status: number; message: string };
} = {}): CloneRouteContext {
  const role = opts.role ?? "ADMIN";
  const cloneCalls: CloneRouteContext["cloneCalls"] = [];
  const auditCalls: CloneRouteContext["auditCalls"] = [];
  const requiredIds: string[] = [];

  class FakeTemplateVersionError extends Error {
    public status: number;
    constructor(
      message: string,
      status = 400,
    ) {
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
            cloneTemplateVersion: async (templateId: string, versionId: string, username: string) => {
              if (opts.cloneError) {
                throw new FakeTemplateVersionError(opts.cloneError.message, opts.cloneError.status);
              }
              cloneCalls.push({ templateId, versionId, username });
              return (
                opts.cloneResult ?? {
                  id: "ver-9",
                  templateId,
                  version: 9,
                  status: "DRAFT",
                  htmlBody: SOURCE_HTML,
                  printCss: SOURCE_CSS,
                  mappingSnapshot: [],
                  createdBy: username,
                  sourceVersionNumber: 8,
                }
              );
            },
          };
        default:
          throw new Error(`Unexpected require("${id}") — clone route must not depend on this module.`);
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
  vm.runInContext(cloneRouteJs, context);
  return {
    POST: (moduleObj.exports as { POST: CloneRouteContext["POST"] }).POST,
    cloneCalls,
    auditCalls,
    requiredIds,
  };
}

const cloneParams = (id = "tpl-1", versionId = "ver-8") => ({ params: Promise.resolve({ id, versionId }) });
const cloneRequest = () => new Request("http://localhost/api/document-merge/templates/tpl-1/versions/ver-8/clone", { method: "POST" });

test("clone route: thành công → 201 {success, version, versionId, status=DRAFT}, audit CLONE_TEMPLATE_VERSION", async () => {
  const ctx = makeCloneRouteContext();
  const res = await ctx.POST(cloneRequest(), cloneParams());

  assert.equal(res.status, 201);
  assert.equal(res.body.success, true);
  assert.equal(res.body.version, 9);
  assert.equal(res.body.versionId, "ver-9");
  assert.equal(res.body.status, "DRAFT");
  assert.equal(res.body.published, false);
  assert.equal(res.body.sourceVersion, 8);

  assert.deepEqual(ctx.cloneCalls, [{ templateId: "tpl-1", versionId: "ver-8", username: "ADMIN" }]);
  assert.equal(ctx.auditCalls[0]?.action, "CLONE_TEMPLATE_VERSION");
  assert.equal(ctx.auditCalls[0]?.details.published, false);
});

test("clone route: server tự load nguồn theo URL — KHÔNG tin body client (body chứa HTML giả vẫn bị bỏ qua)", async () => {
  const ctx = makeCloneRouteContext();
  const rogue = new Request("http://localhost/api/document-merge/templates/tpl-1/versions/ver-8/clone", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ htmlBody: "<p>FAKE_FROM_CLIENT</p>", version: 99 }),
  });
  const res = await ctx.POST(rogue, cloneParams("tpl-1", "ver-8"));

  assert.equal(res.status, 201);
  assert.equal(res.body.version, 9, "version number do server tính, không nhận 99 từ client");
  assert.deepEqual(ctx.cloneCalls, [{ templateId: "tpl-1", versionId: "ver-8", username: "ADMIN" }]);
});

test("clone route: unauthorized (role ngoài whitelist) → 403 TRƯỚC khi gọi service, không audit", async () => {
  const ctx = makeCloneRouteContext({ role: "WORKER" });
  const res = await ctx.POST(cloneRequest(), cloneParams());

  assert.equal(res.status, 403);
  assert.equal(ctx.cloneCalls.length, 0, "service không được gọi");
  assert.equal(ctx.auditCalls.length, 0);
});

test("clone route: permission bị tắt → 403 (dynamic RBAC fail-closed)", async () => {
  const ctx = makeCloneRouteContext({ permissionDenied: true });
  const res = await ctx.POST(cloneRequest(), cloneParams());
  assert.equal(res.status, 403);
  assert.equal(ctx.cloneCalls.length, 0);
});

test("clone route: cross-template versionId → 404 truyền đúng từ service", async () => {
  const ctx = makeCloneRouteContext({ cloneError: { status: 404, message: "Template version not found" } });
  const res = await ctx.POST(cloneRequest(), cloneParams("tpl-KHAC", "ver-8"));
  assert.equal(res.status, 404);
  assert.equal(res.body.error, "Template version not found");
});

test("clone route: KHÔNG import worker-trigger/queue/document-history — không thể dispatch worker", async () => {
  const ctx = makeCloneRouteContext();
  await ctx.POST(cloneRequest(), cloneParams());

  // require shim ném lỗi cho bất kỳ module nào ngoài whitelist — chính là
  // chứng minh tĩnh rằng route không phụ thuộc worker/queue/history.
  assert.deepEqual(
    ctx.requiredIds.filter((id) => /worker|queue|history|batch|merge-job|publish/i.test(id)),
    [],
  );
  assert.doesNotMatch(cloneRouteCode, /publishTemplateVersion|rollbackTemplateVersion|archiveTemplateVersion/);
});
