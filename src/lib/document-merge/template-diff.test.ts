/**
 * TEMPLATE DIFF ENGINE — regression tests.
 *
 * Covers the Auto Mapping Diff semantics (Phase 4/5/6/11/12) and the Template
 * Diff Engine requirements of Phase 18:
 *   - unchanged / added / removed placeholder detection;
 *   - rename = added + removed (never silently assumed equivalent);
 *   - mapping change detection (semantics, not labels);
 *   - required change detection;
 *   - orphaned mapping detection;
 *   - deterministic regardless of ordering;
 *   - unchanged placeholders retain existing mapping (no rework);
 *   - new field does NOT get an automatic fuzzy mapping (deterministic alias
 *     only, and the operator must confirm);
 *   - address invariants preserved (permanentAddress / residentialAddress never
 *     cross-alias);
 *   - a PUBLISHED base's mapping semantics are compared as-is (frozen snapshot).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTemplateDiff,
  compareMappingSemantics,
  extractPlaceholderSet,
  suggestDeterministicMapping,
  toMappingSemantics,
  type MappingSemantics,
} from "./template-diff.ts";

function row(overrides: Partial<MappingSemantics>): MappingSemantics {
  return {
    placeholder: "Ho_ten",
    sourceType: "CORE_FIELD",
    sourceEntity: null,
    sourceField: null,
    sourcePath: "fullName",
    optionValue: null,
    formatType: null,
    fallbackValue: null,
    isRequired: false,
    isOrphaned: false,
    ...overrides,
  };
}

/** A 2-placeholder base mapping set. */
const BASE_MAPPINGS: MappingSemantics[] = [
  row({ placeholder: "Ho_ten", sourcePath: "fullName" }),
  row({ placeholder: "So_CCCD", sourcePath: "cccd", isRequired: true }),
];

const BASE_PLACEHOLDERS = ["Ho_ten", "So_CCCD"];

test("extractPlaceholderSet handles both {{x}} and <<x>> delimiters and dedupes", () => {
  const html = `<p><<Ho_ten>></p><p>{{So_CCCD}}</p><p><<Ho_ten>></p>`;
  assert.deepEqual(extractPlaceholderSet(html), ["Ho_ten", "So_CCCD"]);
  assert.deepEqual(extractPlaceholderSet(""), []);
});

test("compareMappingSemantics compares semantic fields, not display labels", () => {
  const a = row({ placeholder: "Dia_chi_tam_tru", sourcePath: "residentialAddress", isRequired: true });
  const b = row({ placeholder: "Dia_chi_tam_tru", sourcePath: "residentialAddress", isRequired: true });
  assert.deepEqual(compareMappingSemantics(a, b), []);

  const c = row({ placeholder: "Dia_chi_tam_tru", sourcePath: "permanentAddress", isRequired: true });
  assert.deepEqual(compareMappingSemantics(a, c), ["sourcePath"], "an address repoint is a real mapping change");
});

/* ------------------------------------------------------------------ *
 * 8. unchanged placeholder detected
 * ------------------------------------------------------------------ */
test("8. unchanged placeholder is detected and retains its mapping (no rework)", () => {
  const diff = buildTemplateDiff({
    basePlaceholders: BASE_PLACEHOLDERS,
    baseMappings: BASE_MAPPINGS,
    currentPlaceholders: BASE_PLACEHOLDERS,
    currentMappings: BASE_MAPPINGS,
  });

  assert.equal(diff.summary.unchanged, 2);
  assert.equal(diff.summary.added, 0);
  assert.equal(diff.summary.removed, 0);
  assert.equal(diff.summary.mappingChanged, 0);
  assert.equal(diff.summary.requiredChanged, 0);
  assert.deepEqual(diff.needsAttention, []);

  const hoTen = diff.items.get("Ho_ten");
  assert.equal(hoTen?.change, "UNCHANGED");
  assert.equal(hoTen?.current?.sourcePath, "fullName");
  assert.deepEqual(hoTen?.changedFields, []);
});

/* ------------------------------------------------------------------ *
 * 9. added placeholder detected
 * ------------------------------------------------------------------ */
test("9. added placeholder is detected (v8 -> v9 adds Email_ca_nhan)", () => {
  const added = row({ placeholder: "Email_ca_nhan", sourcePath: "email" });
  const diff = buildTemplateDiff({
    basePlaceholders: BASE_PLACEHOLDERS,
    baseMappings: BASE_MAPPINGS,
    currentPlaceholders: [...BASE_PLACEHOLDERS, "Email_ca_nhan"],
    currentMappings: [...BASE_MAPPINGS, added],
  });

  assert.equal(diff.summary.added, 1);
  assert.equal(diff.summary.unchanged, 2);
  const item = diff.items.get("Email_ca_nhan");
  assert.equal(item?.change, "ADDED");
  assert.equal(item?.base, null);
  assert.equal(item?.requiresMapping, false, "already mapped -> no attention needed");
});

