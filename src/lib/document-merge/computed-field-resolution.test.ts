/**
 * COMPUTED source-type wiring (H3) — data-resolver.ts's new integration of
 * formula-dsl.ts + signing-context.ts. Uses the real resolveFieldValue /
 * resolveAllFields / validateRequiredFields functions, no mocks.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveFieldValue,
  resolveAllFields,
  validateRequiredFields,
  type MergeContext,
  type RecordData,
} from "./data-resolver.ts";
import type { SigningContext } from "./signing-context.ts";
import { EMPTY_SIGNING_CONTEXT } from "./signing-context.ts";
import type { MergeTemplateField } from "../../db/schema.ts";

function computedField(placeholder: string, expression: string, overrides: Partial<MergeTemplateField> = {}): MergeTemplateField {
  return {
    id: "f-" + placeholder,
    templateId: "tpl-1",
    placeholder,
    sourceType: "COMPUTED",
    sourceEntity: null,
    sourceField: null,
    sourcePath: expression,
    optionValue: null,
    formatType: null,
    fallbackValue: null,
    isRequired: false,
    isOrphaned: false,
    isSuggested: false,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  } as MergeTemplateField;
}

const SIGNING_CONTEXT: SigningContext = {
  ...EMPTY_SIGNING_CONTEXT,
  signingDate: "2026-08-26",
  signingLocation: "Đà Lạt",
  receivedDate: "2026-08-25",
  receivedBy: "Nguyễn Văn A",
};

const RECORD: RecordData = { id: "r1", fullName: "Trần Văn B" };

function ctx(signingContext: SigningContext | undefined = SIGNING_CONTEXT): MergeContext {
  return { currentUserId: "u1", currentUserName: "Tester", currentDate: new Date("2026-08-26"), signingContext };
}

/* -------------------------------------------------------------------- *
 * PHASE 13/14 — the exact priority-candidate mapping examples.
 * -------------------------------------------------------------------- */

test("Ngay_ky_day/month/year resolve from SigningDate via COMPUTED", () => {
  assert.equal(resolveFieldValue(computedField("Ngay_ky_day", "day(SigningDate)"), RECORD, ctx()), "26");
  assert.equal(resolveFieldValue(computedField("Ngay_ky_month", "month(SigningDate)"), RECORD, ctx()), "08");
  assert.equal(resolveFieldValue(computedField("Ngay_ky_year", "year(SigningDate)"), RECORD, ctx()), "2026");
});

test("Nam_thue resolves via year(SigningDate)", () => {
  assert.equal(resolveFieldValue(computedField("Nam_thue", "year(SigningDate)"), RECORD, ctx()), "2026");
});

test("Dia_diem_ky resolves via coalesce(SigningLocation, \"Đà Lạt\") — uses provided location", () => {
  const field = computedField("Dia_diem_ky", 'coalesce(SigningLocation, "Đà Lạt")');
  assert.equal(resolveFieldValue(field, RECORD, ctx()), "Đà Lạt");
  const context = ctx({ ...SIGNING_CONTEXT, signingLocation: "Hà Nội" });
  assert.equal(resolveFieldValue(field, RECORD, context), "Hà Nội");
});

test("Dia_diem_ky falls back to the literal default when SigningLocation is unset", () => {
  const field = computedField("Dia_diem_ky", 'coalesce(SigningLocation, "Đà Lạt")');
  const context = ctx({ ...SIGNING_CONTEXT, signingLocation: null });
  assert.equal(resolveFieldValue(field, RECORD, context), "Đà Lạt");
});

test("Ngay_tiep_nhan resolves via formatDate(ReceivedDate, \"dd/MM/yyyy\")", () => {
  const field = computedField("Ngay_tiep_nhan", 'formatDate(ReceivedDate, "dd/MM/yyyy")');
  assert.equal(resolveFieldValue(field, RECORD, ctx()), "25/08/2026");
});

/* -------------------------------------------------------------------- *
 * resolveAllFields — full-document composition, mixed source types.
 * -------------------------------------------------------------------- */

test("resolveAllFields resolves a mix of CORE_FIELD and COMPUTED placeholders together", () => {
  const fields: MergeTemplateField[] = [
    {
      id: "f-Ho_ten",
      templateId: "tpl-1",
      placeholder: "Ho_ten",
      sourceType: "CORE_FIELD",
      sourceEntity: null,
      sourceField: null,
      sourcePath: "fullName",
      optionValue: null,
      formatType: "RAW",
      fallbackValue: null,
      isRequired: true,
      isOrphaned: false,
      isSuggested: false,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    } as MergeTemplateField,
    computedField("Ngay_ky_day", "day(SigningDate)"),
    computedField("Ngay_ky_month", "month(SigningDate)"),
    computedField("Ngay_ky_year", "year(SigningDate)"),
    computedField("Dia_diem_ky", 'coalesce(SigningLocation, "Đà Lạt")'),
  ];
  const values = resolveAllFields(fields, RECORD, ctx());
  assert.deepEqual(values, {
    Ho_ten: "Trần Văn B",
    Ngay_ky_day: "26",
    Ngay_ky_month: "08",
    Ngay_ky_year: "2026",
    Dia_diem_ky: "Đà Lạt",
  });
});

