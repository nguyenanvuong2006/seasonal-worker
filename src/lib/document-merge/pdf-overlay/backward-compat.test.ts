/**
 * Backward compatibility — PR2 (management layer) MUST NOT kích hoạt PDF Overlay.
 *
 * Khẳng định lại (chạy trên engine-config.ts thật, không alias):
 *   - Engine default vẫn là GOOGLE_DOCS.
 *   - Không có giá trị flag nào làm engine chuyển sang PDF Overlay (inert).
 *   - PR2 không thêm "PDF_OVERLAY" vào union — mọi giá trị lạ đều collapse về
 *     GOOGLE_DOCS, nên tầng quản lý PDF Overlay không ảnh hưởng merge production.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  getDocumentMergeEngine,
  isHtmlPdfEngine,
  parseDocumentMergeEngine,
} from "./../engine-config.ts";

test("engine default = GOOGLE_DOCS (DOCUMENT_MERGE_ENGINE không set)", () => {
  delete process.env.DOCUMENT_MERGE_ENGINE;
  assert.equal(getDocumentMergeEngine(), "GOOGLE_DOCS");
  assert.equal(isHtmlPdfEngine(), false);
});

test("giá trị rỗng/undefined/lạ đều collapse về GOOGLE_DOCS", () => {
  assert.equal(parseDocumentMergeEngine(undefined), "GOOGLE_DOCS");
  assert.equal(parseDocumentMergeEngine(""), "GOOGLE_DOCS");
  assert.equal(parseDocumentMergeEngine("garbage"), "GOOGLE_DOCS");
});

test("PDF_OVERLAY KHÔNG phải giá trị engine hợp lệ → inert về GOOGLE_DOCS", () => {
  // Đây là điểm mấu chốt của "PDF Overlay inert sau PR2": không có nhánh engine
  // PDF_OVERLAY; merge production vẫn đi GOOGLE_DOCS.
  assert.equal(parseDocumentMergeEngine("PDF_OVERLAY"), "GOOGLE_DOCS");
});

test("HTML_PDF vẫn là giá trị duy nhất khác ngoài GOOGLE_DOCS (không đổi hành vi cũ)", () => {
  assert.equal(parseDocumentMergeEngine("HTML_PDF"), "HTML_PDF");
});
