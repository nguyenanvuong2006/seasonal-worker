/**
 * DRAFT EDITOR SAVE LOOP — regression tests cho workflow tối giản
 * "Sửa HTML/CSS" trên trang Document Merge → Template Versions:
 *
 *   [Sửa HTML/CSS] (chỉ DRAFT, ngay cạnh "Xem trước")
 *     → DraftVersionEditorModal nạp thẳng html_body/print_css của ĐÚNG
 *       versionId được chọn (không qua current_published_version, không tạo
 *       version mới)
 *     → HTML hiện tại / Print CSS hiện tại → Lưu bản nháp (PATCH)
 *     → Xem trước A4 (luôn khả dụng — render ĐÚNG nội dung đang soạn kể cả
 *       CHƯA Lưu/CHƯA Publish; ghi rõ chỉ GẦN ĐÚNG, PDF TEST mới là kết quả
 *       chuẩn)
 *     → LƯU THÀNH CÔNG KHÔNG ĐÓNG MODAL — sửa tiếp → Lưu lại nhiều lần
 *     → Hủy không ghi DB.
 *
 * PUBLISHED/ARCHIVED: KHÔNG có nút sửa; có "Xem HTML/CSS" chỉ đọc
 * (VersionHtmlViewerModal — thuần presentational, zero fetch).
 *
 * Theo khuôn mẫu draft-editor-modal-wiring.test.ts (repo không có jsdom):
 * test đọc MÃ NGUỒN production thật và khóa các fact wiring. Bất biến tầng
 * service/route (DRAFT-only, chỉ UPDATE html/css, không đụng mapping/
 * PUBLISHED/ARCHIVED/current_published_version, lưu lặp không tạo version)
 * đã được khóa bằng fake-drizzle ở template-version-edit.test.ts (gồm test
 * "lưu NHIỀU LẦN").
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const MODAL_PATH = "src/components/document-merge/version-clone-modals.tsx";
const LIBRARY_PATH = "src/components/document-merge/template-library.tsx";
const modalFile = readFileSync(new URL(`../../../${MODAL_PATH}`, import.meta.url), "utf8");
const libraryFile = readFileSync(new URL(`../../../${LIBRARY_PATH}`, import.meta.url), "utf8");

function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Lát ĐÚNG thân DraftVersionEditorModal (từ khai báo tới modal kế tiếp). */
function sliceDraftEditorModal(source: string): { code: string; raw: string } {
  const startMarker = "export function DraftVersionEditorModal(";
  const endMarker = "\nfunction ApplyToDraftConfirmModal(";
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start !== -1, "DraftVersionEditorModal not found — has it been renamed/moved?");
  assert.ok(end !== -1 && end > start, "ApplyToDraftConfirmModal boundary not found");
  const raw = source.slice(start, end);
  return { raw, code: stripComments(raw) };
}

/** Trích một handler `const NAME = ... => {` tới dòng đóng `  };` cùng cấp. */
function sliceHandler(code: string, name: string): string {
  const match = code.match(new RegExp(`const ${name} = (?:async )?\\(\\) => \\{[\\s\\S]*?\\n  \\};`));
  assert.ok(match, `handler ${name} not found`);
  return match[0];
}

const editor = sliceDraftEditorModal(modalFile);
const libraryCode = stripComments(libraryFile);

/* ==================================================================== *
 * 1. NÚT "SỬA HTML/CSS" — chỉ DRAFT, ngay cạnh "Xem trước"
 * ==================================================================== */

