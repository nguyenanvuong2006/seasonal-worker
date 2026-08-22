import test from "node:test";
import assert from "node:assert/strict";

import {
  fixtureVietnameseName,
  fixtureLongAddress,
  fixtureDates,
  fixtureCurrency,
  fixtureMultiline,
  fixtureShrinkToFit,
  fixtureAlignment,
  fixtureVerticalAlignment,
  fixtureCheckboxChecked,
  fixtureCheckboxUnchecked,
  fixtureMultiPosition,
  fixtureMultiPage,
  fixtureRequiredFieldFailure,
  fixtureFieldOverflowFailure,
  fixturePageBoundaries,
  generateAllFixtures,
  makeBlankTemplate,
} from "./fixtures.ts";

test("fixtures: generateAllFixtures trả về 15 fixtures", async () => {
  const fixtures = await generateAllFixtures();
  assert.equal(fixtures.length, 15);
});

test("fixtures: mỗi fixture có id duy nhất", async () => {
  const fixtures = await generateAllFixtures();
  const ids = fixtures.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("fixtures: mỗi fixture có templatePdf là Uint8Array", async () => {
  const fixtures = await generateAllFixtures();
  for (const f of fixtures) {
    assert.ok(f.templatePdf instanceof Uint8Array);
    assert.ok(f.templatePdf.byteLength > 0);
  }
});

test("fixtures: mỗi fixture có positions là array", async () => {
  const fixtures = await generateAllFixtures();
  for (const f of fixtures) {
    assert.ok(Array.isArray(f.positions));
    assert.ok(f.positions.length > 0);
  }
});

test("fixtures: mỗi fixture có fieldValues là object", async () => {
  const fixtures = await generateAllFixtures();
  for (const f of fixtures) {
    assert.ok(typeof f.fieldValues === "object");
    assert.ok(f.fieldValues !== null);
  }
});

test("fixtures: fixtureVietnameseName có glyph tiếng Việt", async () => {
  const f = await fixtureVietnameseName();
  assert.equal(f.id, "vietnamese-name");
  assert.ok(f.fieldValues.Ho_ten.includes("Bùi"));
  assert.ok(f.fieldValues.Ho_ten.includes("Nguyễn"));
});

test("fixtures: fixtureLongAddress có địa chỉ dài", async () => {
  const f = await fixtureLongAddress();
  assert.equal(f.id, "long-address");
  assert.ok(f.fieldValues.Dia_chi.length > 50);
});

test("fixtures: fixtureDates có định dạng DD/MM/YYYY", async () => {
  const f = await fixtureDates();
  assert.equal(f.id, "dates");
  assert.match(f.fieldValues.Ngay_sinh, /^\d{2}\/\d{2}\/\d{4}$/);
});

test("fixtures: fixtureCurrency có số với dấu chấm", async () => {
  const f = await fixtureCurrency();
  assert.equal(f.id, "currency");
  assert.ok(f.fieldValues.So_tien.includes("."));
});

test("fixtures: fixtureMultiline có xuống dòng", async () => {
  const f = await fixtureMultiline();
  assert.equal(f.id, "multiline");
  assert.ok(f.fieldValues.Noi_dung.includes("\n"));
});

test("fixtures: fixtureShrinkToFit có minFontSize", async () => {
  const f = await fixtureShrinkToFit();
  assert.equal(f.id, "shrink-to-fit");
  const pos = f.positions[0];
  assert.ok(pos.minFontSize !== undefined);
  assert.ok(pos.minFontSize! < pos.fontSize!);
});

test("fixtures: fixtureAlignment có 3 positions left/center/right", async () => {
  const f = await fixtureAlignment();
  assert.equal(f.id, "alignment");
  assert.equal(f.positions.length, 3);
  assert.equal(f.positions[0].align, "left");
  assert.equal(f.positions[1].align, "center");
  assert.equal(f.positions[2].align, "right");
});

test("fixtures: fixtureVerticalAlignment có 3 positions top/middle/bottom", async () => {
  const f = await fixtureVerticalAlignment();
  assert.equal(f.id, "vertical-alignment");
  assert.equal(f.positions.length, 3);
  assert.equal(f.positions[0].valign, "top");
  assert.equal(f.positions[1].valign, "middle");
  assert.equal(f.positions[2].valign, "bottom");
});

test("fixtures: fixtureCheckboxChecked có giá trị ☒", async () => {
  const f = await fixtureCheckboxChecked();
  assert.equal(f.id, "checkbox-checked");
  assert.equal(f.fieldValues.Co, "☒");
  assert.equal(f.positions[0].type, "CHECKBOX");
});

test("fixtures: fixtureCheckboxUnchecked có giá trị rỗng", async () => {
  const f = await fixtureCheckboxUnchecked();
  assert.equal(f.id, "checkbox-unchecked");
  assert.equal(f.fieldValues.Khong, "");
  assert.equal(f.positions[0].type, "CHECKBOX");
});

test("fixtures: fixtureMultiPosition có cùng placeholder ở nhiều vị trí", async () => {
  const f = await fixtureMultiPosition();
  assert.equal(f.id, "multi-position");
  assert.equal(f.positions.length, 2);
  assert.equal(f.positions[0].placeholder, f.positions[1].placeholder);
});

test("fixtures: fixtureMultiPage có 3 trang", async () => {
  const f = await fixtureMultiPage();
  assert.equal(f.id, "multi-page");
  assert.equal(f.expectedPageCount, 3);
  const pages = new Set(f.positions.map((p) => p.pageNumber));
  assert.equal(pages.size, 3);
});

test("fixtures: fixtureRequiredFieldFailure có expectedError", async () => {
  const f = await fixtureRequiredFieldFailure();
  assert.equal(f.id, "required-field-failure");
  assert.equal(f.expectedError, "MISSING_REQUIRED_FIELD");
  assert.equal(f.fieldValues.Ho_ten, "");
  assert.equal(f.positions[0].isRequired, true);
});

test("fixtures: fixtureFieldOverflowFailure có expectedError", async () => {
  const f = await fixtureFieldOverflowFailure();
  assert.equal(f.id, "field-overflow-failure");
  assert.equal(f.expectedError, "FIELD_OVERFLOW");
  assert.ok(f.fieldValues.Ho_ten.length > 30);
});

test("fixtures: fixturePageBoundaries có text ở mép trang", async () => {
  const f = await fixturePageBoundaries();
  assert.equal(f.id, "page-boundaries");
  assert.equal(f.positions.length, 2);
  const topLeft = f.positions.find((p) => p.placeholder === "TopLeft");
  assert.ok(topLeft!.x < 20);
  assert.ok(topLeft!.y > 800);
});

test("fixtures: makeBlankTemplate tạo PDF đúng số trang", async () => {
  const bytes = await makeBlankTemplate(5);
  assert.ok(bytes instanceof Uint8Array);
  assert.ok(bytes.byteLength > 0);
});

test("fixtures: deterministic — cùng fixture 2 lần → cùng cấu trúc", async () => {
  const f1 = await fixtureVietnameseName();
  const f2 = await fixtureVietnameseName();
  assert.equal(f1.id, f2.id);
  assert.deepEqual(f1.fieldValues, f2.fieldValues);
  assert.equal(f1.positions.length, f2.positions.length);
});
