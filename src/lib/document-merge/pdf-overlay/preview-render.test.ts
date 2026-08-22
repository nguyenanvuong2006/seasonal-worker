/**
 * Preview rendering — tests (PR3).
 * Chứng minh đường render preview (non-production) hoạt động end-to-end ở tầng
 * renderer: blank PDF + positions → toPositionSpec → renderPdfOverlay với giá
 * trị mẫu (operator-provided) + font tiếng Việt → PDF bytes hợp lệ + sha256.
 * KHÔNG tạo merge job, KHÔNG dùng dữ liệu production.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { PDFDocument } from "pdf-lib";

import { A4_HEIGHT_PT, A4_WIDTH_PT } from "./geometry.ts";
import { toPositionSpec, type PositionDbRow } from "./positions.ts";
import { renderPdfOverlay, sha256Hex } from "./renderer.ts";
import { readEmbeddedFontBytes } from "./vietnamese-font.ts";

const fontBytes = readEmbeddedFontBytes();

async function makeBlankPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([A4_WIDTH_PT, A4_HEIGHT_PT]);
  return doc.save({ useObjectStreams: true });
}

const textRow: PositionDbRow = {
  placeholder: "Ho_ten",
  pageNumber: 1,
  x: 50,
  y: 700,
  width: 200,
  height: 20,
  type: "TEXT",
  fontSize: 12,
};

const checkboxRow: PositionDbRow = {
  placeholder: "Tien_an_tien_su_Khong",
  pageNumber: 1,
  x: 60,
  y: 600,
  width: 16,
  height: 16,
  type: "CHECKBOX",
  checkboxStyle: "SQUARE_X",
  optionValue: "Khong",
  sourceKey: "Tien_an_tien_su",
};

test("preview: render blank PDF + positions với giá trị mẫu tiếng Việt → PDF hợp lệ", async () => {
  const tpl = await makeBlankPdf();
  const positions = [toPositionSpec(textRow), toPositionSpec(checkboxRow)];
  const values = { Ho_ten: "Bùi Nguyễn Phương Vy", Tien_an_tien_su_Khong: "X" };

  const result = await renderPdfOverlay(tpl, positions, values, {
    fontBytes,
    expectedPageCount: 1,
    subsetFont: true,
  });

  assert.equal(result.pageCount, 1);
  assert.equal(result.positionsDrawn, 2);
  assert.equal(result.sha256, sha256Hex(result.bytes));
  assert.ok(result.bytes.byteLength > 0);

  // bytes là PDF hợp lệ (load lại được)
  const loaded = await PDFDocument.load(result.bytes);
  assert.equal(loaded.getPageCount(), 1);
});

test("preview: page count không khớp → TEMPLATE_PAGE_COUNT_MISMATCH", async () => {
  const tpl = await makeBlankPdf();
  const positions = [toPositionSpec(textRow)];
  await assert.rejects(
    () =>
      renderPdfOverlay(tpl, positions, { Ho_ten: "X" }, {
        fontBytes,
        expectedPageCount: 2,
      }),
    (err: Error & { code?: string }) => err.code === "TEMPLATE_PAGE_COUNT_MISMATCH",
  );
});

test("preview: required field rỗng → MISSING_REQUIRED_FIELD", async () => {
  const tpl = await makeBlankPdf();
  const positions = [toPositionSpec({ ...textRow, isRequired: true })];
  await assert.rejects(
    () =>
      renderPdfOverlay(tpl, positions, { Ho_ten: "" }, { fontBytes, expectedPageCount: 1 }),
    (err: Error & { code?: string }) => err.code === "MISSING_REQUIRED_FIELD",
  );
});
