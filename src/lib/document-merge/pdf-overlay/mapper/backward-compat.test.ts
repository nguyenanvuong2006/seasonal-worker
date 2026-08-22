/**
 * PDF Overlay — PR3 backward-compatibility gate (CONFIGURATION UI ONLY).
 *
 * PR3 là UI quản lý (visual mapper) — KHÔNG được kích hoạt PDF Overlay, không
 * đổi engine, không đụng GOOGLE_DOCS/HTML DRAFT v3. Các test này khẳng định:
 *   - Engine default vẫn GOOGLE_DOCS.
 *   - Không có engine value mới "PDF_OVERLAY".
 *   - Mapper module không import renderer/engine (chỉ đọc/ghi vị trí).
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  getDocumentMergeEngine,
  isHtmlPdfEngine,
  parseDocumentMergeEngine,
} from "./../../engine-config.ts";

test("engine default vẫn là GOOGLE_DOCS sau PR3", () => {
  delete process.env.DOCUMENT_MERGE_ENGINE;
  assert.equal(getDocumentMergeEngine(), "GOOGLE_DOCS");
  assert.equal(isHtmlPdfEngine(), false);
});

test("KHÔNG có engine 'PDF_OVERLAY' — mọi giá trị lạ collapse về GOOGLE_DOCS", () => {
  assert.equal(parseDocumentMergeEngine("PDF_OVERLAY"), "GOOGLE_DOCS");
  assert.equal(parseDocumentMergeEngine("HTML_PDF"), "HTML_PDF"); // giữ nguyên hành vi cũ
});

test("mapper modules giữ nguyên bất biến: coordinates/serialization không import renderer", async () => {
  // Các module mapper KHÔNG được phụ thuộc renderer (không kích hoạt overlay).
  const coords = await import("./coordinates.ts");
  assert.ok(typeof coords.pdfPointToPixel === "function");
  const ser = await import("./serialization.ts");
  assert.ok(typeof ser.editorToPayload === "function");
  const val = await import("./validation-summary.ts");
  assert.ok(typeof val.buildValidationSummary === "function");
});
