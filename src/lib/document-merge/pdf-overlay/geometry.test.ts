import test from "node:test";
import assert from "node:assert/strict";

import {
  A4_HEIGHT_PT,
  A4_WIDTH_PT,
  isBoxInsidePage,
  isValidRotation,
  mmToPt,
  normalizePageGeometry,
  ptToMm,
} from "./geometry.ts";

test("geometry: mm ↔ pt (1mm = 2.83464567pt)", () => {
  const pt = mmToPt(10);
  assert.ok(Math.abs(pt - 28.3464567) < 1e-6);
  assert.ok(Math.abs(ptToMm(pt) - 10) < 1e-6);
});

test("geometry: A4 portrait dimensions are the canonical contract", () => {
  assert.ok(Math.abs(A4_WIDTH_PT - 595.28) < 1e-6);
  assert.ok(Math.abs(A4_HEIGHT_PT - 841.89) < 1e-6);
});

test("geometry: rotation chỉ nhận 0/90/180/270", () => {
  assert.equal(isValidRotation(0), true);
  assert.equal(isValidRotation(90), true);
  assert.equal(isValidRotation(180), true);
  assert.equal(isValidRotation(270), true);
  assert.equal(isValidRotation(45), false);
  assert.equal(isValidRotation(-90), false);
});

test("geometry: isBoxInsidePage — box hợp lệ nằm trong trang", () => {
  assert.equal(isBoxInsidePage({ x: 10, y: 10, width: 100, height: 20 }, 595.28, 841.89), true);
  assert.equal(isBoxInsidePage({ x: 0, y: 0, width: 595.28, height: 841.89 }, 595.28, 841.89), true);
});

test("geometry: isBoxInsidePage — x/y âm là ngoài trang", () => {
  assert.equal(isBoxInsidePage({ x: -1, y: 10, width: 100, height: 20 }, 595.28, 841.89), false);
  assert.equal(isBoxInsidePage({ x: 10, y: -1, width: 100, height: 20 }, 595.28, 841.89), false);
});

test("geometry: isBoxInsidePage — box vượt quá biên phải/trên là ngoài trang", () => {
  assert.equal(isBoxInsidePage({ x: 500, y: 10, width: 200, height: 20 }, 595.28, 841.89), false);
  assert.equal(isBoxInsidePage({ x: 10, y: 830, width: 100, height: 20 }, 595.28, 841.89), false);
});

test("geometry: isBoxInsidePage — width/height <= 0 không hợp lệ", () => {
  assert.equal(isBoxInsidePage({ x: 10, y: 10, width: 0, height: 20 }, 595.28, 841.89), false);
  assert.equal(isBoxInsidePage({ x: 10, y: 10, width: 100, height: -1 }, 595.28, 841.89), false);
});

test("geometry: normalizePageGeometry — rotation 90/270 hoán đổi width/height", () => {
  const media = { x: 0, y: 0, width: 595.28, height: 841.89 };
  assert.deepEqual(normalizePageGeometry(media, 0), { width: 595.28, height: 841.89 });
  assert.deepEqual(normalizePageGeometry(media, 180), { width: 595.28, height: 841.89 });
  assert.deepEqual(normalizePageGeometry(media, 90), { width: 841.89, height: 595.28 });
  assert.deepEqual(normalizePageGeometry(media, 270), { width: 841.89, height: 595.28 });
});

test("geometry: normalizePageGeometry — rotation không hợp lệ thì throw", () => {
  assert.throws(() => normalizePageGeometry({ x: 0, y: 0, width: 100, height: 200 }, 45));
});
