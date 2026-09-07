/**
 * PUBLISH CHECKLIST — REPRODUCTION (Phase 2) + REGRESSION (Phase 5)
 * cho production bug "v15 DRAFT đã chỉnh HTML/CSS hoàn chỉnh nhưng nút
 * 'Xuất bản phiên bản' bị disabled / không thể Publish".
 *
 * ROOT CAUSE (audit):
 *   - Nút "Xuất bản phiên bản" trên card MỞ PublishChecklistModal — nó không
 *     bị gate bởi validate nào (chỉ disabled khi có version action đang chạy).
 *   - Nút CÙNG TÊN "Xuất bản phiên bản" BÊN TRONG PublishChecklistModal (nút
 *     confirm) bị disable bởi canConfirmPublish(machine, checks), mà `machine`
 *     cũ chỉ gồm htmlValid/cssValid/security — THIẾU chính xác các điều kiện
 *     backend publishTemplateVersion tự enforce: validatePlaceholderCoverage
 *     (UNMAPPED / REQUIRED_UNRESOLVABLE), html_body rỗng, và trạng thái hiện
 *     tại của version. Kết quả: operator thấy confirm "Xuất bản phiên bản"
 *     bị disabled (khi analyze lỗi/không chạy) HOẶC confirm bật lên rồi bị
 *     backend từ chối 400 — trong khi checklist KHÔNG HIỆN ĐỦ lý do cụ thể
 *     (placeholder nào chưa mapping). Hơn nữa modal cũ phân tích đúng object
 *     React snapshot lúc bấm nút (có thể là version loaded trước lần Save
 *     cuối) thay vì nội dung MỚI NHẤT trên server.
 *
 * FIX được khóa bằng file này:
 *   PART 1 (structural — đọc source production thật, repo không có jsdom):
 *     R1. DRAFT → card render nút "Xuất bản phiên bản", clickable (disabled
 *         duy nhất khi versionAction !== null), click MỞ checklist.
 *     R2. Checklist re-read row MỚI NHẤT (GET /versions) + analyze nội dung
 *         fresh — không dùng stale snapshot, không fallback
 *         current_published_version.
 *     R3. Checklist chỉ fetch 2 endpoint read-only (GET /versions +
 *         POST /ai-analyze) — mở checklist/Cancel = zero DB writes; publish
 *         thật do parent gọi đúng POST .../versions/{version.id}/publish.
 *     R4. Confirm disabled CHỈ khi machine checks/5 ô checkbox chưa đạt, và
 *         MỌI blocker được liệt kê cụ thể (tên placeholder) — không silent.
 *     R5. PUBLISHED không có nút (re)publish; ARCHIVED chỉ có "Khôi phục".
 *   PART 2 (behavior — service thật + fake-drizzle, KHÔNG cần DB):
 *     B1. v15-like DRAFT: create → Save x2 (save loop) → Publish HỢP LỆ
 *         (html/css/mapping hợp lệ) → PUBLISHED, snapshot freeze,
 *         current_published_version cập nhật, publish dùng HTML LẦN LƯU CUỐI.
 *     B2. v15-like DRAFT có placeholder chưa mapping → publish BỊ CHẶN ngay
 *         với tên placeholder cụ thể, ZERO writes (fail closed).
 *     B3. Publish version đang PUBLISHED → idempotent no-op, zero writes.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createFakeDb,
  drizzleStub,
  eqValue,
  argOf,
  makeTable,
  type FakeDb,
} from "../test-support/fake-drizzle.ts";
import { loadModule } from "../test-support/load-module.ts";

const LIBRARY_PATH = "../../components/document-merge/template-library.tsx";
const MODAL_PATH = "../../components/document-merge/publish-checklist-modal.tsx";

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const libraryFile = readFileSync(new URL(LIBRARY_PATH, import.meta.url), "utf8");
const modalFile = readFileSync(new URL(MODAL_PATH, import.meta.url), "utf8");
const libraryCode = stripComments(libraryFile);

const modalStart = modalFile.indexOf("export function PublishChecklistModal(");
const modalEnd = modalFile.indexOf("\nfunction hasHtmlBodyOf(", modalStart);
assert.ok(modalStart !== -1 && modalEnd !== -1 && modalEnd > modalStart, "PublishChecklistModal boundaries not found");
const modalCode = stripComments(modalFile.slice(modalStart, modalEnd));

/** Chặn thân hàm `const NAME = ...` tới `  };` cùng cấp (khuôn mẫu save-loop test). */
function sliceHandler(code: string, name: string): string {
  const start = code.indexOf(`const ${name} = `);
  assert.ok(start !== -1, `handler ${name} not found`);
  const end = code.indexOf("\n  };", start);
  assert.ok(end !== -1 && end > start, `handler ${name} boundary not found`);
  return code.slice(start, end);
}