/* -------------------------------------------------------------------- *
 * PHASE 24 — required/optional semantics: never a literal tag on failure.
 * -------------------------------------------------------------------- */

test("a REQUIRED computed placeholder with no Signing Context resolves to empty and is caught by validateRequiredFields — never a literal tag", () => {
  const field = computedField("Ngay_ky_day", "day(SigningDate)", { isRequired: true });
  // No signingContext at all in the MergeContext — resolveComputedExpression
  // must fall back to EMPTY_SIGNING_CONTEXT, not throw.
  const context: MergeContext = { currentUserId: "u1" };
  const value = resolveFieldValue(field, RECORD, context);
  assert.equal(value, "");
  const { valid, missingFields } = validateRequiredFields([field], { Ngay_ky_day: value });
  assert.equal(valid, false);
  assert.deepEqual(missingFields, ["Ngay_ky_day"]);
});

test("an OPTIONAL computed placeholder with no Signing Context resolves to empty and does NOT block required-field validation", () => {
  const field = computedField("Ngay_ky_day", "day(SigningDate)", { isRequired: false });
  const context: MergeContext = { currentUserId: "u1" };
  const value = resolveFieldValue(field, RECORD, context);
  assert.equal(value, "");
  const { valid } = validateRequiredFields([field], { Ngay_ky_day: value });
  assert.equal(valid, true);
});

test("a genuinely broken formula (e.g. saved before validation existed) NEVER throws — resolves to fallbackValue, never crashes the render", () => {
  const field = computedField("Ngay_ky_day", "not_a_real_function(SigningDate)", { fallbackValue: "N/A" });
  assert.doesNotThrow(() => resolveFieldValue(field, RECORD, ctx()));
  assert.equal(resolveFieldValue(field, RECORD, ctx()), "N/A");
});

test("a broken formula with no fallbackValue resolves to empty string, not a thrown error or a literal tag", () => {
  const field = computedField("Ngay_ky_day", "not_a_real_function(SigningDate)");
  assert.equal(resolveFieldValue(field, RECORD, ctx()), "");
});

test("an invalid date value (unparseable) resolves to empty rather than propagating a raw error", () => {
  const field = computedField("Ngay_ky_day", "day(SigningDate)");
  const context = ctx({ ...SIGNING_CONTEXT, signingDate: "not-a-date" });
  assert.equal(resolveFieldValue(field, RECORD, context), "");
});

/* -------------------------------------------------------------------- *
 * COMPUTED_FIELD (legacy fixed-enum computed values) is untouched.
 * -------------------------------------------------------------------- */

test("legacy COMPUTED_FIELD (distinct source type) is unaffected by the new COMPUTED wiring", () => {
  const field = {
    id: "f-year",
    templateId: "tpl-1",
    placeholder: "Legacy_year",
    sourceType: "COMPUTED_FIELD",
    sourceEntity: null,
    sourceField: "CURRENT_YEAR",
    sourcePath: null,
    optionValue: null,
    formatType: null,
    fallbackValue: null,
    isRequired: false,
    isOrphaned: false,
    isSuggested: false,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as MergeTemplateField;
  assert.equal(resolveFieldValue(field, RECORD, ctx()), "2026");
});

/* -------------------------------------------------------------------- *
 * PHASE 19 — batch determinism: same context, many records, same result.
 * -------------------------------------------------------------------- */

test("PHASE 19: 130 synthetic records all resolve the SAME computed dates from the SAME frozen context, regardless of per-record processing order", () => {
  const fields: MergeTemplateField[] = [
    computedField("Ngay_ky_day", "day(SigningDate)"),
    computedField("Ngay_ky_month", "month(SigningDate)"),
    computedField("Ngay_ky_year", "year(SigningDate)"),
  ];
  const frozenContext = ctx(SIGNING_CONTEXT); // resolved ONCE, reused for every record below
  const results: Record<string, string>[] = [];
  for (let i = 0; i < 130; i += 1) {
    const record: RecordData = { id: `r${i}`, fullName: `Ứng viên ${i}` };
    results.push(resolveAllFields(fields, record, frozenContext));
  }
  assert.equal(results.length, 130);
  for (const r of results) {
    assert.deepEqual(r, { Ngay_ky_day: "26", Ngay_ky_month: "08", Ngay_ky_year: "2026" });
  }
});
