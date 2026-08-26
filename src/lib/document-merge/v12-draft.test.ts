/**
 * v12 DRAFT (canonical-source.v12.html) — layout evolution of the v11/v7
 * canonical trainee-registration source. v11 (canonical-source.html) is left
 * untouched; v12 is DRAFT only (no migration, no Production row, no publish).
 *
 * Contract:
 *   - Identical 49-placeholder set and legal text as v11.
 *   - `.equal-columns-2` used ONLY for the two pairs:
 *       Ho_ten/Ngay_sinh  and  Nguoi_tiep_nhan/Ngay_tiep_nhan.
 *   - "GHI NHẬN CỦA PHÒNG NHÂN SỰ" flows directly after
 *     "III/ CAM KẾT CỦA NGƯỜI LÀM ĐƠN" — no forced `.paper` break between them.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const V11 = readFileSync(join(REPO_ROOT, "templates/document-merge/trainee-registration/canonical-source.html"), "utf8");
const V12 = readFileSync(join(REPO_ROOT, "templates/document-merge/trainee-registration/canonical-source.v12.html"), "utf8");

function placeholders(html: string): string[] {
  return [...new Set([...html.matchAll(/{{([A-Za-z0-9_]+)}}/g)].map((m) => m[1]))].sort();
}

/** Body without the <style> block or HTML comments (page structure is read via .paper divs). */
function bodyOnly(html: string): string {
  return html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
}

/** Index of the Nth occurrence of `needle` in `haystack`. */
function nthIndexOf(haystack: string, needle: string, n: number): number {
  let idx = -1;
  for (let i = 0; i < n; i += 1) {
    idx = haystack.indexOf(needle, idx + 1);
    if (idx < 0) return -1;
  }
  return idx;
}

test("v12 keeps the exact same 49-placeholder set as v11", () => {
  assert.equal(placeholders(V11).length, 49);
  assert.deepEqual(placeholders(V12), placeholders(V11));
});

test("equal-columns-2 is applied ONLY to the two label/value pairs", () => {
  const matches = [...bodyOnly(V12).matchAll(/class="[^"]*\bequal-columns-2\b[^"]*"/g)].map((m) => m[0]);
  assert.equal(matches.length, 2);
  for (const m of matches) {
    assert.match(m, /equal-columns-2/);
  }
  // Both pairs carry their two placeholders inside the grid container.
  const hoTenLine = bodyOnly(V12).match(/class="line equal-columns-2">\s*<span>[^<]*{{Ho_ten}}[^<]*<\/span>\s*<span>[^<]*{{Ngay_sinh}}[^<]*<\/span>/);
  assert.ok(hoTenLine, "Ho_ten/Ngay_sinh pair must be in one equal-columns-2 container");
  const tiepNhanLine = bodyOnly(V12).match(/class="line b equal-columns-2">\s*<span>[^<]*{{Nguoi_tiep_nhan}}[^<]*<\/span>\s*<span>[^<]*{{Ngay_tiep_nhan}}[^<]*<\/span>/);
  assert.ok(tiepNhanLine, "Nguoi_tiep_nhan/Ngay_tiep_nhan pair must be in one equal-columns-2 container");
});

test("v12 has no forced break between III/ CAM KẾT and GHI NHẬN (GHI NHẬN sits in page 1)", () => {
  const body = bodyOnly(V12);
  const camKet = body.indexOf("CAM KẾT CỦA NGƯỜI LÀM ĐƠN");
  const ghiNhan = body.indexOf("GHI NHẬN CỦA PHÒNG NHÂN SỰ");
  const secondPaper = nthIndexOf(body, '<div class="paper">', 2);
  assert.ok(camKet >= 0 && ghiNhan >= 0 && secondPaper >= 0);
  assert.ok(ghiNhan > camKet, "GHI NHẬN must follow III/ CAM KẾT");
  assert.ok(ghiNhan < secondPaper, "GHI NHẬN must be BEFORE the 2nd .paper block (same page as III/ CAM KẾT)");
});

test("v11 still forces the page break (GHI NHẬN stays in page 2)", () => {
  const body = bodyOnly(V11);
  const ghiNhan = body.indexOf("GHI NHẬN CỦA PHÒNG NHÂN SỰ");
  const secondPaper = nthIndexOf(body, '<div class="paper">', 2);
  assert.ok(ghiNhan >= 0 && secondPaper >= 0);
  assert.ok(ghiNhan > secondPaper, "v11 must keep GHI NHẬN AFTER the 2nd .paper block (unchanged)");
});

test("legal text is preserved byte-for-byte (spot-check of key passages)", () => {
  for (const passage of [
    "Tôi xin cam kết sẽ chấp hành tốt mọi nội quy, chính sách và quy định Tập Nghề cụ thể của Công ty",
    "Đồng ý tiếp nhận anh/chị theo giấy đăng ký vào tập nghề tại Công ty",
    "Căn cứ Điều 61 của Bộ luật Lao động 2019 về Tập nghề",
    "Thời hạn tập nghề là 03 tháng kể từ ngày nhận đơn đăng ký tập nghề",
    "Bảo hiểm Xã hội, Bảo hiểm Y tế, Bảo hiểm Thất nghiệp sẽ không áp dụng",
  ]) {
    assert.ok(V12.includes(passage), `v12 thiếu đoạn pháp lý: ${passage}`);
  }
});

const V12_MIGRATION = readFileSync(
  join(REPO_ROOT, "migrations", "2026-08-26-trainee-registration-v12-layout-draft.sql"),
  "utf8",
);

test("v12 DRAFT migration inserts version 12 as DRAFT, never publishes, never mutates", () => {
  // DRAFT only — no publish pointer, no html_enabled flip, no jobs.
  assert.match(V12_MIGRATION, /, 12, 'DRAFT',/);
  assert.match(V12_MIGRATION, /'\[\]'::jsonb/);
  assert.doesNotMatch(V12_MIGRATION, /current_published_version/);
  assert.doesNotMatch(V12_MIGRATION, /html_enabled/);
  assert.doesNotMatch(V12_MIGRATION, /\b(DROP|DELETE|TRUNCATE)\b/i);
});

test("v12 DRAFT migration is guarded (WHERE NOT EXISTS) and ends with a read-only SELECT", () => {
  assert.match(V12_MIGRATION, /WHERE NOT EXISTS\s*\(/);
  assert.match(V12_MIGRATION, /existing\.version = 12 OR existing\.source_docx_name/);
  // Verification SELECT must not write anything.
  const verification = V12_MIGRATION.slice(V12_MIGRATION.lastIndexOf("SELECT"));
  assert.match(verification, /SELECT version, status, mapping_snapshot/);
  assert.doesNotMatch(verification, /\b(INSERT|UPDATE|DELETE|DROP)\b/i);
});