/**
 * Vị trí ĐÚNG một label NÚT (theo sau là </button> gần kề) — bỏ qua các lần
 * xuất hiện cùng text trong paragraph/tiêu đề/hằng số khác.
 */
function buttonLabelIndex(code: string, label: string): number {
  let idx = code.indexOf(label);
  while (idx !== -1) {
    const after = code.slice(idx + label.length, idx + label.length + 80);
    if (/^\s*<\/button>/.test(after)) return idx;
    idx = code.indexOf(label, idx + 1);
  }
  assert.fail(`không thấy label nút '${label}' (một <button> chứa label đó)`);
}

const STATUS_GUARD_RE = /\{version\.status (!==|===) "([A-Z]+)" && \(/g;

/** Guard {version.status ===/!== "..." && ( gần nhất NGAY TRƯỚC label. */
function guardBefore(code: string, labelIdx: number): string {
  const windowStart = Math.max(0, labelIdx - 1200);
  const before = code.slice(windowStart, labelIdx);
  const guards = [...before.matchAll(STATUS_GUARD_RE)];
  assert.ok(guards.length > 0, "nút phải nằm trong guard {version.status ... && (…)}");
  return guards[guards.length - 1][2];
}

/** Toàn bộ block nút: từ guard tới </button> đầu tiên sau label. */
function publishButtonBlock(code: string, labelIdx: number): string {
  const windowStart = Math.max(0, labelIdx - 1200);
  const before = code.slice(windowStart, labelIdx);
  const guards = [...before.matchAll(STATUS_GUARD_RE)];
  assert.ok(guards.length > 0, "không tìm thấy guard status trước nút");
  const guardPos = windowStart + guards[guards.length - 1].index;
  const closeIdx = code.indexOf("</button>", labelIdx);
  return code.slice(guardPos, closeIdx + "</button>".length);
}

/* ==================================================================== *\
 * PART 1 — STRUCTURAL (Phase 2 reproduction + Phase 5 regressions)
 * ==================================================================== */

test("R1a: version DRAFT (v15-like) render nút 'Xuất bản phiên bản' — guard CHỈ DRAFT", () => {
  const labelIdx = buttonLabelIndex(libraryCode, "Xuất bản phiên bản");
  assert.equal(guardBefore(libraryCode, labelIdx), "DRAFT");
});

test("R1b: nút publish KHÔNG BAO GIỜ bị disabled (kể cả khi versionAction đang chạy) — click luôn tới được handler (bug v16: latch làm click bị nuốt im lặng)", () => {
  const block = publishButtonBlock(libraryCode, buttonLabelIndex(libraryCode, "Xuất bản phiên bản"));
  // BUG PRODUCTION v16: trước đây là `disabled={versionAction !== null}`.
  // versionAction là latch dùng chung cho mọi version action; chỉ cần một
  // request trước đó chưa kết thúc là nút chết — mà disabled:opacity-50 trên
  // nền emerald-700 gần như vô hình → operator thấy nút bình thường nhưng
  // trình duyệt nuốt click: "bấm không có gì xảy ra".
  assert.doesNotMatch(block, /disabled=/, "nút publish trên card KHÔNG được có thuộc tính disabled — checklist mới là nơi validate");
  assert.doesNotMatch(block, /analyzeResult|analyzing|previewVersion|mappingSnapshot|currentPublishedVersion|versionsLoading/, "không phụ thuộc sai vào analyzeResult/preview/mapping snapshot/current_published_version/state cũ");
});

test("R1c: click nút publish MỞ PublishChecklistModal — không window.confirm, không fetch publish trực tiếp", () => {
  const block = publishButtonBlock(libraryCode, buttonLabelIndex(libraryCode, "Xuất bản phiên bản"));
  // Click đi qua openPublishChecklist(...) — helper này luôn cho phản hồi
  // nhìn thấy được (mở checklist HOẶC hiện lỗi trong panel), không im lặng.
  assert.match(block, /openPublishChecklist\(version,\s*"publish"\)/);
  assert.doesNotMatch(block, /window\.confirm|fetch\(|runVersionAction/);
});

test("R2a: checklist RE-READ row version MỚI NHẤT từ server (GET /versions) khi mở — không dùng stale React snapshot", () => {
  assert.match(modalCode, /fetch\(`\/api\/document-merge\/templates\/\$\{templateId\}\/versions`,\s*\{\s*cache:\s*"no-store"\s*\}\)/);
  assert.match(modalCode, /\.id === target\.id/, "row phải được chọn ra theo ĐÚNG target.id");
  assert.match(modalCode, /setFreshVersion\(fresh\)/);
});

test("R2b: checklist analyze ĐÚNG nội dung MỚI NHẤT (fresh.htmlBody/fresh.printCss) — KHÔNG target snapshot, KHÔNG fallback current_published_version (regression #6/#10)", () => {
  assert.match(modalCode, /body:\s*JSON\.stringify\(\{\s*html:\s*fresh\.htmlBody,\s*printCss:\s*fresh\.printCss \?\? null,\s*baseVersionId\s*\}\)/);
  assert.doesNotMatch(modalCode, /html:\s*target\.htmlBody/, "không được analyze đúng object snapshot lúc bấm nút");
  assert.doesNotMatch(
    modalCode,
    /currentPublishedVersionId\s*\.\s*(htmlBody|printCss|status)|currentPublishedVersionNumber\s*\.\s*(htmlBody|printCss)/,
    "currentPublishedVersion* không bao giờ là NGUỒN NỘI DUNG",
  );
  // currentPublishedVersionId chỉ được phép dùng làm BASE SO SÁNH diff:
  // destructuring props (1) + khai báo type props (1) + biểu thức
  // baseVersionId (3) + dependency array của effect (1).
  const baseMatches = modalCode.match(/currentPublishedVersionId/g) ?? [];
  assert.equal(baseMatches.length, 6, "currentPublishedVersionId chỉ cho dùng ở baseVersionId (diff base) + wiring effect");
});

test("R3a: checklist chỉ fetch 2 endpoint READ-ONLY (GET /versions + POST /ai-analyze) — mở checklist = zero DB writes (regression #8)", () => {
  const fetches = modalCode.match(/fetch\(/g) ?? [];
  assert.equal(fetches.length, 2, "modal checklist không được fetch endpoint nào khác");
  assert.match(modalCode, /fetch\(`\/api\/document-merge\/templates\/\$\{templateId\}\/versions`,\s*\{\s*cache:\s*"no-store"\s*\}\)/);
  assert.match(modalCode, /fetch\(`\/api\/document-merge\/templates\/\$\{templateId\}\/ai-analyze`/);
  assert.doesNotMatch(modalCode, /\/publish`|\/rollback`|\/apply-html`|method:\s*"(PATCH|PUT|DELETE)"/, "modal KHÔNG publish/lưu/xoá gì — publish thật nằm ở parent");
});

test("R3b: Cancel/Hủy checklist chỉ đóng modal — zero fetch, zero DB writes (regression #7)", () => {
  // Nút Hủy + X đều gọi onClose (prop do parent cung cấp).
  assert.match(modalCode, /onClick=\{onClose\}/);
  const parentOnClose = libraryCode.match(/onClose=\{\(\) => setPublishChecklistTarget\(null\)\}/)?.[0];
  assert.ok(parentOnClose, "parent onClose phải chỉ reset state");
  assert.doesNotMatch(parentOnClose!, /fetch\(|runVersionAction|confirm/);
});

test("R3c: confirm hợp lệ → parent gọi ĐÚNG endpoint publish/rollback với ĐÚNG versionId của target (regression #9)", () => {
  const handler = sliceHandler(libraryCode, "runVersionAction");
  assert.match(handler, /fetch\(\s*`\/api\/document-merge\/templates\/\$\{editing\.id\}\/versions\/\$\{version\.id\}\/\$\{action\}`/);
  assert.match(handler, /method:\s*"POST"/);
  assert.match(handler, /setVersionAction\(`\$\{action\}:\$\{version\.id\}`\)/);
  assert.match(handler, /finally\s*\{\s*setVersionAction\(null\);\s*\}/, "versionAction luôn được reset (nút không kẹt disabled)");
});

test("R4a: Confirm disabled CHỈ qua canConfirmPublish(machine, checks) + loading/confirming — và machine bây giờ gồm coverage/htmlBody/status", () => {
  assert.match(modalCode, /const canConfirm = canConfirmPublish\(machine, checks\) && !confirming && !loading;/);
  assert.match(modalCode, /disabled=\{!canConfirm\}/);
  assert.match(modalCode, /placeholderCoverageOk:\s*result \? Boolean\(coverage\?\.ok\) : true/);
  assert.match(modalCode, /hasHtmlBody:\s*hasHtmlBodyOf\(freshVersion\)/);
  assert.match(modalCode, /statusPublishable:\s*action === "publish" \? versionStatus === "DRAFT" : versionStatus === "ARCHIVED"/);
});

test("R4b: mọi blocker đều được HIỆN CỤ THỂ (tên placeholder) — không silent disable", () => {
  assert.match(modalCode, /describePublishBlockers\(machine\)/);
  assert.match(modalCode, /blockers\.map\(\(b\) => \(/);
  // Placeholder FAIL phải liệt kê tên cụ thể theo 2 nhóm.
  assert.match(modalCode, /placeholder chưa được mapping: \{unmapped\.join\(", "\)\}/);
  assert.match(modalCode, /placeholder bắt buộc chưa có nguồn dữ liệu\/fallback:/);
  // Row Placeholder trong checklist + row Mapping snapshot + row Trạng thái version.
  assert.match(modalCode, /Placeholder: tất cả \$\{coverage\.totalPlaceholders\} placeholder/);
  assert.match(modalCode, /Mapping snapshot:/);
  assert.match(modalCode, /Bố cục A4\/PDF:/);
});

test("R5a: PUBLISHED KHÔNG còn nút (re)publish — 'Xuất bản lại' đã bị gỡ (regression #5: không publish lại)", () => {
  assert.doesNotMatch(libraryCode, /Xuất bản lại/);
});

test("R5b: ARCHIVED không publish trực tiếp — chỉ có 'Khôi phục' (rollback qua checklist) (regression #4)", () => {
  const restoreIdx = buttonLabelIndex(libraryCode, "Khôi phục");
  assert.equal(guardBefore(libraryCode, restoreIdx), "ARCHIVED");
  const block = publishButtonBlock(libraryCode, restoreIdx);
  assert.match(block, /openPublishChecklist\(version,\s*"rollback"\)/, "khôi phục vẫn phải qua checklist");
  assert.doesNotMatch(block, /action:\s*"publish"/, "nút ARCHIVED không được mở checklist với action 'publish'");
});

test("R-save: save loop (Sửa HTML/CSS → Lưu) → parent refresh đúng danh sách (onSaved KHÔNG đóng editor, loadVersions(editing.id)) (regression #6)", () => {
  const usage = libraryCode.match(/<DraftVersionEditorModal[\s\S]*?\/>/)?.[0] ?? "";
  assert.ok(usage, "không thấy usage DraftVersionEditorModal");
  const onSavedBody = usage.match(/onSaved=\{\(versionId\) => \{([\s\S]*?)\}\}/)?.[1] ?? "";
  assert.match(onSavedBody, /loadVersions\(editing\.id\)/, "mỗi lần Save phải refresh danh sách phiên bản (checklist sau đó dùng object MỚI)");
  assert.doesNotMatch(onSavedBody, /setEditDraftVersion\(null\)/, "Save không được đóng editor (vòng sửa → lưu nhiều lần)");

  const loadVersions = sliceHandler(libraryCode, "loadVersions");
  assert.match(loadVersions, /`\/api\/document-merge\/templates\/\$\{templateId\}\/versions`/);
  assert.match(loadVersions, /setVersions\(Array\.isArray\(data\) \? data : \[\]\)/);
});

/* ==================================================================== *\
 * PART 2 — BEHAVIOR: v15-like DRAFT trên service THẬT + fake-drizzle
 * ==================================================================== */

type VRow = {
  id: string;
  templateId: string;
  version: number;
  status: string;
  htmlBody: string | null;
  printCss: string | null;
  sourceDocxName: string | null;
  retentionYears: number | null;
  mappingSnapshot: Record<string, unknown>[];
  createdBy: string;
  publishedAt: Date | null;
  archivedAt: Date | null;
  supersededBy: number | null;
};

type VersionModule = {
  createTemplateVersion: (templateId: string, createdBy: string, input: { htmlBody: string; printCss?: string | null; retentionYears?: number | null }) => Promise<VRow>;
  updateTemplateVersionDraft: (templateId: string, versionId: string, input: { htmlBody: string; printCss?: string | null }) => Promise<VRow>;
  publishTemplateVersion: (templateId: string, versionId: string, createdBy: string) => Promise<VRow>;
};

const SCHEMA_STUB = {
  mergeTemplates: makeTable("merge_templates"),
  mergeTemplateFields: makeTable("merge_template_fields"),
  mergeTemplateVersions: makeTable("merge_template_versions"),
  documentHistory: makeTable("document_history"),
};

async function loadVersionsModule(db: FakeDb): Promise<VersionModule> {
  const mod = await loadModule(new URL("./template-versions.ts", import.meta.url), {
    stubs: {
      "drizzle-orm": drizzleStub,
      "@/db": { db },
      "@/db/schema": SCHEMA_STUB,
      "./placeholder-extractor.ts": {
        extractUniquePlaceholders: (content: string) => {
          const unique = new Set<string>();
          for (const m of content.matchAll(/<<\s*([^>]+?)\s*>>|\{\{\s*([^{}]+?)\s*\}\}/g)) {
            const name = (m[1] ?? m[2] ?? "").trim();
            if (name) unique.add(name);
          }
          return Array.from(unique).sort();
        },
      },
      "./html-renderer.ts": {
        DEFAULT_PAGE_MARGINS: { topMm: 10, bottomMm: 10, leftMm: 12, rightMm: 12 },
      },
    },
  });
  return mod as unknown as VersionModule;
}

type LiveField = {
  templateId: string;
  placeholder: string;
  sourceType: string;
  sourceEntity: string | null;
  sourceField: string | null;
  sourcePath: string | null;
  optionValue: string | null;
  formatType: string | null;
  fallbackValue: string | null;
  isRequired: boolean;
  isOrphaned: boolean;
};

const FIELD_HO_TEN: LiveField = { templateId: "tpl-1", placeholder: "Ho_ten", sourceType: "CORE_FIELD", sourceEntity: null, sourceField: null, sourcePath: "fullName", optionValue: null, formatType: "RAW", fallbackValue: null, isRequired: true, isOrphaned: false };
const FIELD_NGAY_SINH = { templateId: "tpl-1", placeholder: "Ngay_sinh", sourceType: "CORE_FIELD", sourceEntity: null, sourceField: null, sourcePath: "birthDate", optionValue: null, formatType: "DATE_DDMMYYYY", fallbackValue: null, isRequired: false, isOrphaned: false };
const FIELD_ORPHAN = { templateId: "tpl-1", placeholder: "Phantom_x", sourceType: "CORE_FIELD", sourceEntity: null, sourceField: null, sourcePath: "x", optionValue: null, formatType: "RAW", fallbackValue: null, isRequired: false, isOrphaned: true };

/**
 * In-memory fake DB stateful cho cả vòng đời: create → save xN → publish.
 * Giả lập đúng semantics WHERE của service (status guard trong update,
 * filter isOrphaned=false trong select fields).
 */
function makeV15Db(opts: { liveFields?: LiveField[]; previousPublished?: VRow } = {}) {
  const rows: Record<string, VRow> = {};
  if (opts.previousPublished) rows[opts.previousPublished.id] = opts.previousPublished;
  let nextVersion = 14;
  const liveFields = opts.liveFields ?? [FIELD_HO_TEN, FIELD_NGAY_SINH, FIELD_ORPHAN];

  const db = createFakeDb({
    respond: (call) => {
      if (call.root === "select") {
        if (call.table === "merge_template_versions") {
          const id = eqValue(call, "merge_template_versions.id");
          if (id !== undefined) return rows[id as string] ? [rows[id as string]] : [];
          const status = eqValue(call, "merge_template_versions.status");
          if (status !== undefined) return Object.values(rows).filter((r) => r.status === status);
          return Object.values(rows).map((r) => ({ version: r.version }));
        }
        if (call.table === "merge_template_fields") {
          const orphan = eqValue(call, "merge_template_fields.isOrphaned");
          return orphan === false ? liveFields.filter((f) => f.isOrphaned !== true) : liveFields;
        }
        return [];
      }
      if (call.root === "insert" && call.table === "merge_template_versions") {
        const values = argOf(call, "values") as Record<string, unknown>;
        nextVersion += 1;
        const row: VRow = {
          id: `v${nextVersion}`,
          templateId: "tpl-1",
          version: nextVersion,
          status: String(values.status),
          htmlBody: (values.htmlBody as string | null) ?? null,
          printCss: (values.printCss as string | null) ?? null,
          sourceDocxName: null,
          retentionYears: (values.retentionYears as number | null) ?? null,
          mappingSnapshot: [],
          createdBy: String(values.createdBy),
          publishedAt: null,
          archivedAt: null,
          supersededBy: null,
        };
        rows[row.id] = row;
        return [row];
      }
      if (call.root === "update" && call.table === "merge_template_versions") {
        const id = eqValue(call, "merge_template_versions.id") as string;
        const setArgs = argOf(call, "set") as Record<string, unknown>;
        const row = rows[id];
        if (!row) return [];
        const statusGuard = eqValue(call, "merge_template_versions.status");
        if (statusGuard !== undefined && row.status !== statusGuard) return [];
        Object.assign(row, setArgs);
        return [row];
      }
      if (call.root === "update" && call.table === "merge_templates") {
        const setArgs = argOf(call, "set") as Record<string, unknown>;
        return [{ id: "tpl-1", currentPublishedVersion: setArgs.currentPublishedVersion }];
      }
      return undefined;
    },
  });

  return { db, rows };
}

test("B1: v15-like DRAFT hợp lệ — create → Save x2 (save loop) → Publish thành công; publish dùng HTML lần lưu CUỐI; snapshot freeze từ mapping hiện hành (regression #1/#6)", async () => {
  const prevPublished: VRow = {
    id: "v14", templateId: "tpl-1", version: 14, status: "PUBLISHED",
    htmlBody: "<div class=\"page\"><p><<Ho_ten>></p></div>", printCss: null, sourceDocxName: null,
    retentionYears: 3, mappingSnapshot: [], createdBy: "admin", publishedAt: new Date("2026-08-01T00:00:00Z"),
    archivedAt: null, supersededBy: null,
  };
  const { db, rows } = makeV15Db({ previousPublished: prevPublished });
  const mod = await loadVersionsModule(db);

  // 1) Tạo v15 DRAFT (html/css hợp lệ).
  const html1 = "<div class=\"page\"><p>Họ tên: <<Ho_ten>></p><p>Ngày sinh: <<Ngay_sinh>></p></div>";
  const created = await mod.createTemplateVersion("tpl-1", "operator", { htmlBody: html1, printCss: ".page { width: 210mm; }", retentionYears: 3 });
  assert.equal(created.version, 15, "version kế tiếp sau v14 phải là 15 (v15-like)");
  assert.equal(created.status, "DRAFT");

  // 2) Save loop: operator chỉnh HTML/CSS 2 lần liên tiếp trên CÙNG versionId.
  const html2 = "<div class=\"page\"><p>Họ tên: <<Ho_ten>></p><p>Ngày sinh: <<Ngay_sinh>></p><p>Phần bổ sung 1</p></div>";
  const html3 = "<div class=\"page\"><p>Họ tên: <<Ho_ten>></p><p>Ngày sinh: <<Ngay_sinh>></p><p>Phần bổ sung 2 — nội dung cuối</p></div>";
  const save1 = await mod.updateTemplateVersionDraft("tpl-1", created.id, { htmlBody: html2, printCss: ".page { width: 210mm; }" });
  assert.equal(save1.htmlBody, html2);
  const save2 = await mod.updateTemplateVersionDraft("tpl-1", created.id, { htmlBody: html3, printCss: ".page { width: 210mm; } .extra { margin-top: 4mm; }" });
  assert.equal(save2.htmlBody, html3);
  assert.equal(db.calls.filter((c) => c.root === "insert").length, 1, "save loop KHÔNG được tạo version mới");

  // 3) Publish — mapping hợp lệ (mọi placeholder trong HTML đều có mapping).
  const published = await mod.publishTemplateVersion("tpl-1", created.id, "operator");
  assert.equal(published.status, "PUBLISHED");
  assert.equal(published.version, 15);
  assert.equal(rows[created.id].htmlBody, html3, "publish phải validate XỬ LÝ ĐÚNG HTML của lần Save CUỐI");

  // Snapshot freeze từ mapping HIỆN HÀNH, chỉ non-orphaned.
  assert.deepEqual(
    published.mappingSnapshot.map((m) => String(m.placeholder)).sort(),
    ["Ho_ten", "Ngay_sinh"],
    "snapshot = live non-orphaned fields (orphan Phantom_x không vào snapshot)",
  );

  // Version PUBLISHED cũ (v14) bị ARCHIVED + superseded_by.
  assert.equal(rows.v14.status, "ARCHIVED");
  assert.equal(rows.v14.supersededBy, 15);

  // current_published_version cập nhật trong transaction.
  const tplUpdate = db.writesTo("merge_templates")[0];
  assert.ok(tplUpdate, "phải UPDATE merge_templates");
  assert.equal((argOf(tplUpdate, "set") as Record<string, unknown>).currentPublishedVersion, 15);
  assert.equal(db.transactions, 1, "publish phải chạy trong transaction");
});

test("B2: v15-like DRAFT có placeholder CHƯA MAPPING → publish bị chặn ngay, tên placeholder hiện cụ thể, ZERO writes (regression #2/#3 — đúng blocker checklist bây giờ hiển thị)", async () => {
  const { db, rows } = makeV15Db({ liveFields: [FIELD_HO_TEN, FIELD_ORPHAN] });
  const mod = await loadVersionsModule(db);

  const draft = await mod.createTemplateVersion("tpl-1", "operator", {
    htmlBody: "<div class=\"page\"><p><<Ho_ten>></p><p><<ABC>></p><p><<XYZ>></p></div>",
    printCss: null,
  });
  assert.equal(draft.status, "DRAFT");
  const writesBeforePublish = db.writes.length; // chỉ có insert tạo draft

  await assert.rejects(
    () => mod.publishTemplateVersion("tpl-1", draft.id, "operator"),
    (err: Error) => {
      assert.ok(err.message.includes("ABC") && err.message.includes("XYZ"), `lỗi phải liệt kê tên placeholder cụ thể, nhận: "${err.message}"`);
      assert.ok(err.message.includes("chưa được quét/mapping"), "lý do phải là UNMAPPED (placeholder chưa mapping)");
      return true;
    },
  );

  // FAIL CLOSED — publish thất bại coverage KHÔNG thêm lệnh ghi nào.
  assert.equal(db.writes.length, writesBeforePublish, "publish thất bại coverage KHÔNG được ghi thêm bất cứ gì");
  assert.equal(rows[draft.id].status, "DRAFT", "version vẫn là DRAFT sau khi bị chặn");
});

test("B2b: v15-like DRAFT có placeholder BẮT BUỘC không nguồn dữ liệu → REQUIRED_UNRESOLVABLE, zero writes", async () => {
  const requiredEmpty = { ...FIELD_HO_TEN, sourcePath: null, isRequired: true };
  const { db, rows } = makeV15Db({ liveFields: [requiredEmpty] });
  const mod = await loadVersionsModule(db);

  const draft = await mod.createTemplateVersion("tpl-1", "operator", { htmlBody: "<p><<Ho_ten>></p>", printCss: null });
  const writesBeforePublish = db.writes.length; // chỉ có insert tạo draft
  await assert.rejects(
    () => mod.publishTemplateVersion("tpl-1", draft.id, "operator"),
    (err: Error) => {
      assert.ok(err.message.includes("Ho_ten") && err.message.includes("bắt buộc"), `lỗi phải nêu placeholder bắt buộc chưa có nguồn, nhận: "${err.message}"`);
      return true;
    },
  );
  assert.equal(db.writes.length, writesBeforePublish, "publish thất bại coverage KHÔNG được ghi thêm bất cứ gì");
  assert.equal(rows[draft.id].status, "DRAFT");
});

test("B3: publish version ĐANG PUBLISHED là idempotent no-op — zero writes (regression #5: không có (re)publish có tác dụng)", async () => {
  const { db, rows } = makeV15Db();
  rows["v15"] = {
    id: "v15", templateId: "tpl-1", version: 15, status: "PUBLISHED",
    htmlBody: "<p><<Ho_ten>></p>", printCss: null, sourceDocxName: null, retentionYears: 3,
    mappingSnapshot: [{ placeholder: "Ho_ten" }], createdBy: "operator",
    publishedAt: new Date("2026-08-20T00:00:00Z"), archivedAt: null, supersededBy: null,
  };
  const mod = await loadVersionsModule(db);

  const result = await mod.publishTemplateVersion("tpl-1", "v15", "operator");
  assert.equal(result.status, "PUBLISHED");
  assert.equal(result.id, "v15");
  assert.equal(db.writes.length, 0, "no-op không được ghi bất cứ gì (không đổi snapshot/status/template)");
});
