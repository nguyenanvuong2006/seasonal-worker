/**
 * INCIDENT REGRESSION — normalizePreviewResponse().
 *
 * Sự cố production sau PR #91: payload CANONICAL_PUBLISHED_PREVIEW có
 * `unresolved` nhưng không có `unreplaced`; merge-workspace đọc
 * `preview.unreplaced.length` trong render → TypeError → unmount toàn bộ
 * route /admin/document-merge ("This page couldn't load").
 *
 * Từ nay MỌI payload Preview phải qua normalizer này trước khi vào React
 * state. Các test dưới đây ném vào normalizer đúng payload gây crash và mọi
 * biến thể hỏng (thiếu key, sai kiểu, null, mảng, chuỗi) — không input nào
 * được phép ném lỗi, và mọi field UI dereference phải đúng kiểu.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { normalizePreviewResponse } from "./preview-response.ts";

// Đúng shape payload production đã gây crash (canonical branch trước fix):
// có `unresolved`, KHÔNG có `unreplaced`.
const CRASHING_PRODUCTION_PAYLOAD = {
  mode: "CANONICAL_PUBLISHED_PREVIEW",
  renderedHtml: "<!DOCTYPE html><html><body><div class=\"page\">…</div></body></html>",
  templateId: "tpl-1",
  templateName: "MẪU ĐĂNG KÝ TẬP NGHỀ",
  templateKind: "A",
  templateVersion: 3,
  version: 3,
  versionStatus: "PUBLISHED",
  isPublishedCanonical: true,
  printCss: "body{}",
  engine: "HTML_PDF",
  applicationId: "app-1",
  recordId: "app-1",
  fullName: "Bùi Nguyễn Phương Vy",
  unresolved: [],
  missingFields: [],
  valid: true,
  pageCount: 6,
  renderer: "renderCanonicalDocument (shared Preview + HTML_PDF worker renderer)",
};

test("payload production từng gây crash → unreplaced LUÔN là mảng (không bao giờ undefined)", () => {
  const safe = normalizePreviewResponse(CRASHING_PRODUCTION_PAYLOAD);

  // Đây chính là hai biểu thức đã ném TypeError trong merge-workspace:
  assert.doesNotThrow(() => safe.unreplaced.length);
  assert.doesNotThrow(() => [...safe.missingFields, ...safe.unreplaced].join(", "));

  assert.deepEqual(safe.unreplaced, []);
  assert.deepEqual(safe.missingFields, []);
  assert.equal(safe.renderedHtml, CRASHING_PRODUCTION_PAYLOAD.renderedHtml);
  assert.equal(safe.templateVersion, 3);
  assert.equal(safe.versionStatus, "PUBLISHED");
  assert.equal(safe.isPublishedCanonical, true);
  assert.equal(safe.pageCount, 6);
  assert.equal(safe.valid, true);
});

test("canonical payload có unresolved KHÔNG rỗng → hợp nhất vào unreplaced để UI cảnh báo", () => {
  const safe = normalizePreviewResponse({
    ...CRASHING_PRODUCTION_PAYLOAD,
    unresolved: ["Dia_chi_tam_tru", "Ho_ten"],
  });
  assert.deepEqual(safe.unreplaced.sort(), ["Dia_chi_tam_tru", "Ho_ten"]);
});

test("payload legacy Google Docs (unreplaced, không unresolved) giữ nguyên hành vi", () => {
  const safe = normalizePreviewResponse({
    applicationId: "app-1",
    fullName: "A",
    cccd: "1",
    content: "PREVIEW",
    unreplaced: ["X"],
    missingFields: ["Y"],
    valid: false,
    dwClassification: "OLD",
    documentKind: "B",
  });
  assert.deepEqual(safe.unreplaced, ["X"]);
  assert.deepEqual(safe.missingFields, ["Y"]);
  assert.equal(safe.content, "PREVIEW");
  assert.equal(safe.dwClassification, "OLD");
  assert.equal(safe.documentKind, "B");
  assert.equal(safe.valid, false);
});

test("cả unreplaced lẫn unresolved cùng có mặt → hợp nhất, khử trùng lặp", () => {
  const safe = normalizePreviewResponse({ unreplaced: ["A", "B"], unresolved: ["B", "C"] });
  assert.deepEqual(safe.unreplaced.sort(), ["A", "B", "C"]);
});

test("mọi input hỏng đều KHÔNG ném lỗi và trả shape an toàn", () => {
  const badInputs: unknown[] = [
    null,
    undefined,
    "not json object",
    42,
    [],
    ["array"],
    {},
    { unreplaced: "not-an-array", missingFields: 7 },
    { unreplaced: [1, null, "ok"], missingFields: [{}, "m"] },
    { mappingSummary: "bogus" },
    { renderedHtml: 123, templateVersion: "three", pageCount: "six" },
  ];
  for (const input of badInputs) {
    const safe = normalizePreviewResponse(input);
    assert.ok(Array.isArray(safe.unreplaced), `unreplaced phải là mảng cho input: ${JSON.stringify(input)}`);
    assert.ok(Array.isArray(safe.missingFields), "missingFields phải là mảng");
    // Đây là biểu thức render thật của merge-workspace — không được ném:
    assert.doesNotThrow(() => [...safe.missingFields, ...safe.unreplaced].join(", "));
    assert.doesNotThrow(() => safe.templateName.length);
    assert.equal(typeof safe.valid, "boolean");
  }
});

test("mảng lẫn phần tử không phải string → chỉ giữ string (không đưa object vào JSX join)", () => {
  const safe = normalizePreviewResponse({ unreplaced: [1, null, "ok", {}], unresolved: [true, "x"] });
  assert.deepEqual(safe.unreplaced.sort(), ["ok", "x"]);
});

test("mappingSummary thiếu/sai kiểu → undefined hoặc số an toàn", () => {
  assert.equal(normalizePreviewResponse({}).mappingSummary, undefined);
  const safe = normalizePreviewResponse({ mappingSummary: { total: 49, mapped: "x", required: 3 } });
  assert.deepEqual(safe.mappingSummary, { total: 49, mapped: 0, required: 3, suggested: 0 });
});

test("templateVersion nhận từ `version` khi thiếu `templateVersion`", () => {
  assert.equal(normalizePreviewResponse({ version: 3 }).templateVersion, 3);
  assert.equal(normalizePreviewResponse({}).templateVersion, null);
});
