import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { extractUniquePlaceholders } from "./placeholder-extractor.ts";
import { PLACEHOLDERS } from "../../document-templates/dang-ky-tap-nghe/schema.ts";

const file = readFileSync("migrations/2026-08-24-trainee-registration-v8-pagination-draft.sql", "utf8");
const v7 = readFileSync("migrations/2026-08-24-trainee-registration-v7-operator-test2-draft.sql", "utf8");
const dollar = (source: string, tag: string) => {
  const match = source.match(new RegExp(`\\$${tag}\\$([\\s\\S]*?)\\$${tag}\\$`));
  assert.ok(match, `missing $${tag}$`);
  return match[1];
};
const body = dollar(file, "v8_html");
const css = dollar(file, "v8_css");

test("v8 splits HR and regulations at an explicit structural A4 boundary", () => {
  const hr = body.indexOf("GHI NHẬN CỦA PHÒNG NHÂN SỰ");
  const boundary = body.indexOf('class="paper regulations-page"');
  const regulations = body.indexOf("QUY ĐỊNH VỀ TẬP NGHỀ");
  assert.ok(hr >= 0 && boundary > hr && regulations > boundary);
  assert.match(body.slice(boundary, regulations + 100), /DALAT HASFARM/);
  assert.match(body.slice(regulations, regulations + 500), /Căn cứ Điều 61[\s\S]*Căn cứ nhu cầu tuyển dụng[\s\S]*Căn cứ nhu cầu tập nghề/);
  assert.match(css, /\.regulations-page\s*\{\s*break-before:\s*page;\s*page-break-before:\s*always;/);
});

test("v8 preserves v7 tokens and scopes anti-orphan protection to regulations signature", () => {
  assert.deepEqual(extractUniquePlaceholders(body), [...PLACEHOLDERS].sort());
  assert.equal(extractUniquePlaceholders(body).length, 49);
  assert.match(body, /class="sign-block regulations-signature mt-8"/);
  assert.match(css, /\.regulations-signature\s*\{\s*break-inside:\s*avoid;\s*page-break-inside:\s*avoid;/);
  assert.doesNotMatch(css, /(?:^|\n)\.sign-block\s*\{[^}]*break-inside/);
  assert.doesNotMatch(css, /(?:^|\n)\.paper\s*\{[^}]*break-inside/);
});

test("v8 makes no typography, margin, or A4 geometry change relative to v7", () => {
  const v7Css = dollar(v7, "v7_css");
  assert.equal(css.slice(0, v7Css.length), v7Css);
  assert.equal(createHash("sha256").update(dollar(v7, "v7_html")).digest("hex"), "7cb43551d3d4f5178ce203a176a7004aa7e3994ecad2276ef593b6fe401116c1");
  assert.doesNotMatch(css.slice(v7Css.length), /font-size|font-family|line-height|margin\s*:|@page|width\s*:210mm|min-height|padding\s*:12mm/);
});
