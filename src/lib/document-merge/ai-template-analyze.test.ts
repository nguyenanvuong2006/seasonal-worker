import test from "node:test";
import assert from "node:assert/strict";
import { analyzeTemplate, diffVisibleText, extractVisibleTextSegments } from "./ai-template-analyze.ts";
import { toMappingSemantics, type MappingSemantics } from "./template-diff.ts";

function mapping(placeholder: string, overrides: Partial<MappingSemantics> = {}): MappingSemantics {
  return toMappingSemantics({
    placeholder,
    sourceType: "CORE_FIELD",
    sourceField: null,
    sourcePath: placeholder,
    optionValue: null,
    formatType: "RAW",
    fallbackValue: null,
    isRequired: false,
    isOrphaned: false,
    ...overrides,
  });
}

function makeTemplate(n: number): { html: string; placeholders: string[] } {
  const placeholders = Array.from({ length: n }, (_, i) => `Field_${String(i + 1).padStart(2, "0")}`);
  const html = `<div class="page">${placeholders.map((p) => `<p><<${p}>></p>`).join("")}</div>`;
  return { html, placeholders };
}

test("hard product requirement: revised HTML preserving all 49 placeholders -> UNCHANGED=49, ADDED=0, REMOVED=0, MAPPINGS_AFFECTED=0", () => {
  const { html: baseHtml, placeholders } = makeTemplate(49);
  const mappings = placeholders.map((p) => mapping(p));
  // Revised HTML: same 49 placeholders, different surrounding markup/styling only.
  const revisedHtml = `<div class="page"><table>${placeholders.map((p) => `<tr><td><<${p}>></td></tr>`).join("")}</table></div>`;

  const result = analyzeTemplate({
    html: revisedHtml,
    printCss: "",
    baseHtml,
    baseMappings: mappings,
    currentMappings: mappings,
  });

  assert.equal(result.placeholders.total, 49);
  assert.equal(result.placeholders.unchanged, 49);
  assert.equal(result.placeholders.added, 0);
  assert.equal(result.placeholders.removed, 0);
  assert.equal(result.mappingsAffected, 0);
});

test("added placeholder is detected", () => {
  const { html: baseHtml, placeholders } = makeTemplate(3);
  const mappings = placeholders.map((p) => mapping(p));
  const revisedHtml = `<div>${placeholders.map((p) => `<<${p}>>`).join("")}<<New_Field>></div>`;

  const result = analyzeTemplate({
    html: revisedHtml,
    printCss: "",
    baseHtml,
    baseMappings: mappings,
    currentMappings: mappings,
  });

  assert.equal(result.placeholders.total, 4);
  assert.equal(result.placeholders.unchanged, 3);
  assert.equal(result.placeholders.added, 1);
  assert.equal(result.placeholders.removed, 0);
});

test("removed placeholder is detected", () => {
  const { html: baseHtml, placeholders } = makeTemplate(3);
  const mappings = placeholders.map((p) => mapping(p));
  const revisedHtml = `<div><<${placeholders[0]}>><<${placeholders[1]}>></div>`;

  const result = analyzeTemplate({
    html: revisedHtml,
    printCss: "",
    baseHtml,
    baseMappings: mappings,
    currentMappings: mappings,
  });

  assert.equal(result.placeholders.removed, 1);
  assert.equal(result.placeholders.unchanged, 2);
});

test("mapping impact: base (PUBLISHED snapshot) differs from current live mapping -> MAPPINGS_AFFECTED > 0", () => {
  const { html: baseHtml, placeholders } = makeTemplate(2);
  const baseMappings = placeholders.map((p) => mapping(p, { sourcePath: "old_path" }));
  const currentMappings = placeholders.map((p) => mapping(p, { sourcePath: "new_path" }));

  const result = analyzeTemplate({
    html: baseHtml,
    printCss: "",
    baseHtml,
    baseMappings,
    currentMappings,
  });

  assert.equal(result.mappingsAffected, 2);
});

test("deterministic ordering: repeated calls with the same input produce identical output", () => {
  const { html: baseHtml, placeholders } = makeTemplate(10);
  const mappings = placeholders.map((p) => mapping(p));
  const input = { html: baseHtml, printCss: "", baseHtml, baseMappings: mappings, currentMappings: mappings };
  const a = analyzeTemplate(input);
  const b = analyzeTemplate(input);
  assert.deepEqual(a.placeholders, b.placeholders);
  assert.deepEqual(a.security, b.security);
  assert.deepEqual(a.layoutWarnings, b.layoutWarnings);
  assert.deepEqual(a.contentChanges, b.contentChanges);
});

