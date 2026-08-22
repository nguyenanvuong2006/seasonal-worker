/**
 * PDF Overlay — Visual Mapper field-type inference tests (PR3).
 */

import test from "node:test";
import assert from "node:assert/strict";

import { inferPositionType, fieldSourceKey } from "./field-type.ts";

test("inferPositionType: DATE từ format DATE_*", () => {
  assert.equal(inferPositionType("DATE_DDMMYYYY"), "DATE");
  assert.equal(inferPositionType("DATE_DD_MM_YYYY_HHMM"), "DATE");
});

test("inferPositionType: NUMBER/CURRENCY", () => {
  assert.equal(inferPositionType("NUMBER"), "NUMBER");
  assert.equal(inferPositionType("CURRENCY_VND"), "NUMBER");
  assert.equal(inferPositionType("VIETNAMESE_NUMBER_WORDS"), "NUMBER");
});

test("inferPositionType: CHECKBOX từ BOOLEAN_CHECKBOX", () => {
  assert.equal(inferPositionType("BOOLEAN_CHECKBOX"), "CHECKBOX");
});

test("inferPositionType: STATIC_TEXT từ sourceType", () => {
  assert.equal(inferPositionType(null, "STATIC_TEXT"), "STATIC_TEXT");
});

test("inferPositionType: default TEXT", () => {
  assert.equal(inferPositionType(null), "TEXT");
  assert.equal(inferPositionType("RAW"), "TEXT");
});

test("fieldSourceKey: ưu tiên sourceField → path → entity", () => {
  assert.equal(fieldSourceKey({ sourceField: "ho_ten", sourcePath: "a.b", sourceEntity: "e" }), "ho_ten");
  assert.equal(fieldSourceKey({ sourceField: null, sourcePath: "a.b", sourceEntity: "e" }), "a.b");
  assert.equal(fieldSourceKey({ sourceField: null, sourcePath: null, sourceEntity: "e" }), "e");
  assert.equal(fieldSourceKey({}), "");
});
