/**
 * html-pipeline — render behavior cho placeholder "để trống có chủ đích" vs
 * placeholder thật sự thiếu mapping/dữ liệu (Phase 3/4 staging verification).
 *
 * Không cần DB/vm-sandbox: renderApplicantDocumentFromParts chỉ phụ thuộc
 * data-resolver + html-renderer + preview-merge (pure functions).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { renderApplicantDocumentFromParts, renderApplicantDocumentFromVersion } from "./html-pipeline.ts";
import type { MergeTemplateField } from "../../db/schema.ts";

function field(overrides: Partial<MergeTemplateField>): MergeTemplateField {
  return {
    id: "f1",
    templateId: "tpl-1",
    placeholder: "X",
    sourceType: "CORE_FIELD",
    sourceEntity: null,
    sourceField: null,
    sourcePath: null,
    optionValue: null,
    formatType: null,
    fallbackValue: null,
    isRequired: false,
    isOrphaned: false,
    isSuggested: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as MergeTemplateField;
}

test("renderApplicantDocumentFromParts: placeholder isRequired=false không mapping → render blank, valid=true", () => {
  const fields = [
    field({ placeholder: "Ho_ten", sourcePath: "fullName" }),
    field({ placeholder: "Ghi_chu_noi_bo", isRequired: false }), // để trống có chủ đích — không source/fallback
  ];
  const result = renderApplicantDocumentFromParts(
    "<p>Họ tên: <<Ho_ten>> - Ghi chú: [<<Ghi_chu_noi_bo>>]</p>",
    null,
    fields,
    { fullName: "Nguyễn Văn A" },
    {},
  );

  assert.equal(result.valid, true);
  assert.deepEqual(result.missingFields, []);
  assert.deepEqual(result.unreplaced, []);
  assert.match(result.html, /Họ tên: Nguyễn Văn A - Ghi chú: \[\]/);
});

test("renderApplicantDocumentFromParts: placeholder isRequired=true nhưng record không có dữ liệu → missingFields, valid=false", () => {
  const fields = [field({ placeholder: "So_CCCD", sourcePath: "cccd", isRequired: true })];
  const result = renderApplicantDocumentFromParts("<p><<So_CCCD>></p>", null, fields, {}, {});

  assert.equal(result.valid, false);
  assert.deepEqual(result.missingFields, ["So_CCCD"]);
  // Vẫn render (blank) — chặn ở bước publish/merge validation, không phải ở renderer.
  assert.deepEqual(result.unreplaced, []);
});

test("renderApplicantDocumentFromParts: placeholder trong HTML nhưng KHÔNG có field row nào → unreplaced (giữ nguyên <<...>>)", () => {
  const fields = [field({ placeholder: "Ho_ten", sourcePath: "fullName" })];
  const result = renderApplicantDocumentFromParts(
    "<p><<Ho_ten>> <<Chua_tung_quet>></p>",
    null,
    fields,
    { fullName: "A" },
    {},
  );

  assert.equal(result.valid, false);
  assert.deepEqual(result.unreplaced, ["Chua_tung_quet"]);
});

test("renderApplicantDocumentFromVersion: dùng htmlBody/printCss của version PUBLISHED", () => {
  const version = { htmlBody: "<p><<Ho_ten>></p>", printCss: "p{color:red}" };
  const fields = [field({ placeholder: "Ho_ten", sourcePath: "fullName" })];
  const result = renderApplicantDocumentFromVersion(version, fields, { fullName: "B" }, {});
  assert.match(result.html, /B/);
  assert.match(result.html, /color:red/);
});

test("renderApplicantDocumentFromVersion: version chưa có HTML → throw rõ ràng", () => {
  assert.throws(
    () => renderApplicantDocumentFromVersion({ htmlBody: null, printCss: null }, [], {}, {}),
    /HTML_TEMPLATE_EMPTY/,
  );
});
