/**
 * ADDRESS SEMANTICS — permanentAddress vs residentialAddress.
 *
 * These are TWO DIFFERENT business fields:
 *
 *   Địa chỉ thường trú (permanent / hộ khẩu) -> permanentAddress
 *   Địa chỉ cư trú     (current residence)   -> residentialAddress
 *   Địa chỉ tạm trú    (temporary residence) -> residentialAddress
 *
 * Equality is ALLOWED (a worker may live at their permanent address).
 * Aliasing / fallback is NOT: a blank field must render blank and must never
 * be filled from the other field.
 *
 * Regression origin: `dia_chi_cu_tru` was aliased to permanentAddress, so a
 * worker with permanentAddress="Quảng Ngãi" and residentialAddress="Đơn Dương"
 * had "Quảng Ngãi" printed into the tax-registration residence line.
 *
 * These tests MUST fail if an alias/fallback is ever reintroduced.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { MergeTemplateField } from "../../db/schema.ts";
import { resolveAllFields, validateRequiredFields } from "./data-resolver.ts";
import { applyFallbackPlaceholders, FALLBACK_PLACEHOLDER_MAP } from "./preview-merge.ts";
import { renderCanonicalDocument, type CanonicalMapping } from "./canonical-document.ts";
import { DEFAULT_MAX_ATTEMPTS, isRetryableItemError, shouldRetry } from "./queue-types.ts";

const PERMANENT_TEST_VALUE = "PERMANENT_TEST_VALUE";
const RESIDENTIAL_TEST_VALUE = "RESIDENTIAL_TEST_VALUE";

const CONTEXT = {
  currentUserId: "test",
  currentDate: new Date("2026-08-23T00:00:00.000Z"),
  mergeIndex: 1,
  mergeCount: 1,
};

/**
 * AUTHORITATIVE PRODUCTION MAPPING (operator-verified in merge_template_fields):
 *
 *   Dia_chi_thuong_tru -> permanentAddress   is_required = false
 *   dia_chi_cu_tru     -> residentialAddress is_required = false
 *   Dia_chi_tam_tru    -> residentialAddress is_required = true
 *
 * The static catalog marks Dia_chi_thuong_tru required=true; the mapping
 * snapshot must win at runtime.
 */
function addressMappings(): CanonicalMapping[] {
  const row = (placeholder: string, sourcePath: string, isRequired: boolean): CanonicalMapping => ({
    placeholder,
    sourceType: "CORE_FIELD",
    sourceEntity: null,
    sourceField: null,
    sourcePath,
    optionValue: null,
    formatType: null,
    fallbackValue: null,
    isRequired,
  });
  return [
    row("Dia_chi_thuong_tru", "permanentAddress", false),
    row("dia_chi_cu_tru", "residentialAddress", false),
    row("Dia_chi_tam_tru", "residentialAddress", true),
  ];
}

function asFields(mappings: CanonicalMapping[]): MergeTemplateField[] {
  return mappings.map((m) => ({
    id: "",
    templateId: "",
    ...m,
    isOrphaned: false,
    isSuggested: false,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  })) as MergeTemplateField[];
}

/** Full runtime path: mapping resolution + unmapped-placeholder fallback. */
function resolve(record: Record<string, unknown>, mappings = addressMappings()) {
  const fields = asFields(mappings);
  const mapped = resolveAllFields(fields, record, CONTEXT);
  return applyFallbackPlaceholders(record, mapped);
}

const blank = (v: string | undefined) => v === undefined || v.trim() === "";

// ===============================================================
// The alias table itself
// ===============================================================

test("fallback alias table never points a residence placeholder at permanentAddress", () => {
  assert.equal(FALLBACK_PLACEHOLDER_MAP.Dia_chi_thuong_tru, "permanentAddress");
  assert.equal(FALLBACK_PLACEHOLDER_MAP.dia_chi_cu_tru, "residentialAddress");
  assert.equal(FALLBACK_PLACEHOLDER_MAP.Dia_chi_tam_tru, "residentialAddress");

  // No permanent-address placeholder may resolve to residentialAddress...
  for (const key of ["Dia_chi_thuong_tru", "permanentAddress"]) {
    assert.notEqual(FALLBACK_PLACEHOLDER_MAP[key], "residentialAddress", `${key} must not read residentialAddress`);
  }
  // ...and no residence placeholder may resolve to permanentAddress.
  for (const key of ["dia_chi_cu_tru", "Dia_chi_tam_tru", "Dia_chi", "Dia_chi_hien_tai", "residentialAddress"]) {
    assert.notEqual(FALLBACK_PLACEHOLDER_MAP[key], "permanentAddress", `${key} must not read permanentAddress`);
  }
});

// ===============================================================
// PHASE 7 — required scenarios
// ===============================================================

