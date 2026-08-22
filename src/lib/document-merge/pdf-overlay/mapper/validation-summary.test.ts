/**
 * PDF Overlay — Visual Mapper validation summary tests (PR3).
 * Bao phủ: geometry, out-of-bounds, invalid page, missing required, duplicate,
 * overlap, checkbox config, overflow config, orphan mapping không chặn.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { buildValidationSummary, type PositionLike, type PageLayoutEntry, type FieldLike } from "./validation-summary.ts";

const PAGE: PageLayoutEntry = { pageNumber: 1, width: 595.28, height: 841.89, rotation: 0 };
const PAGE2: PageLayoutEntry = { pageNumber: 2, width: 595.28, height: 841.89, rotation: 0 };

function pos(overrides: Partial<PositionLike> = {}): PositionLike {
  return {
    placeholder: "Ho_ten",
    pageNumber: 1,
    x: 50,
    y: 700,
    width: 200,
    height: 20,
    type: "TEXT",
    fontSize: 10,
    align: "left",
    valign: "top",
    overflowPolicy: "FAIL",
    ...overrides,
  };
}

const FIELDS: FieldLike[] = [
  { placeholder: "Ho_ten", isRequired: true },
  { placeholder: "Ngay_sinh", isRequired: true },
  { placeholder: "Ghi_chu" },
];

test("hợp lệ: không lỗi, có info", () => {
  const s = buildValidationSummary([pos()], [PAGE], FIELDS);
  assert.equal(s.errors.length, 0);
  assert.ok(s.infos.length > 0);
  assert.equal(s.mappedPlaceholderCount, 1);
});

test("out-of-bounds: box vượt biên trang → error OUT_OF_BOUNDS", () => {
  const s = buildValidationSummary([pos({ x: 500, width: 200 })], [PAGE], FIELDS);
  assert.ok(s.errors.some((e) => e.includes("nằm ngoài trang")));
  assert.ok(s.errorCodes.includes("OUT_OF_BOUNDS"));
});

test("invalid page number: page 5 không tồn tại → error", () => {
  const s = buildValidationSummary([pos({ pageNumber: 5 })], [PAGE], FIELDS);
  assert.ok(s.errors.some((e) => e.includes("không tồn tại")));
  assert.ok(s.errorCodes.includes("INVALID_PAGE_NUMBER"));
});

test("geometry âm/không hợp lệ", () => {
  const s = buildValidationSummary([pos({ x: -5 })], [PAGE], FIELDS);
  assert.ok(s.errors.some((e) => e.includes("nằm ngoài")));
  const s2 = buildValidationSummary([pos({ width: 0 })], [PAGE], FIELDS);
  assert.ok(s2.errors.some((e) => e.includes("> 0")));
});

test("missing required mapping → warning (không chặn)", () => {
  const s = buildValidationSummary([pos()], [PAGE], FIELDS);
  assert.ok(s.warnings.some((w) => w.includes("Ngay_sinh") && w.includes("bắt buộc")));
  assert.ok(s.warnings.some((w) => w.includes("Ghi_chu") && w.includes("optional")));
  assert.equal(s.errors.length, 0);
});

test("duplicate natural key → error DUPLICATE", () => {
  const dup = { placeholder: "Ho_ten", pageNumber: 1, x: 100, y: 700 };
  const s = buildValidationSummary(
    [pos({ ...dup }), pos({ ...dup })],
    [PAGE],
    FIELDS,
  );
  assert.ok(s.errors.some((e) => e.includes("trùng khoá")));
  assert.ok(s.errorCodes.includes("DUPLICATE"));
});

test("overlap 2 position khác placeholder → warning (không chặn)", () => {
  const s = buildValidationSummary(
    [
      pos({ placeholder: "Ho_ten", x: 100, y: 100, width: 100, height: 20 }),
      pos({ placeholder: "Ngay_sinh", x: 120, y: 105, width: 100, height: 20 }),
    ],
    [PAGE],
    FIELDS,
  );
  assert.ok(s.warnings.some((w) => w.includes("chồng nhau")));
  assert.equal(s.errors.length, 0);
});

test("checkbox thiếu optionValue/sourceKey → error INVALID_CHECKBOX", () => {
  const s = buildValidationSummary(
    [pos({ type: "CHECKBOX", width: 15, height: 15, x: 100, y: 100, sourceKey: "Khu_vuc", optionValue: "Đà Lạt" })],
    [PAGE],
    FIELDS,
  );
  assert.equal(s.errors.length, 0);
  const bad = buildValidationSummary(
    [pos({ type: "CHECKBOX", width: 15, height: 15, x: 100, y: 100, optionValue: "" })],
    [PAGE],
    FIELDS,
  );
  assert.ok(bad.errors.some((e) => e.includes("optionValue")));
  assert.ok(bad.errorCodes.includes("INVALID_CHECKBOX"));
});

test("overflow config: minFontSize > fontSize → error", () => {
  const s = buildValidationSummary(
    [pos({ fontSize: 8, minFontSize: 12 })],
    [PAGE],
    FIELDS,
  );
  assert.ok(s.errors.some((e) => e.includes("minFontSize")));
  assert.ok(s.errorCodes.includes("OVERFLOW_CONFIG"));
});

test("STATIC_TEXT thiếu staticText → error", () => {
  const s = buildValidationSummary(
    [pos({ type: "STATIC_TEXT", staticText: "" })],
    [PAGE],
    FIELDS,
  );
  assert.ok(s.errors.some((e) => e.includes("staticText")));
});

test("2 orphan mapping KHÔNG chặn (warning, không error)", () => {
  const s = buildValidationSummary([], [PAGE], [
    { placeholder: "So_hop_dong_dich_vu_thue", isRequired: false, isOrphaned: true },
    { placeholder: "Ngay_hop_dong_dich_vu_thue", isRequired: false, isOrphaned: true },
  ]);
  assert.equal(s.errors.length, 0);
  assert.ok(s.warnings.some((w) => w.includes("So_hop_dong_dich_vu_thue")));
});

test("multi-page: position hợp lệ trên 2 trang", () => {
  const s = buildValidationSummary(
    [
      pos({ placeholder: "Ho_ten", pageNumber: 1 }),
      pos({ placeholder: "Ho_ten", pageNumber: 2, x: 60, y: 500 }),
    ],
    [PAGE, PAGE2],
    FIELDS,
  );
  assert.equal(s.errors.length, 0);
  assert.equal(s.mappedPlaceholderCount, 1); // cùng placeholder chỉ tính 1
});
