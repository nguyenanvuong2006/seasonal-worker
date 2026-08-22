/**
 * PDF Overlay — Visual Mapper sample-values tests (PR3).
 * Đảm bảo preview có đủ minh hoạ tiếng Việt / date / address / checkbox / multiline.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_SAMPLE_VALUES,
  buildSampleValueSet,
  sampleValueFor,
  HIGHLIGHTED_PREVIEW_KEYS,
  SAMPLE_CHECKBOX_OPTIONS,
} from "./sample-values.ts";

test("sample values: đủ các loại minh hoạ yêu cầu preview", () => {
  // Vietnamese text (diacritics: ù ễ ư ơ...)
  assert.match(DEFAULT_SAMPLE_VALUES.Ho_ten ?? "", /[àáảãạằắặèéẹẻẽìíịỉĩòóọỏõốồổộớờởợùúụủũứừửựýỳỵỷỹ]/u);
  // date
  assert.match(DEFAULT_SAMPLE_VALUES.Ngay_bat_dau ?? "", /^\d{2}\/\d{2}\/\d{4}$/);
  // long address (chứa nhiều từ, dấu phẩy)
  assert.ok((DEFAULT_SAMPLE_VALUES.Dia_chi_thuong_tru ?? "").length > 40);
  assert.ok((DEFAULT_SAMPLE_VALUES.Dia_chi_thuong_tru ?? "").includes(","));
  // multiline / long paragraph
  assert.ok((DEFAULT_SAMPLE_VALUES.Cam_ket ?? "").length > 80);
});

test("highlighted list bao gồm vietnamese/date/address/checkbox/multiline mục tiêu", () => {
  for (const k of ["Ho_ten", "Ngay_bat_dau", "Dia_chi_thuong_tru", "Cam_ket"]) {
    assert.ok(HIGHLIGHTED_PREVIEW_KEYS.includes(k));
  }
});

test("checkbox sample options có sourceKey + optionValue", () => {
  assert.ok(SAMPLE_CHECKBOX_OPTIONS.length >= 3);
  for (const opt of SAMPLE_CHECKBOX_OPTIONS) {
    assert.ok(opt.sourceKey);
    assert.ok(opt.optionValue);
    assert.ok(opt.placeholder);
  }
});

test("buildSampleValueSet: merge override + highlight", () => {
  const set = buildSampleValueSet({ Ho_ten: "Nguyễn Văn An" });
  assert.equal(set.values.Ho_ten, "Nguyễn Văn An");
  assert.ok(set.highlighted.length > 0);
  assert.equal(set.values.Ngay_bat_dau, DEFAULT_SAMPLE_VALUES.Ngay_bat_dau);
});

test("sampleValueFor: có fallback", () => {
  assert.equal(sampleValueFor("Ho_ten"), DEFAULT_SAMPLE_VALUES.Ho_ten);
  assert.equal(sampleValueFor("Không_tồn_tại_xyz"), "[Không_tồn_tại_xyz]");
});