test("DIFFERENT_ADDRESS_TEST: distinct values stay in their own placeholders", () => {
  const values = resolve({
    id: "a",
    permanentAddress: PERMANENT_TEST_VALUE,
    residentialAddress: RESIDENTIAL_TEST_VALUE,
    customAnswers: {},
  });

  assert.equal(values.Dia_chi_thuong_tru, PERMANENT_TEST_VALUE);
  assert.equal(values.dia_chi_cu_tru, RESIDENTIAL_TEST_VALUE);
  assert.equal(values.Dia_chi_tam_tru, RESIDENTIAL_TEST_VALUE);

  // Neither value bleeds into the other's slot.
  assert.notEqual(values.Dia_chi_thuong_tru, RESIDENTIAL_TEST_VALUE);
  assert.notEqual(values.dia_chi_cu_tru, PERMANENT_TEST_VALUE);
  assert.notEqual(values.Dia_chi_tam_tru, PERMANENT_TEST_VALUE);
});

test("BLANK_PERMANENT_TEST: blank permanent stays blank, residence keeps its value", () => {
  const values = resolve({
    id: "b",
    permanentAddress: null,
    residentialAddress: RESIDENTIAL_TEST_VALUE,
    customAnswers: {},
  });

  assert.ok(blank(values.Dia_chi_thuong_tru), `expected blank, got ${JSON.stringify(values.Dia_chi_thuong_tru)}`);
  assert.equal(values.dia_chi_cu_tru, RESIDENTIAL_TEST_VALUE);
  assert.equal(values.Dia_chi_tam_tru, RESIDENTIAL_TEST_VALUE);
  // The exact incident regression.
  assert.notEqual(values.Dia_chi_thuong_tru, RESIDENTIAL_TEST_VALUE);
});

test("BLANK_RESIDENTIAL_TEST: blank residence stays blank, permanent keeps its value", () => {
  const values = resolve({
    id: "c",
    permanentAddress: PERMANENT_TEST_VALUE,
    residentialAddress: null,
    customAnswers: {},
  });

  assert.equal(values.Dia_chi_thuong_tru, PERMANENT_TEST_VALUE);
  assert.ok(blank(values.dia_chi_cu_tru), `expected blank, got ${JSON.stringify(values.dia_chi_cu_tru)}`);
  assert.ok(blank(values.Dia_chi_tam_tru), `expected blank, got ${JSON.stringify(values.Dia_chi_tam_tru)}`);
  assert.notEqual(values.dia_chi_cu_tru, PERMANENT_TEST_VALUE);
});

test("CASE C: blank residence fails validation for Dia_chi_tam_tru ONLY (required in Production)", () => {
  // Dia_chi_tam_tru is is_required=true in the authoritative mapping, so a
  // blank residentialAddress is a deterministic validation failure — but it
  // must NOT be repaired by copying the permanent address, and the optional
  // placeholders must not be reported.
  const mappings = addressMappings();
  const fields = asFields(mappings);
  const values = resolve(
    { id: "c2", permanentAddress: PERMANENT_TEST_VALUE, residentialAddress: null, customAnswers: {} },
    mappings,
  );

  const missing: string[] = [...validateRequiredFields(fields, values).missingFields];
  assert.deepEqual(missing, ["Dia_chi_tam_tru"]);

  // No silent repair from the permanent address.
  assert.ok(blank(values.Dia_chi_tam_tru));
  assert.ok(blank(values.dia_chi_cu_tru));
  assert.notEqual(values.Dia_chi_tam_tru, PERMANENT_TEST_VALUE);
});

test("CASE C: required-blank is a NON-RETRYABLE terminal failure, transient stays retryable", () => {
  // A required blank surfaces as INCOMPLETE, which must fail immediately
  // (retry cannot supply missing data) while infrastructure errors still retry.
  assert.equal(isRetryableItemError("INCOMPLETE"), false);
  assert.equal(isRetryableItemError("INCOMPLETE") && shouldRetry(1, DEFAULT_MAX_ATTEMPTS), false);
  for (const transient of ["CHROMIUM_LAUNCH_FAILED", "PDF_RENDER_TIMEOUT", "STORAGE_UPLOAD_FAILED"]) {
    assert.equal(isRetryableItemError(transient), true, `${transient} must remain retryable`);
  }
});

test("equal permanent and residential values are allowed (not treated as an error)", () => {
  const same = "SAME_ADDRESS_VALUE";
  const values = resolve({ id: "d", permanentAddress: same, residentialAddress: same, customAnswers: {} });
  assert.equal(values.Dia_chi_thuong_tru, same);
  assert.equal(values.dia_chi_cu_tru, same);
});

test("both addresses blank → both render blank, neither invents a value", () => {
  const values = resolve({ id: "e", permanentAddress: null, residentialAddress: null, customAnswers: {} });
  assert.ok(blank(values.Dia_chi_thuong_tru));
  assert.ok(blank(values.dia_chi_cu_tru));
  assert.ok(blank(values.Dia_chi_tam_tru));
});

