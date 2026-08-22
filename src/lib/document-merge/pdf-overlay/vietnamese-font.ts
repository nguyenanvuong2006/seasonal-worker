/**
 * PDF Overlay Engine — Vietnamese Unicode font support (PR1).
 *
 * - Font nhúng: DejaVu Sans 2.37 (src/lib/document-merge/pdf-overlay/fonts/).
 *   License: Bitstream Vera (xem fonts/LICENSE-DejaVu.txt) — được phép tái
 *   phân phối kèm license. ĐÃ AUDIT: coverage tiếng Việt đầy đủ (precomposed
 *   + combining diacritics + Đ/đ ă â ê ô ơ ư).
 * - KHÔNG dùng Standard-14 font (không có glyph tiếng Việt) — renderer bắt buộc
 *   nhận `fontBytes` và fail nếu thiếu.
 * - Embed qua @pdf-lib/fontkit + pdf-lib, subset theo document để PDF nhỏ.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fontkit from "@pdf-lib/fontkit";
import type { PDFDocument, PDFFont } from "pdf-lib";

/** Kiểu fontkit pdf-lib mong đợi ở registerFontkit (create → Font). */
type FontkitLike = Parameters<PDFDocument["registerFontkit"]>[0];
export type FontkitFont = ReturnType<FontkitLike["create"]>;

/** Mô tả font nhúng (audit trail — không đọc license từ binary). */
export const EMBEDDED_FONT = {
  family: "DejaVu Sans",
  version: "2.37",
  license: "Bitstream Vera (fonts/LICENSE-DejaVu.txt)",
  path: "./fonts/DejaVuSans.ttf",
} as const;

/** Corpus kiểm tra glyph bắt buộc cho tiếng Việt (precomposed + combining). */
export const VIETNAMESE_COVERAGE_CORPUS: readonly string[] = [
  "Bùi Nguyễn Phương Vy",
  "Đà Lạt",
  "Đường Nguyễn Tử Lực",
  "Cộng hòa xã hội chủ nghĩa Việt Nam",
  "ă â đ ê ô ơ ư Ă Â Đ Ê Ô Ơ Ư",
  "á à ả ã ạ ấ ầ ẩ ẫ ậ ắ ằ ẳ ẵ ặ",
  "é è ẻ ẽ ẹ ế ề ể ễ ệ",
  "í ì ỉ ĩ ị",
  "ó ò ỏ õ ọ ố ồ ổ ỗ ộ ớ ờ ở ỡ ợ",
  "ú ù ủ ũ ụ ứ ừ ử ữ ự",
  "ý ỳ ỷ ỹ ỵ",
  "0123456789 .,;:-/()'\"&",
];

const COMBINING_MARKS: readonly number[] = [0x0300, 0x0301, 0x0303, 0x0309, 0x0323];

/** Liệt kê ký tự thiếu glyph trong font (theo corpus + combining marks). */
export function listMissingGlyphs(font: FontkitFont, corpus: readonly string[]): string[] {
  const missing = new Set<string>();
  for (const text of corpus) {
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if (cp === undefined) continue;
      if (!font.hasGlyphForCodePoint(cp)) missing.add(ch);
    }
  }
  for (const cp of COMBINING_MARKS) {
    if (!font.hasGlyphForCodePoint(cp)) missing.add(String.fromCodePoint(cp));
  }
  return [...missing];
}

/**
 * Embed font nhúng vào PDFDocument. Đăng ký fontkit TRƯỚC embedFont.
 * Trả pdfFont (để draw) + fontkitFont (để đo ascent/descent/coverage).
 */
export async function embedVietnameseFont(
  pdfDoc: PDFDocument,
  fontBytes: Uint8Array,
  opts: { subset?: boolean } = {},
): Promise<{ pdfFont: PDFFont; fontkitFont: FontkitFont; missing: string[] }> {
  if (!fontBytes || fontBytes.byteLength === 0) {
    throw new Error("FONT_BYTES_REQUIRED: fontBytes rỗng.");
  }
  const fk = fontkit as unknown as FontkitLike;
  pdfDoc.registerFontkit(fk);
  const pdfFont = await pdfDoc.embedFont(fontBytes, { subset: opts.subset ?? true });
  const fontkitFont = fk.create(fontBytes);
  const missing = listMissingGlyphs(fontkitFont, VIETNAMESE_COVERAGE_CORPUS);
  return { pdfFont, fontkitFont, missing };
}

/**
 * Đọc font binary từ asset trong repo — DÀNH CHO Node runtime (worker Docker,
 * node --test). Next.js route (PR3+) sẽ nhận bytes từ storage/asset import —
 * renderer KHÔNG bao giờ tự đọc filesystem.
 */
export function readEmbeddedFontBytes(): Uint8Array {
  const fontUrl = new URL("./fonts/DejaVuSans.ttf", import.meta.url);
  return new Uint8Array(readFileSync(fileURLToPath(fontUrl)));
}
