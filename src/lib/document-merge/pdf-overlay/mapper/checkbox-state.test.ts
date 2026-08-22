/**
 * PDF Overlay — Visual Mapper checkbox-state tests (PR3).
 */

import test from "node:test";
import assert from "node:assert/strict";

import { checkboxStateFromValue, isSampleCheckboxChecked } from "./checkbox-state.ts";

test("checkboxStateFromValue: rỗng/false-like → false", () => {
  assert.equal(checkboxStateFromValue(""), false);
  assert.equal(checkboxStateFromValue("  "), false);
  assert.equal(checkboxStateFromValue("☐"), false);
  assert.equal(checkboxStateFromValue("0"), false);
  assert.equal(checkboxStateFromValue("false"), false);
  assert.equal(checkboxStateFromValue("no"), false);
});

test("checkboxStateFromValue: truthy → true", () => {
  assert.equal(checkboxStateFromValue("X"), true);
  assert.equal(checkboxStateFromValue("☒"), true);
  assert.equal(checkboxStateFromValue("Có"), true);
});

test("isSampleCheckboxChecked: option match", () => {
  assert.equal(isSampleCheckboxChecked("Đà Lạt", "Đà Lạt"), true);
  assert.equal(isSampleCheckboxChecked("Khác", "Đà Lạt"), false);
  assert.equal(isSampleCheckboxChecked("", "Đà Lạt"), false);
});