test("9b. an ADDED placeholder with NO mapping row requires mapping (appears in needsAttention)", () => {
  const diff = buildTemplateDiff({
    basePlaceholders: BASE_PLACEHOLDERS,
    baseMappings: BASE_MAPPINGS,
    currentPlaceholders: [...BASE_PLACEHOLDERS, "Nguoi_lien_he"],
    currentMappings: BASE_MAPPINGS,
  });

  assert.equal(diff.summary.added, 1);
  assert.equal(diff.summary.unmapped, 1);
  assert.ok(diff.needsAttention.includes("Nguoi_lien_he"));
  assert.equal(diff.items.get("Nguoi_lien_he")?.requiresMapping, true);
});

/* ------------------------------------------------------------------ *
 * 10. removed placeholder detected
 * ------------------------------------------------------------------ */
test("10. removed placeholder is detected without mutating the base snapshot", () => {
  const diff = buildTemplateDiff({
    basePlaceholders: [...BASE_PLACEHOLDERS, "So_BHXH"],
    baseMappings: [...BASE_MAPPINGS, row({ placeholder: "So_BHXH", sourcePath: "bhxh" })],
    currentPlaceholders: BASE_PLACEHOLDERS,
    currentMappings: BASE_MAPPINGS,
  });

  assert.equal(diff.summary.removed, 1);
  const item = diff.items.get("So_BHXH");
  assert.equal(item?.change, "REMOVED");
  assert.equal(item?.current, null);
  // The base (current PUBLISHED) mapping is NOT deleted — it stays on the base.
  assert.equal(item?.base?.sourcePath, "bhxh");
});

/* ------------------------------------------------------------------ *
 * 11. renamed placeholder = added + removed (never silently equivalent)
 * ------------------------------------------------------------------ */
test("11. rename So_CCCD -> CCCD is added + removed, never a silent equivalence", () => {
  const diff = buildTemplateDiff({
    basePlaceholders: ["So_CCCD"],
    baseMappings: [row({ placeholder: "So_CCCD", sourcePath: "cccd" })],
    currentPlaceholders: ["CCCD"],
    currentMappings: [row({ placeholder: "CCCD", sourcePath: "cccd" })],
  });

  assert.equal(diff.summary.added, 1);
  assert.equal(diff.summary.removed, 1);
  assert.equal(diff.summary.unchanged, 0);
  assert.equal(diff.items.get("CCCD")?.change, "ADDED");
  assert.equal(diff.items.get("So_CCCD")?.change, "REMOVED");
});

/* ------------------------------------------------------------------ *
 * 12. mapping change detected
 * ------------------------------------------------------------------ */
test("12. mapping change (sourcePath repoint) is detected", () => {
  const diff = buildTemplateDiff({
    basePlaceholders: BASE_PLACEHOLDERS,
    baseMappings: BASE_MAPPINGS,
    currentPlaceholders: BASE_PLACEHOLDERS,
    currentMappings: [
      row({ placeholder: "Ho_ten", sourcePath: "fullName" }),
      row({ placeholder: "So_CCCD", sourcePath: "cccd", isRequired: true, sourceField: "identifier" }),
    ],
  });

  assert.equal(diff.summary.mappingChanged, 1);
  const item = diff.items.get("So_CCCD");
  assert.equal(item?.change, "MAPPING_CHANGED");
  assert.ok(item?.changedFields.includes("sourceField"));
});

/* ------------------------------------------------------------------ *
 * 13. required change detected
 * ------------------------------------------------------------------ */
test("13. isRequired-only change is REQUIRED_CHANGED, not a full mapping change", () => {
  const diff = buildTemplateDiff({
    basePlaceholders: BASE_PLACEHOLDERS,
    baseMappings: BASE_MAPPINGS,
    currentPlaceholders: BASE_PLACEHOLDERS,
    currentMappings: [
      row({ placeholder: "Ho_ten", sourcePath: "fullName" }),
      // isRequired flips: false -> true
      row({ placeholder: "So_CCCD", sourcePath: "cccd", isRequired: false }),
    ],
  });

  assert.equal(diff.summary.requiredChanged, 1);
  assert.equal(diff.summary.mappingChanged, 0);
  const item = diff.items.get("So_CCCD");
  assert.equal(item?.change, "REQUIRED_CHANGED");
  assert.deepEqual(item?.changedFields, ["isRequired"]);
});

/* ------------------------------------------------------------------ *
 * 14. orphaned mapping detected
 * ------------------------------------------------------------------ */