test("nút 'Sửa HTML/CSS' chỉ render cho version DRAFT (guard status bọc ngay trong JSX của card)", () => {
  const labelIdx = libraryCode.indexOf("Sửa HTML/CSS\n                              </button>");
  assert.ok(labelIdx !== -1, "không thấy nút 'Sửa HTML/CSS' trên card phiên bản");
  const before = libraryCode.slice(Math.max(0, labelIdx - 1600), labelIdx);
  assert.match(
    before,
    /\{version\.status === "DRAFT" && \(/,
    "nút sửa phải nằm trong nhánh {version.status === \"DRAFT\" && (…)} — PUBLISHED/ARCHIVED không được có nút sửa",
  );
});

test("nút 'Sửa HTML/CSS' là nút DUY NHẤT của loại này và nằm NGAY SAU nút 'Xem trước'", () => {
  const previewIdx = libraryCode.indexOf("Xem trước\n                            </button>");
  const editIdx = libraryCode.indexOf("Sửa HTML/CSS\n                              </button>");
  assert.ok(previewIdx !== -1, "không thấy nút 'Xem trước'");
  assert.ok(editIdx !== -1, "không thấy nút 'Sửa HTML/CSS'");
  assert.ok(editIdx > previewIdx, "nút sửa phải đứng sau nút Xem trước");
  const between = libraryCode.slice(previewIdx, editIdx);
  // Chỉ được có ĐÚNG MỘT nút trong khoảng này — chính là nút 'Sửa HTML/CSS'
  // (không nút nào khác chèn vào giữa hai nút).
  assert.equal((between.match(/<button/g) ?? []).length, 1, "giữa Xem trước và Sửa HTML/CSS không được có nút khác chèn vào");
});

/* ==================================================================== *
 * 2. SAVE — PATCH ĐÚNG versionId, KHÔNG tạo version mới
 * ==================================================================== */

test("save(): PATCH đúng endpoint version detail dựng từ templateId + version.id của chính version đang mở", () => {
  const save = sliceHandler(editor.code, "save");
  assert.match(
    save,
    /fetch\(\s*`\/api\/document-merge\/templates\/\$\{templateId\}\/versions\/\$\{version\.id\}`/,
    "URL phải là /versions/${version.id} — versionId tường minh đang mở, không phải version khác",
  );
  assert.match(save, /method:\s*"PATCH"/, "Lưu bản nháp phải là PATCH (UPDATE tại chỗ), không phải POST");
});

test("save(): KHÔNG BAO GIỜ tạo version mới — chỉ một fetch, không POST, body chỉ có htmlBody/printCss", () => {
  const save = sliceHandler(editor.code, "save");
  const fetches = save.match(/fetch\(/g) ?? [];
  assert.equal(fetches.length, 1, "save() chỉ được gọi đúng một endpoint");
  assert.doesNotMatch(save, /method:\s*"POST"/, "POST /versions là tạo version MỚI — nghiêm cấm trong save()");
  assert.doesNotMatch(save, /\/versions`/, "không được đụng collection /versions (tạo mới)");
  // Body chỉ đụng nội dung — mapping_snapshot/publishedAt/current_published_version
  // không bao giờ nằm trong request.
  assert.match(save, /body:\s*JSON\.stringify\(\{\s*htmlBody:\s*html,\s*printCss:\s*css \|\| null\s*\}\)/);
  assert.doesNotMatch(save, /mappingSnapshot|mapping_snapshot|currentPublishedVersion|current_published_version/);
});

/* ==================================================================== *
 * 3. SAVE THÀNH CÔNG → GIỮ MODAL MỞ, LƯU LẠI NHIỀU LẦN ĐƯỢC
 * ==================================================================== */

test("save() thành công: nâng baseline lên đúng nội dung vừa ghi + báo 'đã lưu' + onSaved — KHÔNG đóng modal", () => {
  const save = sliceHandler(editor.code, "save");
  assert.match(save, /setBaselineHtml\(html\);/, "baseline HTML phải được nâng lên nội dung vừa lưu");
  assert.match(save, /setBaselineCss\(css\);/, "baseline CSS phải được nâng lên nội dung vừa lưu");
  assert.match(save, /setSavedNotice\(/, "phải có thông báo lưu thành công (modal vẫn mở)");
  assert.match(save, /onSaved\(version\.id\);/);
  // Không đường lối nào trong save() tự đóng modal: đóng chỉ xảy ra qua
  // Hủy/X (có dirty-check) — save luôn giữ editor mở để lưu tiếp.
  assert.doesNotMatch(save, /onCancel\(|requestClose\(/, "save() không được tự đóng modal");
});

test("baseline khởi tạo từ ĐÚNG version prop được mở (nội dung versionId được chọn, không phải current_published_version)", () => {
  assert.match(editor.code, /const \[baselineHtml, setBaselineHtml\] = useState\(version\.htmlBody \?\? ""\);/);
  assert.match(editor.code, /const \[baselineCss, setBaselineCss\] = useState\(version\.printCss \?\? ""\);/);
  assert.doesNotMatch(editor.code, /current_published_version/i);
  assert.doesNotMatch(editor.code, /currentPublishedVersion/);
});

test("parent (template-library) GIỮ EDITOR MỞ sau onSaved — chỉ refresh danh sách + highlight", () => {
  const usageMatch = libraryCode.match(/<DraftVersionEditorModal[\s\S]*?\/>/);
  assert.ok(usageMatch, "không thấy usage DraftVersionEditorModal trong template-library");
  const usage = stripComments(usageMatch[0]);
  const onSavedBody = usage.match(/onSaved=\{\(versionId\) => \{([\s\S]*?)\}\}/)?.[1] ?? "";
  assert.ok(onSavedBody.length > 0, "onSaved phải có thân hàm");
  assert.doesNotMatch(
    onSavedBody,
    /setEditDraftVersion\(null\)/,
    "onSaved KHÔNG được đóng editor — lưu xong phải giữ modal mở để lưu tiếp nhiều lần",
  );
  assert.match(onSavedBody, /loadVersions\(editing\.id\)/, "onSaved vẫn refresh danh sách phiên bản phía sau");
  assert.doesNotMatch(onSavedBody, /fetch\(/, "onSaved không tự gọi API nào khác ngoài refresh danh sách");
  // Hủy/đóng qua onCancel — đó là đường DUY NHẤT setEditDraftVersion(null).
  assert.match(usage, /onCancel=\{\(\) => setEditDraftVersion\(null\)\}/);
});

test("lưu lặp: dirty-check phải tính từ baseline STATE (được save nâng lên), không phải prop đóng băng lúc mở", () => {
  // Nếu dirty derive từ prop thì sau lần lưu đầu modal sẽ "dirty" ảo vĩnh
  // viễn — không thể sửa tiếp → Lưu lại sạch được.
  assert.match(
    editor.code,
    /isDraftEditorDirty\(\{\s*html,\s*css,\s*rawPaste,\s*baselineHtml,\s*baselineCss,\s*baselineRawPaste\s*\}\)/,
  );
  // apply-html (mode dán HTML hoàn chỉnh) cũng phải nâng baseline theo nội
  // dung đã normalize để cùng tham gia vòng lặp.
  const apply = sliceHandler(editor.code, "applyToDraft");
  assert.match(apply, /setBaselineHtml\(normalized\.htmlBody\);/);
  assert.match(apply, /setBaselineCss\(normalizedPrintCss\);/);
  assert.match(apply, /onSaved\(version\.id\);/);
  assert.doesNotMatch(apply, /requestClose\(/, "apply thành công không được tự đóng modal");
});

/* ==================================================================== *
 * 4. HỦY / KHÔI PHỤC — KHÔNG GHI DB
 * ==================================================================== */

test("Hủy (X và nút Hủy) KHÔNG ghi DB: requestClose thuần local; parent onCancel chỉ unmount, không fetch", () => {
  const requestClose = sliceHandler(editor.code, "requestClose");
  assert.doesNotMatch(requestClose, /fetch\(/, "đóng modal không được gọi API nào");
  assert.match(requestClose, /onCancel\(\);/);
  const restore = sliceHandler(editor.code, "restoreSavedContent");
  assert.doesNotMatch(restore, /fetch\(/, "'Khôi phục nội dung đã lưu' là thao tác thuần local");
  const usage = libraryCode.match(/<DraftVersionEditorModal[\s\S]*?\/>/)?.[0] ?? "";
  const onCancelBody = usage.match(/onCancel=\{\(\) => setEditDraftVersion\(null\)\}/)?.[0] ?? "";
  assert.match(onCancelBody, /setEditDraftVersion\(null\)/);
  assert.doesNotMatch(onCancelBody, /fetch\(/, "Hủy không được gọi API nào (Cancel không write DB)");
});

/* ==================================================================== *
 * 5. XEM TRƯỚC A4 — LUÔN KHẢ DỤNG, ĐÚNG NỘI DUNG ĐANG SOẠN
 * ==================================================================== */

test("'Xem trước A4' KHÔNG bị gate sau 'Phân tích thay đổi' và đứng TRƯỚC khối phân tích", () => {
  const headerIdx = editor.code.indexOf("Xem trước A4 (chưa lưu)");
  const analyzeIdx = editor.code.indexOf("Phân tích thay đổi (chỉ đọc)");
  assert.ok(headerIdx !== -1, "không thấy section Xem trước A4");
  assert.ok(analyzeIdx !== -1);
  assert.ok(headerIdx < analyzeIdx, "preview phải đứng trước (hoặc ngang hàng) khối phân tích tuỳ chọn");
  const preceding = editor.code.slice(Math.max(0, headerIdx - 300), headerIdx);
  assert.doesNotMatch(
    preceding,
    /analyzeResult\s*&&/,
    "preview không được bọc trong {analyzeResult && (…)} — phải luôn khả dụng",
  );
  // Nút bấm luôn render (label xuất hiện đúng một lần trong section).
  assert.match(editor.code, /: "Xem trước A4"\}/);
});

test("'Xem trước A4' render ĐÚNG HTML/CSS vừa chỉnh (kể cả chưa Lưu/chưa Publish) lên ĐÚNG versionId, mô phỏng A4", () => {
  const runPreview = sliceHandler(editor.code, "runUnsavedPreview");
  assert.match(
    runPreview,
    /fetch\(\s*`\/api\/document-merge\/templates\/\$\{templateId\}\/versions\/\$\{version\.id\}\/unsaved-preview`/,
    "preview phải bắn đúng versionId đang mở",
  );
  assert.match(runPreview, /rawHtml:\s*effectiveHtml/, "phải dùng ĐÚNG nội dung đang soạn (chưa lưu vẫn preview được)");
  assert.match(runPreview, /explicitCss:\s*effectiveCss/);
  // Mô phỏng trang A4 + cảnh báo "gần đúng vs PDF TEST chuẩn".
  assert.match(editor.code, /decoratePreviewForA4Sheets\(/, "preview phải đóng khung trang A4");
  assert.match(editor.raw, /GẦN ĐÚNG/, "phải ghi rõ preview chỉ GẦN ĐÚNG");
  assert.match(editor.raw, /KẾT QUẢ CHUẨN/, "phải ghi rõ PDF TEST mới là KẾT QUẢ CHUẨN");
  assert.match(editor.raw, /In \/ Lưu PDF TEST/, "phải có đường mở PDF TEST");
});

/* ==================================================================== *
 * 6. PUBLISHED/ARCHIVED — KHÔNG nút sửa, CÓ "Xem HTML/CSS" chỉ đọc
 * ==================================================================== */

test("PUBLISHED/ARCHIVED: có nút 'Xem HTML/CSS' (guard !DRAFT) — viewer thuần đọc, không fetch/không lưu", () => {
  const guardIdx = libraryCode.indexOf('{version.status !== "DRAFT" && (');
  assert.ok(guardIdx !== -1, "không thấy guard !DRAFT cho viewer");
  const window = libraryCode.slice(guardIdx, guardIdx + 1200);
  assert.match(window, /Xem HTML\/CSS/, "guard !DRAFT phải bọc nút 'Xem HTML/CSS'");
  assert.match(window, /setViewHtmlVersion\(/, "nút viewer phải mở VersionHtmlViewerModal với đúng version");

  const startMarker = "export function VersionHtmlViewerModal(";
  const start = modalFile.indexOf(startMarker);
  assert.ok(start !== -1, "VersionHtmlViewerModal not found");
  const viewerCode = stripComments(modalFile.slice(start));
  assert.doesNotMatch(viewerCode, /fetch\(/, "viewer KHÔNG được gọi API nào");
  assert.doesNotMatch(viewerCode, /onSaved|method:\s*"(PATCH|POST|PUT|DELETE)"/, "viewer KHÔNG được ghi bất cứ gì");
  assert.match(viewerCode, /readOnly/, "textarea phải readOnly");
  assert.match(viewerCode, /HTML hiện tại/, "label HTML hiện tại");
  assert.match(viewerCode, /Print CSS hiện tại/, "label Print CSS hiện tại");
});

/* ==================================================================== *
 * 7. ĐỦ 6 YÊU CẦU UI CỦA MODAL
 * ==================================================================== */

test("modal đủ: 'HTML hiện tại', 'Print CSS hiện tại', 'Lưu bản nháp', 'Xem trước A4', 'Khôi phục nội dung đã lưu', 'Hủy'", () => {
  assert.match(editor.raw, /HTML hiện tại/);
  assert.match(editor.raw, /Print CSS hiện tại/);
  assert.match(editor.raw, /: "Lưu bản nháp"\}/);
  assert.match(editor.raw, /Xem trước A4/);
  assert.match(editor.raw, /Khôi phục nội dung đã lưu/);
  assert.match(editor.raw, /\n\s+Hủy\s*\n/);
});
