/**
 * PR3 backward compatibility — mapper MUST NOT kích hoạt/đổi engine (PR3).
 * Chạy trên engine-config.ts thật: default vẫn GOOGLE_DOCS, không có giá trị
 * flag PDF_OVERLAY/HTML_PDF nào được mapper thêm vào. Merge production không đổi.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { getDocumentMergeEngine, parseDocumentMergeEngine } from "../engine-config.ts";

test("engine default = GOOGLE_DOCS sau PR3 (mapper không đổi DOCUMENT_MERGE_ENGINE)", () => {
  delete process.env.DOCUMENT_MERGE_ENGINE;
  assert.equal(getDocumentMergeEngine(), "GOOGLE_DOCS");
});

test("không có engine value mới nào — PDF_OVERLAY vẫn collapse về GOOGLE_DOCS (inert)", () => {
  assert.equal(parseDocumentMergeEngine("PDF_OVERLAY"), "GOOGLE_DOCS");
  assert.equal(parseDocumentMergeEngine(undefined), "GOOGLE_DOCS");
  assert.equal(parseDocumentMergeEngine(""), "GOOGLE_DOCS");
  assert.equal(parseDocumentMergeEngine("HTML_PDF"), "HTML_PDF"); // hành vi cũ giữ nguyên
});