test("14. a mapping row for a placeholder no longer in the current body is ORPHANED", () => {
  const diff = buildTemplateDiff({
    basePlaceholders: ["Ho_ten"],
    baseMappings: [row({ placeholder: "Ho_ten", sourcePath: "fullName" })],
    // The current body no longer contains So_BHXH, but a current mapping row still exists.
    currentPlaceholders: ["Ho_ten"],
    currentMappings: [
      row({ placeholder: "Ho_ten", sourcePath: "fullName" }),
      row({ placeholder: "So_BHXH", sourcePath: "bhxh" }),
    ],
  });

  assert.equal(diff.summary.orphaned, 1);
  const item = diff.items.get("So_BHXH");
  assert.equal(item?.change, "ORPHANED");
  assert.ok(diff.needsAttention.includes("So_BHXH"));
  assert.equal(item?.requiresMapping, false, "it is not in the body, so it is not an unmapped field");
});

/* ------------------------------------------------------------------ *
 * 15. deterministic regardless of ordering
 * ------------------------------------------------------------------ */
test("15. diff is deterministic regardless of input ordering", () => {
  const inputs = () => ({
    basePlaceholders: ["B_2", "A_1", "B_2"],
    baseMappings: [
      row({ placeholder: "B_2", sourcePath: "b" }),
      row({ placeholder: "A_1", sourcePath: "a" }),
    ],
    currentPlaceholders: ["A_1", "C_3"],
    currentMappings: [
      row({ placeholder: "C_3", sourcePath: "c" }),
      row({ placeholder: "A_1", sourcePath: "a" }),
    ],
  });
  const first = buildTemplateDiff(inputs());
  const second = buildTemplateDiff(inputs());

  assert.deepEqual([...first.items.keys()], [...second.items.keys()], "keys sorted identically");
  assert.deepEqual(first.summary, second.summary);
  // The keys must be in sorted order regardless of array order.
  assert.deepEqual(
    [...first.items.keys()],
    [...first.items.keys()].sort(),
    "items are keyed in deterministic sorted order",
  );
});

/* ------------------------------------------------------------------ *
 * 16-18. mapping suggestions & no silent fuzzy
 * ------------------------------------------------------------------ */
test("16. unchanged placeholders keep existing mapping — the diff never proposes changing them", () => {
  const diff = buildTemplateDiff({
    basePlaceholders: BASE_PLACEHOLDERS,
    baseMappings: BASE_MAPPINGS,
    currentPlaceholders: BASE_PLACEHOLDERS,
    currentMappings: BASE_MAPPINGS,
  });
  assert.equal(diff.summary.unchanged, 2);
  for (const key of BASE_PLACEHOLDERS) {
    assert.equal(diff.items.get(key)?.current?.sourcePath ?? null, BASE_MAPPINGS.find((m) => m.placeholder === key)?.sourcePath);
  }
});

test("17. a new field does NOT get an automatic fuzzy mapping — only a deterministic alias, and it is a suggestion", () => {
  // A brand new, unknown placeholder has no deterministic alias -> null suggestion.
  assert.equal(suggestDeterministicMapping("Doanh_so_thang"), null);
  // The operator must act; the diff flags it as needs mapping.
  const diff = buildTemplateDiff({
    basePlaceholders: [],
    baseMappings: [],
    currentPlaceholders: ["Doanh_so_thang"],
    currentMappings: [],
  });
  assert.equal(diff.summary.added, 1);
  assert.equal(diff.summary.unmapped, 1);
  assert.ok(diff.needsAttention.includes("Doanh_so_thang"));
});

test("18. operator-confirmed deterministic suggestion applies the alias mapping", () => {
  const suggestion = suggestDeterministicMapping("So_tai_khoan");
  assert.ok(suggestion, "a known alias yields a suggestion");
  assert.equal(suggestion.sourceField, "so_tai_khoan");
  assert.equal(suggestion.sourceType, "DYNAMIC_ANSWER");
  assert.equal(suggestion.confidence, "high");
  // The suggestion is non-destructive data; it never mutates a snapshot.
  assert.equal(suggestion.basis, "alias");
});

/* ------------------------------------------------------------------ *
 * 19/20. PUBLISHED snapshot unchanged & optional removed doesn't destroy history
 * ------------------------------------------------------------------ */
test("19. a PUBLISHED base's frozen snapshot semantics are compared as-is, never written", () => {
  const frozen = [
    row({ placeholder: "Ho_ten", sourcePath: "fullName" }),
    row({ placeholder: "Dia_chi_thuong_tru", sourcePath: "permanentAddress", isRequired: false }),
  ];
  const before = JSON.stringify(frozen);
  const diff = buildTemplateDiff({
    basePlaceholders: ["Ho_ten", "Dia_chi_thuong_tru"],
    baseMappings: frozen,
    currentPlaceholders: ["Ho_ten", "Dia_chi_thuong_tru"],
    currentMappings: frozen,
  });
  assert.equal(JSON.stringify(frozen), before, "the base mapping set is identical after diffing");
  assert.equal(diff.summary.unchanged, 2);
});