test("HTML_VALID: well-formed HTML reports valid=true", () => {
  const result = analyzeTemplate({
    html: `<div><p><<Ho_ten>></p></div>`,
    printCss: "",
    baseHtml: `<div><p><<Ho_ten>></p></div>`,
    baseMappings: [mapping("Ho_ten")],
    currentMappings: [mapping("Ho_ten")],
  });
  assert.equal(result.htmlValid, true);
});

test("HTML_VALID: malformed HTML (unclosed tag) reports valid=false with issues", () => {
  const result = analyzeTemplate({
    html: `<div><p><<Ho_ten>></div>`,
    printCss: "",
    baseHtml: `<div><p><<Ho_ten>></p></div>`,
    baseMappings: [mapping("Ho_ten")],
    currentMappings: [mapping("Ho_ten")],
  });
  assert.equal(result.htmlValid, false);
  assert.ok(result.htmlIssues.length > 0);
});

test("CSS_VALID: well-formed CSS reports valid=true", () => {
  const result = analyzeTemplate({
    html: `<<Ho_ten>>`,
    printCss: `.a { color: red; }`,
    baseHtml: `<<Ho_ten>>`,
    baseMappings: [mapping("Ho_ten")],
    currentMappings: [mapping("Ho_ten")],
  });
  assert.equal(result.cssValid, true);
});

test("CSS_VALID: unbalanced braces reports valid=false", () => {
  const result = analyzeTemplate({
    html: `<<Ho_ten>>`,
    printCss: `.a { color: red;`,
    baseHtml: `<<Ho_ten>>`,
    baseMappings: [mapping("Ho_ten")],
    currentMappings: [mapping("Ho_ten")],
  });
  assert.equal(result.cssValid, false);
});

test("security errors propagate through the orchestrator", () => {
  const result = analyzeTemplate({
    html: `<script>alert(1)</script><<Ho_ten>>`,
    printCss: "",
    baseHtml: `<<Ho_ten>>`,
    baseMappings: [mapping("Ho_ten")],
    currentMappings: [mapping("Ho_ten")],
  });
  assert.ok(result.security.errors.some((e) => e.code === "SCRIPT_TAG"));
});

test("layout warnings propagate through the orchestrator", () => {
  const result = analyzeTemplate({
    html: `<td style="height:24px"><<Dia_chi_tam_tru>></td>`,
    printCss: "",
    baseHtml: `<td><<Dia_chi_tam_tru>></td>`,
    baseMappings: [mapping("Dia_chi_tam_tru")],
    currentMappings: [mapping("Dia_chi_tam_tru")],
  });
  assert.ok(result.layoutWarnings.some((w) => w.code === "FIXED_HEIGHT_DYNAMIC_CONTENT"));
});

test("extractVisibleTextSegments: strips placeholders and normalizes whitespace, ignores script/style", () => {
  const html = `<style>.x{color:red}</style><p>  Họ   tên:  <<Ho_ten>>  </p><script>evil()</script>`;
  const segments = extractVisibleTextSegments(html);
  assert.ok([...segments].some((s) => s.startsWith("Họ tên") && !s.includes("<<") && !s.includes(">>")));
  assert.equal([...segments].some((s) => s.includes("evil")), false);
  assert.equal([...segments].some((s) => s.includes("color:red")), false);
});

test("diffVisibleText: detects added and removed legal wording deterministically", () => {
  const base = `<p>Cam kết tuân thủ nội quy công ty.</p>`;
  const current = `<p>Cam kết tuân thủ nội quy công ty và pháp luật.</p>`;
  const diff = diffVisibleText(base, current);
  assert.ok(diff.added.some((s) => s.includes("pháp luật")));
  assert.ok(diff.removed.some((s) => s.includes("Cam kết")));
});

test("diffVisibleText: identical content produces no changes", () => {
  const html = `<p>Không đổi.</p>`;
  const diff = diffVisibleText(html, html);
  assert.deepEqual(diff, { added: [], removed: [] });
});

test("address invariants preserved through the diff (no cross-fallback)", () => {
  const baseHtml = `<<Dia_chi_thuong_tru>><<Dia_chi_tam_tru>>`;
  const baseMappings = [
    mapping("Dia_chi_thuong_tru", { sourcePath: "permanentAddress" }),
    mapping("Dia_chi_tam_tru", { sourcePath: "residentialAddress" }),
  ];
  const result = analyzeTemplate({
    html: baseHtml,
    printCss: "",
    baseHtml,
    baseMappings,
    currentMappings: baseMappings,
  });
  const thuongTru = result.diff.items.get("Dia_chi_thuong_tru");
  const tamTru = result.diff.items.get("Dia_chi_tam_tru");
  assert.equal(thuongTru?.current?.sourcePath, "permanentAddress");
  assert.equal(tamTru?.current?.sourcePath, "residentialAddress");
  assert.notEqual(thuongTru?.current?.sourcePath, tamTru?.current?.sourcePath);
});
