import test from "node:test";
import assert from "node:assert/strict";

import { PDFDocument } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

import {
  EMBEDDED_FONT,
  VIETNAMESE_COVERAGE_CORPUS,
  embedVietnameseFont,
  listMissingGlyphs,
  readEmbeddedFontBytes,
  type FontkitFont,
} from "./vietnamese-font.ts";

function openFont(): FontkitFont {
  const fk = fontkit as unknown as { create(bytes: Uint8Array): FontkitFont };
  return fk.create(readEmbeddedFontBytes());
}

test("font: asset nhúng đọc được, kích thước > 0", () => {
  const bytes = readEmbeddedFontBytes();
  assert.ok(bytes.byteLength > 0);
});

test("font: family đúng là DejaVu Sans (đã audit license)", () => {
  const font = openFont();
  assert.equal(font.familyName, "DejaVu Sans");
  assert.equal(EMBEDDED_FONT.family, "DejaVu Sans");
});

test("font: KHÔNG thiếu glyph tiếng Việt nào trong corpus", () => {
  const font = openFont();
  const missing = listMissingGlyphs(font, VIETNAMESE_COVERAGE_CORPUS);
  assert.deepEqual(missing, []);
});

test("font: các chuỗi bắt buộc đều có glyph đầy đủ", () => {
  const font = openFont();
  for (const s of ["Bùi Nguyễn Phương Vy", "Đà Lạt", "Đường Nguyễn Tử Lực"]) {
    for (const ch of s) {
      const cp = ch.codePointAt(0);
      assert.ok(cp !== undefined && font.hasGlyphForCodePoint(cp), `thiếu glyph '${ch}'`);
    }
  }
});

test("font: embedVietnameseFont đăng ký fontkit + subset, không missing", async () => {
  const pdfDoc = await PDFDocument.create();
  const { pdfFont, fontkitFont, missing } = await embedVietnameseFont(pdfDoc, readEmbeddedFontBytes(), { subset: true });
  assert.equal(missing.length, 0);
  assert.ok(pdfFont);
  assert.equal(fontkitFont.familyName, "DejaVu Sans");
});

test("font: embedVietnameseFont từ chối bytes rỗng", async () => {
  const pdfDoc = await PDFDocument.create();
  await assert.rejects(() => embedVietnameseFont(pdfDoc, new Uint8Array(0)), /FONT_BYTES_REQUIRED/);
});