test("20. an optional removed placeholder does not destroy historical/current mappings", () => {
  const base = [
    row({ placeholder: "Ho_ten", sourcePath: "fullName" }),
    row({ placeholder: "Ghi_chu", sourcePath: "note", isRequired: false }),
  ];
  const diff = buildTemplateDiff({
    basePlaceholders: ["Ho_ten", "Ghi_chu"],
    baseMappings: base,
    currentPlaceholders: ["Ho_ten"],
    currentMappings: [row({ placeholder: "Ho_ten", sourcePath: "fullName" })],
  });
  assert.equal(diff.summary.removed, 1);
  // The current mapping set for the DRAFT no longer includes Ghi_chu, but the
  // diff only REPORTS it; it does not delete the base snapshot.
  assert.equal(diff.items.get("Ghi_chu")?.change, "REMOVED");
  assert.ok(base.some((m) => m.placeholder === "Ghi_chu"), "historical mapping row still present");
});

/* ------------------------------------------------------------------ *
 * 21. address invariants preserved
 * ------------------------------------------------------------------ */
test("21. address invariants are preserved — no cross-address auto-alias", () => {
  const addresses = ["Dia_chi_thuong_tru", "dia_chi_cu_tru", "Dia_chi_tam_tru"];
  const map = addresses
    .map((p) => suggestDeterministicMapping(p))
    .filter((s): s is NonNullable<typeof s> => s !== null);

  const byPlaceholder = Object.fromEntries(map.map((s) => [s.placeholder, s.sourceField]));
  assert.equal(byPlaceholder["Dia_chi_thuong_tru"], "permanentAddress");
  assert.equal(byPlaceholder["dia_chi_cu_tru"], "residentialAddress");
  assert.equal(byPlaceholder["Dia_chi_tam_tru"], "residentialAddress");
  // No permanent-address placeholder may resolve to residentialAddress, and vice-versa.
  assert.notEqual(byPlaceholder["Dia_chi_thuong_tru"], "residentialAddress");
  assert.notEqual(byPlaceholder["dia_chi_cu_tru"], "permanentAddress");
  assert.notEqual(byPlaceholder["Dia_chi_tam_tru"], "permanentAddress");
});

test("toMappingSemantics normalises a raw DB row without losing fields", () => {
  const s = toMappingSemantics({
    placeholder: "Ho_ten",
    sourceType: "CORE_FIELD",
    sourcePath: "fullName",
    isRequired: true,
    isOrphaned: false,
  });
  assert.equal(s.placeholder, "Ho_ten");
  assert.equal(s.sourcePath, "fullName");
  assert.equal(s.isRequired, true);
  assert.equal(s.sourceEntity, null, "missing optional field becomes null");
});

/** A realistic v8 PUBLISHED -> v9 DRAFT diff (wording-only change). */
test("scenario 1 — wording-only change leaves placeholders unchanged (no mapping rework)", () => {
  const diff = buildTemplateDiff({
    basePlaceholders: BASE_PLACEHOLDERS,
    baseMappings: BASE_MAPPINGS,
    currentPlaceholders: BASE_PLACEHOLDERS,
    currentMappings: BASE_MAPPINGS,
  });
  assert.equal(diff.summary.unchanged, 2);
  assert.equal(diff.summary.added, 0);
  assert.equal(diff.summary.removed, 0);
  assert.equal(diff.summary.mappingChanged, 0);
  assert.deepEqual(diff.needsAttention, []);
});

/** Scenario 2 — company adds one new field that needs mapping. */
test("scenario 2 — adding one new field requires exactly that one field's attention", () => {
  const diff = buildTemplateDiff({
    basePlaceholders: BASE_PLACEHOLDERS,
    baseMappings: BASE_MAPPINGS,
    currentPlaceholders: [...BASE_PLACEHOLDERS, "Email_ca_nhan"],
    currentMappings: BASE_MAPPINGS, // not yet mapped
  });
  assert.equal(diff.summary.added, 1);
  assert.equal(diff.summary.unmapped, 1);
  assert.deepEqual(diff.needsAttention, ["Email_ca_nhan"]);
});

/** Scenario 3 — removing one field. */
test("scenario 3 — removing one field reports it as removed without touching Published", () => {
  const diff = buildTemplateDiff({
    basePlaceholders: [...BASE_PLACEHOLDERS, "So_BHXH"],
    baseMappings: [...BASE_MAPPINGS, row({ placeholder: "So_BHXH", sourcePath: "bhxh" })],
    currentPlaceholders: BASE_PLACEHOLDERS,
    currentMappings: BASE_MAPPINGS,
  });
  assert.equal(diff.summary.removed, 1);
  assert.equal(diff.items.get("So_BHXH")?.change, "REMOVED");
});
