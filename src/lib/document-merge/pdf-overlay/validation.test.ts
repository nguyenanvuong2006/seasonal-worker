/**
 * Field-position validation — tests (PR2). Chạy trực tiếp trên validation.ts
 * (module thuần, không alias/DB). Bao phủ: geometry, page number, type,
 * font size, alignment, overflow, checkbox, required/static, duplicate keys.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  findDuplicateKeys,
  positionKeyOf,
  validatePositionInput,
  type PositionValidationInput,
} from "./validation.ts";
import { A4_WIDTH_PT, A4_HEIGHT_PT } from "./geometry.ts";
import type { PageGeometry } from "./types.ts";

const A4: PageGeometry[] = [
  { pageNumber: 1, width: A4_WIDTH_PT, height: A4_HEIGHT_PT, rotation: 0 },
  { pageNumber: 2, width: A4_WIDTH_PT, height: A4_HEIGHT_PT, rotation: 0 },
];

function validInput(overrides: Partial<PositionValidationInput> = {}): PositionValidationInput {
  return {
    placeholder: "Ho_ten",
    pageNumber: 1,
    x: 50,
    y: 700,
    width: 200,
    height: 20,
    type: "TEXT",
    ...overrides,
  };
}

test("valid input → không có lỗi", () => {
  assert.deepEqual(validatePositionInput(validInput(), A4), []);
});

test("placeholder bắt buộc + giới hạn 255 ký tự", () => {
  assert.ok(validatePositionInput(validInput({ placeholder: "" }), A4).length > 0);
  assert.ok(validatePositionInput(validInput({ placeholder: "   " }), A4).length > 0);
  assert.ok(validatePositionInput(validInput({ placeholder: "x".repeat(256) }), A4).length > 0);
});

test("page number phải là số nguyên ≥ 1 và tồn tại trong template", () => {
  assert.ok(validatePositionInput(validInput({ pageNumber: 0 }), A4).length > 0);
  assert.ok(validatePositionInput(validInput({ pageNumber: 1.5 }), A4).length > 0);
  assert.ok(validatePositionInput(validInput({ pageNumber: 3 }), A4).length > 0); // chỉ có 2 trang
  assert.deepEqual(validatePositionInput(validInput({ pageNumber: 2 }), A4), []);
});

test("geometry: box phải nằm trọn trong trang (invalid geometry)", () => {
  // width/height ≤ 0
  assert.ok(validatePositionInput(validInput({ width: 0 }), A4).length > 0);
  assert.ok(validatePositionInput(validInput({ height: -5 }), A4).length > 0);
  // x/y âm (vượt biên trái/dưới)
  assert.ok(validatePositionInput(validInput({ x: -1 }), A4).length > 0);
  assert.ok(validatePositionInput(validInput({ y: -1 }), A4).length > 0);
  // vượt biên phải/trên
  assert.ok(validatePositionInput(validInput({ x: A4_WIDTH_PT - 10, width: 50 }), A4).length > 0);
  assert.ok(validatePositionInput(validInput({ y: A4_HEIGHT_PT - 5, height: 20 }), A4).length > 0);
  // NaN
  assert.ok(validatePositionInput(validInput({ x: Number.NaN }), A4).length > 0);
});

test("rotation chỉ nhận 0/90/180/270", () => {
  assert.ok(validatePositionInput(validInput({ rotation: 45 }), A4).length > 0);
  assert.deepEqual(validatePositionInput(validInput({ rotation: 90 }), A4), []);
});

test("type phải là một trong các loại đã biết", () => {
  assert.ok(validatePositionInput(validInput({ type: "BOGUS" as never }), A4).length > 0);
  // TEXT/DATE/NUMBER/... không cần thêm rule; CHECKBOX/RADIO/STATIC_TEXT có rule riêng (test riêng).
  for (const type of ["TEXT", "MULTILINE_TEXT", "DATE", "NUMBER", "SIGNATURE_TEXT", "IMAGE"] as const) {
    assert.deepEqual(validatePositionInput(validInput({ type }), A4), []);
  }
});

test("font size: fontSize > 0, minFontSize ≤ fontSize, maxLines ≥ 1", () => {
  assert.ok(validatePositionInput(validInput({ fontSize: 0 }), A4).length > 0);
  assert.ok(validatePositionInput(validInput({ minFontSize: 0 }), A4).length > 0);
  assert.ok(validatePositionInput(validInput({ fontSize: 10, minFontSize: 12 }), A4).length > 0);
  assert.ok(validatePositionInput(validInput({ maxLines: 0 }), A4).length > 0);
  assert.deepEqual(validatePositionInput(validInput({ fontSize: 12, minFontSize: 10, maxLines: 2 }), A4), []);
});

test("align/valign/overflowPolicy/checkboxStyle phải hợp lệ", () => {
  assert.ok(validatePositionInput(validInput({ align: "justify" as never }), A4).length > 0);
  assert.ok(validatePositionInput(validInput({ valign: "baseline" as never }), A4).length > 0);
  assert.ok(validatePositionInput(validInput({ overflowPolicy: "WRAP" as never }), A4).length > 0);
  assert.ok(validatePositionInput(validInput({ checkboxStyle: "ROUND" as never }), A4).length > 0);
  assert.deepEqual(validatePositionInput(validInput({ align: "center", valign: "middle", overflowPolicy: "ELLIPSIZE" }), A4), []);
});

test("checkbox validation: yêu cầu optionValue + sourceKey, checkboxStyle hợp lệ", () => {
  const checkbox = validInput({ type: "CHECKBOX" });
  // thiếu optionValue + sourceKey
  const errs = validatePositionInput(checkbox, A4);
  assert.ok(errs.some((e) => e.includes("optionValue")));
  assert.ok(errs.some((e) => e.includes("sourceKey")));

  const ok = validatePositionInput(
    validInput({ type: "CHECKBOX", optionValue: "Co", sourceKey: "tien_an_tien_su", checkboxStyle: "SQUARE_X" }),
    A4,
  );
  assert.deepEqual(ok, []);
});

test("radio option yêu cầu optionValue + sourceKey (CIRCLE_DOT hợp lệ)", () => {
  assert.deepEqual(
    validatePositionInput(validInput({ type: "RADIO_OPTION", optionValue: "Nam", sourceKey: "gioi_tinh", checkboxStyle: "CIRCLE_DOT" }), A4),
    [],
  );
  assert.ok(validatePositionInput(validInput({ type: "RADIO_OPTION" }), A4).length > 0);
});

test("static text: yêu cầu staticText, không được required", () => {
  assert.ok(validatePositionInput(validInput({ type: "STATIC_TEXT" }), A4).length > 0);
  // staticText có + isRequired=false → hợp lệ
  assert.deepEqual(validatePositionInput(validInput({ type: "STATIC_TEXT", staticText: "X" }), A4), []);
  // staticText có + isRequired → lỗi
  assert.ok(validatePositionInput(validInput({ type: "STATIC_TEXT", staticText: "X", isRequired: true }), A4).length > 0);
  assert.deepEqual(validatePositionInput(validInput({ type: "STATIC_TEXT", staticText: "Mẫu số 01" }), A4), []);
});

test("staticText chỉ dùng cho STATIC_TEXT", () => {
  assert.ok(validatePositionInput(validInput({ type: "TEXT", staticText: "X" }), A4).length > 0);
});

test("required fields hợp lệ với type TEXT (isRequired=true)", () => {
  assert.deepEqual(validatePositionInput(validInput({ isRequired: true }), A4), []);
});

test("positionKeyOf + findDuplicateKeys", () => {
  const a = { placeholder: "Ho_ten", pageNumber: 1, x: 10, y: 20 };
  const b = { placeholder: "Ho_ten", pageNumber: 1, x: 10, y: 20 };
  const c = { placeholder: "Ho_ten", pageNumber: 2, x: 10, y: 20 };
  assert.equal(positionKeyOf(a), positionKeyOf(b));
  assert.notEqual(positionKeyOf(a), positionKeyOf(c));
  assert.deepEqual(findDuplicateKeys([a, b, c]), [positionKeyOf(a)]);
  assert.deepEqual(findDuplicateKeys([a, c]), []);
});
