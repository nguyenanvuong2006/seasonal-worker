import test from "node:test";
import assert from "node:assert/strict";
import { tokenizeHtml, checkWellFormedness, decodeBasicEntities } from "./html-scanner.ts";

test("html-scanner: <<Ho_ten>> is NEVER misread as an HTML tag", () => {
  const tokens = tokenizeHtml("<p><<Ho_ten>></p>");
  const tagTokens = tokens.filter((t) => t.type === "open-tag" || t.type === "close-tag");
  assert.deepEqual(tagTokens.map((t) => (t as { name: string }).name), ["p", "p"]);
  const text = tokens.find((t) => t.type === "text");
  assert.ok(text && text.content === "<<Ho_ten>>", "placeholder must be a plain text token");
});

test("html-scanner: {{Ho_ten}} placeholder is text, not confused with a tag", () => {
  const tokens = tokenizeHtml("<td>{{Dia_chi_tam_tru}}</td>");
  const text = tokens.find((t) => t.type === "text");
  assert.equal(text?.content, "{{Dia_chi_tam_tru}}");
});

test("html-scanner: quoted attribute containing '>' does not end the tag early", () => {
  const tokens = tokenizeHtml(`<div title="a > b" class="x"><<Ten>></div>`);
  const open = tokens.find((t) => t.type === "open-tag") as Extract<ReturnType<typeof tokenizeHtml>[number], { type: "open-tag" }>;
  assert.equal(open.name, "div");
  assert.equal(open.attrs.find((a) => a.name === "title")?.value, "a > b");
  assert.equal(open.attrs.find((a) => a.name === "class")?.value, "x");
});

test("html-scanner: single-quoted attribute values are parsed", () => {
  const tokens = tokenizeHtml(`<a href='https://example.com/a?b=1&c=2'>link</a>`);
  const open = tokens.find((t) => t.type === "open-tag") as Extract<ReturnType<typeof tokenizeHtml>[number], { type: "open-tag" }>;
  assert.equal(open.attrs.find((a) => a.name === "href")?.value, "https://example.com/a?b=1&c=2");
});

test("html-scanner: HTML comments containing tag-like text are not tag-parsed", () => {
  const tokens = tokenizeHtml(`<!-- <script>alert(1)</script> --><p>ok</p>`);
  const comment = tokens.find((t) => t.type === "comment");
  assert.equal(comment?.content, " <script>alert(1)</script> ");
  const scriptTokens = tokens.filter((t) => t.type === "raw-text");
  assert.equal(scriptTokens.length, 0, "commented-out script must not be scanned as raw-text");
});

test("html-scanner: <script> body is opaque raw-text, not tag-parsed", () => {
  const tokens = tokenizeHtml(`<script>if (a < b) { console.log("<div>"); }</script><p>after</p>`);
  const raw = tokens.find((t) => t.type === "raw-text");
  assert.equal(raw?.tagName, "script");
  assert.match((raw as { content: string }).content, /if \(a < b\)/);
  const pTag = tokens.find((t) => t.type === "open-tag" && (t as { name: string }).name === "p");
  assert.ok(pTag, "content after </script> must resume normal tokenizing");
});

test("html-scanner: <style> body is opaque raw-text", () => {
  const tokens = tokenizeHtml(`<style>.x { content: "<<Ho_ten>>"; }</style>`);
  const raw = tokens.find((t) => t.type === "raw-text");
  assert.equal(raw?.tagName, "style");
  assert.match((raw as { content: string }).content, /<<Ho_ten>>/);
});

test("html-scanner: self-closing and void elements never open a raw-text/close expectation", () => {
  const tokens = tokenizeHtml(`<br/><img src="x.png"/><p>ok</p>`);
  const issues = checkWellFormedness(tokens);
  assert.deepEqual(issues, []);
});

test("html-scanner: DOCTYPE is a single token, not a tag", () => {
  const tokens = tokenizeHtml(`<!DOCTYPE html><html><body>ok</body></html>`);
  assert.equal(tokens[0].type, "doctype");
  const issues = checkWellFormedness(tokens);
  assert.deepEqual(issues, []);
});

test("checkWellFormedness: unclosed tag is reported", () => {
  const issues = checkWellFormedness(tokenizeHtml(`<div><p>text</div>`));
  assert.ok(issues.some((i) => i.code === "MISMATCHED_CLOSE_TAG" || i.code === "UNCLOSED_TAG"));
});

test("checkWellFormedness: well-formed nested tags produce no issues", () => {
  const issues = checkWellFormedness(tokenizeHtml(`<div><p><span>ok</span></p></div>`));
  assert.deepEqual(issues, []);
});

test("checkWellFormedness: unexpected close tag with no opener is reported", () => {
  const issues = checkWellFormedness(tokenizeHtml(`<p>ok</p></div>`));
  assert.ok(issues.some((i) => i.code === "UNEXPECTED_CLOSE_TAG" && i.tagName === "div"));
});

test("decodeBasicEntities: decodes numeric and named entities used in bypass attempts", () => {
  assert.equal(decodeBasicEntities("&#106;avascript:"), "javascript:");
  assert.equal(decodeBasicEntities("&lt;script&gt;"), "<script>");
  assert.equal(decodeBasicEntities("&amp;"), "&");
});

test("html-scanner: malformed structure is reported, not thrown", () => {
  assert.doesNotThrow(() => tokenizeHtml(`<div class="unterminated`));
});
