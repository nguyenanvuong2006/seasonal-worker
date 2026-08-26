/**
 * H1 — TemplateChangeAnalyzer UI WIRING regression tests.
 *
 * Sự cố production: backend H1 (routes /ai-analyze + /ai-export, lib, 114
 * test) ĐÃ merge vào main nhưng operator không thấy UI — panel phân tích bị
 * giấu trong modal "Sửa HTML/CSS" chỉ mở cho version DRAFT. Các test này khóa
 * cứng bất biến ở MÃ NGUỒN (theo khuôn mẫu merge-workspace.test.ts — repo
 * không có jsdom runner cho component):
 *
 *   1. TemplateChangeAnalyzer render section "HỖ TRỢ CẬP NHẬT TEMPLATE BẰNG AI"
 *      với [Xuất Template cho AI], ô HTML, ô CSS bản in, [Phân tích thay đổi].
 *   2. template-library.tsx PHẢI render panel này trong mục "Phiên bản
 *      Template" — KHÔNG DRAFT-gate, KHÔNG feature flag.
 *   3. Nút [Phân tích thay đổi] gọi đúng endpoint POST .../ai-analyze với
 *      body { html, printCss, baseVersionId }.
 *   4. Nút [Xuất Template cho AI] gọi đúng endpoint GET .../ai-export.
 *   5. Component là H1 CHỈ ĐỌC thuần: không Apply, không lưu, không publish,
 *      không chạm route ghi DB (apply-html/unsaved-preview/publish/clone).
 *   6. Race guard: response phân tích cũ không được chạm state.
 *
 * Auth / zero-DB-writes / diff-engine (PR #102 buildTemplateDiff) / 49
 * placeholders / security / layout — đã được khóa ở:
 *   - src/app/api/document-merge/templates/ai-analyze-route.test.ts
 *   - src/app/api/document-merge/templates/ai-export-route.test.ts
 *   - src/lib/document-merge/ai-template-*.test.ts
 * (chạy cùng trong đợt gate H1 — không nhân bản ở đây.)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./template-change-analyzer.tsx", import.meta.url), "utf8");
const librarySource = readFileSync(new URL("./template-library.tsx", import.meta.url), "utf8");

test("1. TemplateChangeAnalyzer renders — section title + đủ 4 control theo spec", () => {
  assert.match(source, /export function TemplateChangeAnalyzer\(/, "phải export đúng tên component operator mong đợi");
  assert.match(source, /HỖ TRỢ CẬP NHẬT TEMPLATE BẰNG AI/, "phải có tiêu đề section đúng nguyên văn");
  assert.match(source, /Xuất Template cho AI/, "phải có nút [Xuất Template cho AI]");
  assert.match(source, /Phân tích thay đổi/, "phải có nút [Phân tích thay đổi]");
  // Ô HTML + ô CSS bản in (textarea riêng biệt, có label đúng spec).
  const textareas = source.match(/<textarea[\s\S]*?\/>/g) ?? [];
  assert.ok(textareas.length >= 2, "phải có ít nhất 2 textarea (HTML, CSS bản in)");
  assert.match(source, /CSS bản in/, "label ô CSS phải là 'CSS bản in'");
});

test("2a. template-library render TemplateChangeAnalyzer trong mục Phiên bản Template", () => {
  assert.match(librarySource, /import \{ TemplateChangeAnalyzer \}/, "phải import component");
  assert.match(librarySource, /<TemplateChangeAnalyzer\s+templateId=\{editing\.id\}\s+versions=\{versions\}\s*\/>/, "phải render panel với template + toàn bộ danh sách versions");
  // Panel phải nằm TRONG section "Phiên bản Template" (sau heading, trước hộp "Tạo version DRAFT mới").
  const headingIdx = librarySource.indexOf("Phiên bản Template (HTML/PDF Engine)");
  const analyzerIdx = librarySource.indexOf("<TemplateChangeAnalyzer");
  const createDraftIdx = librarySource.indexOf("Tạo version DRAFT mới");
  assert.ok(headingIdx >= 0 && analyzerIdx > headingIdx, "panel phải nằm sau heading Phiên bản Template");
  assert.ok(createDraftIdx > analyzerIdx, "panel phải nằm trước hộp Tạo version DRAFT mới");
});

test("2b. KHÔNG DRAFT-gate, KHÔNG feature flag — panel hiện khi có version", () => {
  // Không được bọc trong điều kiện status === "DRAFT" ở thư viện.
  const analyzerIdx = librarySource.indexOf("<TemplateChangeAnalyzer");
  const before = librarySource.slice(Math.max(0, analyzerIdx - 300), analyzerIdx);
  assert.doesNotMatch(before, /status === "DRAFT" && \(/, "panel không được giấu sau điều kiện DRAFT");
  assert.doesNotMatch(before, /version\.status === "DRAFT" && \(/, "panel không được giấu sau nút Sửa HTML/CSS");
  // Component tự render đầy đủ khi versions.length >= 1 (chỉ có state rỗng khi 0 version).
  assert.match(source, /versions\.length === 0/, "phải có nhánh hiển thị khi chưa có version");
  assert.doesNotMatch(source, /status === "DRAFT" &&/, "bên trong component không được ràng DRAFT");
  assert.doesNotMatch(source, /process\.env\.NEXT_PUBLIC_/, "không được giấu sau feature flag env");
});

test("3. Nút [Phân tích thay đổi] gọi đúng endpoint POST .../ai-analyze", () => {
  assert.match(source, /fetch\(`\/api\/document-merge\/templates\/\$\{templateId\}\/ai-analyze`/, "URL phải là /api/document-merge/templates/{id}/ai-analyze");
  assert.match(source, /method: "POST"/, "phải là POST");
  assert.match(source, /body: JSON\.stringify\(\{ html, printCss: css \|\| null, baseVersionId: effectiveBaseId \}\)/, "body phải gửi { html, printCss, baseVersionId } như contract route đã merge");
});

test("4. Nút [Xuất Template cho AI] gọi đúng endpoint GET .../ai-export", () => {
  assert.match(source, /`\/api\/document-merge\/templates\/\$\{templateId\}\/versions\/\$\{effectiveBaseId\}\/ai-export`/, "URL phải là /api/document-merge/templates/{id}/versions/{versionId}/ai-export");
  // GET thuần qua window.open — không fetch POST sang route export.
  assert.match(source, /window\.open\(/, "export phải mở tab mới GET ZIP");
  assert.doesNotMatch(source, /ai-export"?,\s*\{[^}]*method/, "không được POST/PUT vào ai-export");
});

test("5. H1 read-only thuần — không Apply / lưu / publish / route ghi DB nào khác", () => {
  // Cấm URL route ghi (dấu / đầu chỉ xuất hiện trong call thật — comment mô tả
  // "KHÔNG unsaved-preview" không có slash nên không bị trúng oan).
  assert.doesNotMatch(source, /\/apply-html/, "cấm gọi apply-html (H2)");
  assert.doesNotMatch(source, /\/unsaved-preview/, "cấm gọi unsaved-preview (H2)");
  assert.doesNotMatch(source, /\/unsaved-print/, "cấm gọi unsaved-print (H2)");
  assert.doesNotMatch(source, /\/publish|\/clone|\/activate|method: "(PUT|PATCH|DELETE)"/, "cấm mọi lệnh ghi");
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/, "kết quả phân tích phải là văn bản thuần");
  // KHÔNG button nào được mang hành vi ghi: Áp dụng / Lưu / Xuất bản / Publish.
  // (Câu chữ hướng dẫn "Áp dụng vào bản nháp" trong phần chữ thuần là được phép —
  // nó chỉ dẫn operator sang flow DRAFT riêng, không phải nút.)
  const buttons = source.match(/<button[\s\S]*?<\/button>/g) ?? [];
  assert.ok(buttons.length >= 2, "phải có đủ 2 nút spec: Xuất Template cho AI + Phân tích thay đổi");
  for (const [i, button] of buttons.entries()) {
    assert.doesNotMatch(button, /Áp dụng|Lưu|Xuất bản|Publish|publish/, `button #${i} không được là hành động ghi`);
  }
  assert.equal((source.match(/onClick=/g) ?? []).length, buttons.length, "mọi onClick đều thuộc các button đã kiểm");
  // Duy nhất một lệnh network ghi-đến-route-read-only: POST ai-analyze.
  const posts = source.match(/method: "POST"/g) ?? [];
  assert.equal(posts.length, 1, "chỉ đúng 1 POST — ai-analyze (route SELECT-only đã test riêng)");
});

test("6. Race guard — response phân tích cũ không chạm state", () => {
  assert.match(source, /analyzeSeq\.current/);
  assert.match(source, /const seq = \+\+analyzeSeq\.current/);
  assert.match(source, /if \(seq !== analyzeSeq\.current\) return/, "response lỗi/lạc hậu phải bị bỏ qua");
});
