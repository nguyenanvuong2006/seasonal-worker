import test from "node:test";
import assert from "node:assert/strict";
import {
  countPlaceholders,
  extractPlaceholderFromText,
  extractUniquePlaceholders,
  hasUnreplacedPlaceholders,
  replaceMultiplePlaceholders,
  replacePlaceholder,
} from "./placeholder-extractor.ts";

test("placeholder extractor: {{Field}} and <<Field>> share one semantic key", () => {
  const source = "{{ Ho_ten }} / <<Ho_ten>> / {{Dia_chi_thuong_tru}}";
  assert.deepEqual(extractUniquePlaceholders(source), ["Dia_chi_thuong_tru", "Ho_ten"]);
  assert.equal(countPlaceholders(source), 3);
  assert.equal(extractPlaceholderFromText("prefix {{ Ho_ten }} suffix"), "Ho_ten");
});

test("placeholder replacement replaces both forms while retaining unrelated keys", () => {
  const source = "{{Ho_ten}} << Ho_ten >> {{So_CCCD}}";
  const output = replacePlaceholder(source, "Ho_ten", "Nguyễn Văn A");
  assert.equal(output, "Nguyễn Văn A Nguyễn Văn A {{So_CCCD}}");
  assert.equal(hasUnreplacedPlaceholders(output), true);
  assert.equal(
    replaceMultiplePlaceholders(output, { So_CCCD: "012345678901" }),
    "Nguyễn Văn A Nguyễn Văn A 012345678901",
  );
  assert.equal(hasUnreplacedPlaceholders("no placeholders"), false);
});
