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
import type { TemplateContract } from "./template-contract.ts";

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

test("renderApplicantDocumentFromParts: canonical contract catches required data before a worker can render PDF", () => {
  const contract: TemplateContract = {
    key: "test",
    name: "Test",
    logicalPageCount: 1,
    fields: [
      { key: "Ho_ten", label: "Họ tên", valueKind: "text", required: true, sourcePath: "fullName" },
      { key: "Lua_chon_Co", label: "Có", valueKind: "checkbox", required: true, sourcePath: "choice", optionValue: "Có" },
    ],
  };
  const result = renderApplicantDocumentFromParts(
    "<p>{{Ho_ten}} <span class=\"chk\">{{Lua_chon_Co}}</span></p>",
    null,
    [
      field({ placeholder: "Ho_ten", sourcePath: "fullName", isRequired: false }),
      field({ placeholder: "Lua_chon_Co", sourceType: "CHECKBOX_OPTION", sourcePath: "choice", optionValue: "Có", isRequired: false }),
    ],
    { choice: "Không" },
    {},
    { contract },
  );

  assert.equal(result.valid, false);
  assert.deepEqual(result.missingFields, ["Ho_ten"]);
  assert.match(result.html, /☐/);
  assert.equal(result.unreplaced.length, 0);
});

test("renderApplicantDocumentFromVersion DELEGATE tới đúng renderApplicantDocumentFromParts (worker HTML_PDF path)", () => {
  const version = { htmlBody: "<p><<Ho_ten>> - <<Ghi_chu_noi_bo>></p>", printCss: "p{color:red}" };
  const fields = [
    field({ placeholder: "Ho_ten", sourcePath: "fullName" }),
    field({ placeholder: "Ghi_chu_noi_bo", isRequired: false }),
  ];
  const recordData = { fullName: "Bùi Nguyễn Phương Vy" };
  const context = { currentDate: new Date(), mergeIndex: 1, mergeCount: 1 };

  const fromVersion = renderApplicantDocumentFromVersion(version, fields, recordData, context);
  const fromParts = renderApplicantDocumentFromParts(version.htmlBody, version.printCss, fields, recordData, context);

  assert.deepEqual(fromVersion, fromParts, "nhánh version phải cho kết quả GIỐNG HỆT worker path (renderApplicantDocumentFromParts)");
  assert.match(fromVersion.html, /Bùi Nguyễn Phương Vy/);
  assert.match(fromVersion.html, /color:red/);
});
