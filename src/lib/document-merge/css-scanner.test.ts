import test from "node:test";
import assert from "node:assert/strict";
import { parseCss, extractCssUrls } from "./css-scanner.ts";

test("css-scanner: parses a simple rule into selectors + declarations", () => {
  const { rules, issues } = parseCss(`.addr { height: 24px; overflow: hidden; }`);
  assert.deepEqual(issues, []);
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0].selectors, [".addr"]);
  assert.deepEqual(rules[0].declarations, [
    { property: "height", value: "24px" },
    { property: "overflow", value: "hidden" },
  ]);
});

test("css-scanner: comma-separated selector list is split at the top level", () => {
  const { rules } = parseCss(`td.a, .b, #c { color: red; }`);
  assert.deepEqual(rules[0].selectors, ["td.a", ".b", "#c"]);
});

test("css-scanner: @media block nests rules with at-rule context recorded", () => {
  const { rules } = parseCss(`@media print { .page { break-inside: avoid; } }`);
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0].selectors, [".page"]);
  assert.deepEqual(rules[0].atRuleContext, ["@media print"]);
});

test("css-scanner: @page block does not break parsing of rules after it", () => {
  const { rules } = parseCss(`@page { size: A4; margin: 12mm; } .x { width: 100%; }`);
  assert.equal(rules.length, 2);
  assert.deepEqual(rules[1].selectors, [".x"]);
});

test("css-scanner: @import statement is captured, not treated as a rule", () => {
  const { atStatements, rules } = parseCss(`@import url("https://evil.example/x.css"); .a { color: red; }`);
  assert.equal(atStatements.length, 1);
  assert.match(atStatements[0], /@import/);
  assert.equal(rules.length, 1);
});

test("css-scanner: comments are stripped and do not corrupt declarations", () => {
  const { rules } = parseCss(`.a { /* height: 999px; */ color: red; }`);
  assert.deepEqual(rules[0].declarations, [{ property: "color", value: "red" }]);
});

test("css-scanner: comment-like text inside a string is preserved", () => {
  const { rules } = parseCss(`.a { content: "/* not a comment */"; }`);
  assert.equal(rules[0].declarations[0].value, '"/* not a comment */"');
});

test("css-scanner: semicolon inside url()/string does not split a declaration", () => {
  const { rules } = parseCss(`.a { background: url("data:image/png;base64,AAA="); color: red; }`);
  assert.equal(rules[0].declarations.length, 2);
  assert.match(rules[0].declarations[0].value, /^url\(/);
});

test("css-scanner: unbalanced braces reported, does not throw", () => {
  const { issues } = parseCss(`.a { color: red;`);
  assert.ok(issues.some((i) => i.code === "UNBALANCED_BRACES"));
});

test("css-scanner: unterminated string reported, does not throw", () => {
  const { issues } = parseCss(`.a { content: "unterminated; }`);
  assert.ok(issues.some((i) => i.code === "UNTERMINATED_STRING"));
});

test("extractCssUrls: extracts quoted and unquoted url() arguments", () => {
  assert.deepEqual(extractCssUrls(`url("a.png")`), ["a.png"]);
  assert.deepEqual(extractCssUrls(`url('b.png')`), ["b.png"]);
  assert.deepEqual(extractCssUrls(`url(c.png)`), ["c.png"]);
  assert.deepEqual(extractCssUrls(`url(javascript:alert(1))`), ["javascript:alert(1)"]);
});
