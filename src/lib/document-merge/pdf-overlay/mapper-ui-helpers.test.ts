/**
 * Mapper UI helpers — tests (PR3). Chạy trực tiếp trên mapper-types.ts (thuần).
 * Bao phủ: readonly theo status version (published immutability UI), format số pt.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { formatPt, isVersionEditable, VERSION_STATUS_LABEL } from "../../../components/document-merge/pdf-mapper/mapper-types.ts";

test("isVersionEditable: chỉ DRAFT sửa được; PUBLISHED/ARCHIVED read-only", () => {
  assert.equal(isVersionEditable("DRAFT"), true);
  assert.equal(isVersionEditable("PUBLISHED"), false);
  assert.equal(isVersionEditable("ARCHIVED"), false);
});

test("VERSION_STATUS_LABEL đầy đủ 3 trạng thái", () => {
  assert.equal(VERSION_STATUS_LABEL.DRAFT, "DRAFT");
  assert.equal(VERSION_STATUS_LABEL.PUBLISHED, "PUBLISHED");
  assert.equal(VERSION_STATUS_LABEL.ARCHIVED, "ARCHIVED");
});

test("formatPt: làm tròn 2 chữ số, xử lý null/undefined/NaN", () => {
  assert.equal(formatPt(595.28), "595.28");
  assert.equal(formatPt(1.005), "1");
  assert.equal(formatPt(12.345), "12.35");
  assert.equal(formatPt(0), "0");
  assert.equal(formatPt(null), "—");
  assert.equal(formatPt(undefined), "—");
  assert.equal(formatPt(Number.NaN), "—");
});