test("UNMAPPED placeholders (fallback path only) also respect address semantics", () => {
  // No mapping rows at all — this is the path where FALLBACK_PLACEHOLDER_MAP
  // is the sole authority, and where the original alias defect lived.
  const values = applyFallbackPlaceholders(
    { id: "f", permanentAddress: PERMANENT_TEST_VALUE, residentialAddress: RESIDENTIAL_TEST_VALUE, customAnswers: {} },
    {},
  );
  assert.equal(values.Dia_chi_thuong_tru, PERMANENT_TEST_VALUE);
  assert.equal(values.dia_chi_cu_tru, RESIDENTIAL_TEST_VALUE);
  assert.equal(values.Dia_chi_tam_tru, RESIDENTIAL_TEST_VALUE);
});

test("UNMAPPED + blank permanent → residence value must NOT leak into the permanent slot", () => {
  const values = applyFallbackPlaceholders(
    { id: "g", permanentAddress: null, residentialAddress: RESIDENTIAL_TEST_VALUE, customAnswers: {} },
    {},
  );
  assert.ok(blank(values.Dia_chi_thuong_tru));
  assert.equal(values.dia_chi_cu_tru, RESIDENTIAL_TEST_VALUE);
});

// ===============================================================
// Requiredness authority (mapping wins over the static catalog)
// ===============================================================

test("blank permanent with is_required=false does NOT cause INCOMPLETE", () => {
  const mappings = addressMappings();
  const fields = asFields(mappings);
  const record = { id: "h", permanentAddress: null, residentialAddress: RESIDENTIAL_TEST_VALUE, customAnswers: {} };
  const values = resolve(record, mappings);

  const validation = validateRequiredFields(fields, values);
  const missing: string[] = [...validation.missingFields];
  // A blank OPTIONAL permanent address must never be reported as missing.
  assert.equal(missing.includes("Dia_chi_thuong_tru"), false);
  assert.equal(validation.valid, true, JSON.stringify(missing));
  assert.equal(missing.length, 0, JSON.stringify(missing));
});

test("mapping is_required=false overrides catalog required=true for addresses", () => {
  // Catalog marks Dia_chi_thuong_tru / Dia_chi_tam_tru required; the mapping
  // snapshot says optional. Mapping must win at runtime.
  const mappings = addressMappings();
  const snapshot = {
    templateId: "tpl-1",
    templateVersion: 1,
    htmlBody:
      '<div class="page"><p>TT:[{{Dia_chi_thuong_tru}}] CT:[{{dia_chi_cu_tru}}] TAM:[{{Dia_chi_tam_tru}}]</p></div>',
    printCss: null,
    mappings,
    formatting: { contractKey: "dang-ky-tap-nghe", retentionYears: 3, documentKind: "B", templateName: "t" },
  };

  const rendered = renderCanonicalDocument(
    snapshot,
    { id: "i", permanentAddress: null, residentialAddress: RESIDENTIAL_TEST_VALUE, customAnswers: {} },
    CONTEXT,
  );

  assert.equal(rendered.valid, true, JSON.stringify(rendered.missingFields));
  assert.deepEqual(rendered.missingFields, []);
  assert.match(rendered.html, /TT:\[\]/, "permanent slot must render empty");
  assert.match(rendered.html, new RegExp(`CT:\\[${RESIDENTIAL_TEST_VALUE}\\]`));
  assert.match(rendered.html, new RegExp(`TAM:\\[${RESIDENTIAL_TEST_VALUE}\\]`));
});

// ===============================================================
// Preview / Worker address parity
// ===============================================================

test("ADDRESS_PARITY: Preview and Worker resolve identical address values", () => {
  const mappings = addressMappings();
  const snapshot = {
    templateId: "tpl-1",
    templateVersion: 1,
    htmlBody:
      '<div class="page"><p>TT:[{{Dia_chi_thuong_tru}}] CT:[{{dia_chi_cu_tru}}] TAM:[{{Dia_chi_tam_tru}}]</p></div>',
    printCss: ".page{color:#000}",
    mappings,
    formatting: { contractKey: "dang-ky-tap-nghe", retentionYears: 3, documentKind: "B", templateName: "t" },
  };
  const record = { id: "j", permanentAddress: null, residentialAddress: RESIDENTIAL_TEST_VALUE, customAnswers: {} };

  const preview = renderCanonicalDocument(snapshot, record, CONTEXT);
  // Worker re-hydrates the same snapshot from merge_jobs.metadata JSON.
  const worker = renderCanonicalDocument(JSON.parse(JSON.stringify(snapshot)), record, CONTEXT);

  assert.equal(preview.html, worker.html);
  const grab = (html: string, label: string) => html.match(new RegExp(`${label}:\\[([^\\]]*)\\]`))?.[1] ?? null;
  assert.equal(grab(preview.html, "TT"), grab(worker.html, "TT"));
  assert.equal(grab(preview.html, "CT"), grab(worker.html, "CT"));
  assert.equal(grab(preview.html, "TT"), "");
  assert.equal(grab(preview.html, "CT"), RESIDENTIAL_TEST_VALUE);
});
