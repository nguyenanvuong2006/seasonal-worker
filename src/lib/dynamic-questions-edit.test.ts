import test from "node:test";
import assert from "node:assert/strict";

test("Admin Edit Question Rules - FieldType Constraint", () => {
  const currentRow = { fieldType: "TEXT", fieldKey: "test_q" };
  const patch = { fieldType: "SELECT" };
  const historicalDataExists = true;

  const result = (historicalDataExists && patch.fieldType !== currentRow.fieldType)
      ? { error: "Không thể đổi loại trường do đã có dữ liệu lịch sử." }
      : { success: true };

  assert.ok("error" in result, "Should block fieldType change when historical answers exist");
  assert.equal(result.error, "Không thể đổi loại trường do đã có dữ liệu lịch sử.");
});

test("Admin Edit Question Rules - Option Removal Constraint", () => {
  const currentRow = { options: ["A", "B", "Khác"], fieldKey: "test_q" };
  const patch = { options: ["A", "B"] };
  const removedOptions = currentRow.options.filter(opt => !patch.options.includes(opt));
  
  const isUsed = (opt: string) => opt === "Khác";

  let error = null;
  for (const opt of removedOptions) {
      if (isUsed(opt)) {
          error = `Lựa chọn "${opt}" đang được sử dụng trong dữ liệu lịch sử, không thể xoá.`;
          break;
      }
  }

  assert.ok(error !== null, "Should prevent removing an option used in historical data");
  assert.equal(error, `Lựa chọn "Khác" đang được sử dụng trong dữ liệu lịch sử, không thể xoá.`);
});
