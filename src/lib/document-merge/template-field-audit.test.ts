import test from "node:test";
import assert from "node:assert/strict";
import { auditTemplateFields, type TemplateFieldRow } from "./template-field-audit.ts";

function field(overrides: Partial<TemplateFieldRow> & { placeholder: string }): TemplateFieldRow {
  return { isRequired: false, isOrphaned: false, fallbackValue: null, ...overrides };
}

test("auditTemplateFields: clean when doc placeholders and fields match exactly", () => {
  const result = auditTemplateFields(
    ["Ho_ten", "Ngay_sinh"],
    [field({ placeholder: "Ho_ten" }), field({ placeholder: "Ngay_sinh" })],
  );
  assert.deepEqual(result.danglingInDoc, []);
  assert.deepEqual(result.staleInFields, []);
  assert.deepEqual(result.markedOrphanedButPresentInDoc, []);
  assert.equal(result.clean, true);
});

test("auditTemplateFields: danglingInDoc — placeholder trong doc không có field mapping", () => {
  const result = auditTemplateFields(["Ho_ten", "So_CCCD_moi"], [field({ placeholder: "Ho_ten" })]);
  assert.deepEqual(result.danglingInDoc, ["So_CCCD_moi"]);
  assert.equal(result.clean, false, "dangling placeholder là structural defect — phải fail clean");
});

test("auditTemplateFields: staleInFields — field mapping nhưng placeholder không còn trong doc, CHƯA đánh dấu isOrphaned", () => {
  const result = auditTemplateFields(["Ho_ten"], [field({ placeholder: "Ho_ten" }), field({ placeholder: "Truong_cu" })]);
  assert.deepEqual(result.staleInFields, ["Truong_cu"]);
  assert.equal(result.clean, false);
});

test("auditTemplateFields: field đã isOrphaned=true và thật sự không còn trong doc -> KHÔNG tính là staleInFields (đã biết, đã xử lý)", () => {
  const result = auditTemplateFields(
    ["Ho_ten"],
    [field({ placeholder: "Ho_ten" }), field({ placeholder: "Truong_cu", isOrphaned: true })],
  );
  assert.deepEqual(result.staleInFields, []);
  assert.equal(result.clean, true);
});

test("auditTemplateFields: markedOrphanedButPresentInDoc — field đánh dấu orphaned nhưng placeholder đã quay lại trong doc (dữ liệu isOrphaned lỗi thời)", () => {
  const result = auditTemplateFields(
    ["Ho_ten", "Truong_cu"],
    [field({ placeholder: "Ho_ten" }), field({ placeholder: "Truong_cu", isOrphaned: true })],
  );
  assert.deepEqual(result.markedOrphanedButPresentInDoc, ["Truong_cu"]);
  assert.equal(result.clean, false);
});

test("auditTemplateFields: requiredWithoutFallback — informational, KHÔNG làm clean=false (phụ thuộc dữ liệu candidate thật, không phải structural defect)", () => {
  const result = auditTemplateFields(
    ["Ho_ten", "Ma_so_thue"],
    [field({ placeholder: "Ho_ten" }), field({ placeholder: "Ma_so_thue", isRequired: true, fallbackValue: null })],
  );
  assert.deepEqual(result.requiredWithoutFallback, ["Ma_so_thue"]);
  assert.equal(result.clean, true, "requiredWithoutFallback không phải structural defect — chỉ là cảnh báo cần preflight với record thật để xác nhận");
});

test("auditTemplateFields: required field CÓ fallbackValue không bị liệt vào requiredWithoutFallback", () => {
  const result = auditTemplateFields(
    ["Ma_so_thue"],
    [field({ placeholder: "Ma_so_thue", isRequired: true, fallbackValue: "N/A" })],
  );
  assert.deepEqual(result.requiredWithoutFallback, []);
});

test("auditTemplateFields: empty-string fallbackValue được coi như KHÔNG có fallback", () => {
  const result = auditTemplateFields(
    ["Ma_so_thue"],
    [field({ placeholder: "Ma_so_thue", isRequired: true, fallbackValue: "   " })],
  );
  assert.deepEqual(result.requiredWithoutFallback, ["Ma_so_thue"]);
});
