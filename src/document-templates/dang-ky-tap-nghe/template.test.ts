/**
 * Canonical HTML template must match the 49 active Production mappings.
 * Operator-accepted orphans must stay out of the HTML.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { extractUniquePlaceholders } from "../../lib/document-merge/placeholder-extractor.ts";
import { dangKyTapNgheTemplate } from "./template.ts";
import { PLACEHOLDERS, REJECTED_ORPHAN_PLACEHOLDERS } from "./schema.ts";

test("canonical dang-ky-tap-nghe HTML has exactly 49 active placeholders", () => {
  const found = extractUniquePlaceholders(dangKyTapNgheTemplate.html);
  assert.equal(PLACEHOLDERS.length, 49);
  assert.equal(found.length, 49);
  assert.deepEqual(found, [...PLACEHOLDERS].sort());
});

test("canonical HTML excludes operator-accepted orphan tax-contract placeholders", () => {
  const found = extractUniquePlaceholders(dangKyTapNgheTemplate.html);
  for (const orphan of REJECTED_ORPHAN_PLACEHOLDERS) {
    assert.equal(found.includes(orphan), false, orphan);
    assert.doesNotMatch(dangKyTapNgheTemplate.html, new RegExp(`<<\\s*${orphan}\\s*>>`));
    assert.doesNotMatch(dangKyTapNgheTemplate.html, /Số hợp đồng dịch vụ thuế/);
    assert.doesNotMatch(dangKyTapNgheTemplate.html, /Ngày hợp đồng dịch vụ thuế/);
  }
});
