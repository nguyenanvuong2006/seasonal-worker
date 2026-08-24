/**
 * DRAFT VERSION PREVIEW — pure logic regression tests.
 *
 * Locks the version/mapping semantics that make a pre-publish preview safe:
 *   - a PUBLISHED version keeps its immutable frozen mapping_snapshot;
 *   - a DRAFT (snapshot = []) resolves the CURRENT non-orphaned
 *     merge_template_fields — the same set pre-publish validation reads;
 *   - data-scope predicate cannot be satisfied by an out-of-scope candidate.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DRAFT_PREVIEW_BANNER_VI,
  DRAFT_PREVIEW_MAPPING_SOURCE,
  DRAFT_PREVIEW_MODE,
  isCandidateInScope,
  isUnpublishedPreview,
  parseDraftPreviewRequest,
  selectPreviewMappings,
  summarizePreviewMappings,
  toPreviewMappings,
  type PreviewFieldRow,
} from "./draft-preview.ts";

function field(placeholder: string, overrides: Partial<PreviewFieldRow> = {}): PreviewFieldRow {
  return {
    placeholder,
    sourceType: "CORE_FIELD",
    sourceEntity: null,
    sourceField: null,
    sourcePath: placeholder.toLowerCase(),
    optionValue: null,
    formatType: null,
    fallbackValue: null,
    isRequired: false,
    isOrphaned: false,
    ...overrides,
  };
}

test("DRAFT (mapping_snapshot = []) resolves the CURRENT merge_template_fields", () => {
  const version = { version: 8, status: "DRAFT", mappingSnapshot: [] };
  const fields = [field("Ho_ten"), field("Ngay_sinh")];

  const { mappings, source } = selectPreviewMappings(version, fields);

  assert.equal(source, DRAFT_PREVIEW_MAPPING_SOURCE.CURRENT_FIELDS);
  assert.deepEqual(mappings.map((m) => m.placeholder), ["Ho_ten", "Ngay_sinh"]);
});

test("DRAFT with missing/absent mapping_snapshot behaves identically to []", () => {
  for (const snapshot of [undefined, null, [], "not-an-array", {}]) {
    const { source } = selectPreviewMappings(
      { version: 8, status: "DRAFT", mappingSnapshot: snapshot },
      [field("Ho_ten")],
    );
    assert.equal(source, DRAFT_PREVIEW_MAPPING_SOURCE.CURRENT_FIELDS, `snapshot=${JSON.stringify(snapshot)}`);
  }
});

test("PUBLISHED version keeps its FROZEN snapshot — live field edits cannot change it", () => {
  const frozen = [field("Ho_ten", { sourcePath: "frozenPath", isRequired: true })];
  const liveEdited = [field("Ho_ten", { sourcePath: "EDITED_AFTER_PUBLISH" }), field("New_placeholder")];

  const { mappings, source } = selectPreviewMappings(
    { version: 7, status: "PUBLISHED", mappingSnapshot: frozen },
    liveEdited,
  );

  assert.equal(source, DRAFT_PREVIEW_MAPPING_SOURCE.SNAPSHOT);
  assert.equal(mappings.length, 1, "published preview must not gain a placeholder from live mapping");
  assert.equal(mappings[0].sourcePath, "frozenPath", "published immutability is not weakened");
});

test("orphaned merge_template_fields never enter a DRAFT preview", () => {
  const { mappings } = selectPreviewMappings({ version: 8, status: "DRAFT", mappingSnapshot: [] }, [
    field("Ho_ten"),
    field("So_hop_dong_dich_vu_thue", { isOrphaned: true }),
  ]);
  assert.deepEqual(mappings.map((m) => m.placeholder), ["Ho_ten"]);
});

test("toPreviewMappings normalises to the canonical mapping shape", () => {
  const [mapping] = toPreviewMappings([field("Ho_ten", { isRequired: true })]);
  assert.deepEqual(Object.keys(mapping).sort(), [
    "fallbackValue",
    "formatType",
    "isRequired",
    "optionValue",
    "placeholder",
    "sourceEntity",
    "sourceField",
    "sourcePath",
    "sourceType",
  ]);
  assert.equal(mapping.isRequired, true);
});

test("unpublished versions require the BẢN XEM TRƯỚC — CHƯA XUẤT BẢN banner", () => {
  assert.equal(isUnpublishedPreview({ status: "DRAFT" }), true);
  assert.equal(isUnpublishedPreview({ status: "ARCHIVED" }), true);
  assert.equal(isUnpublishedPreview({ status: "PUBLISHED" }), false);
  assert.equal(DRAFT_PREVIEW_BANNER_VI, "BẢN XEM TRƯỚC — CHƯA XUẤT BẢN");
  assert.equal(DRAFT_PREVIEW_MODE, "DRAFT_VERSION_PREVIEW");
});

test("data scope: unrestricted (null) allows any candidate; empty scope allows none", () => {
  assert.equal(isCandidateInScope(null, "dept-1"), true);
  assert.equal(isCandidateInScope(null, null), true);
  assert.equal(isCandidateInScope([], "dept-1"), false);
});

test("data scope: a scoped caller cannot preview a candidate outside the scope", () => {
  assert.equal(isCandidateInScope(["dept-1", "dept-2"], "dept-2"), true);
  assert.equal(isCandidateInScope(["dept-1"], "dept-9"), false);
  // Unassigned candidate is not reachable by a scoped caller (no department to authorise).
  assert.equal(isCandidateInScope(["dept-1"], null), false);
});

test("request parsing trusts ONLY applicationId — template/version come from the path", () => {
  const ok = parseDraftPreviewRequest({
    applicationId: "  app-1  ",
    templateId: "attacker-template",
    versionId: "attacker-version",
    version: 999,
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.ok && ok.value, { applicationId: "app-1" });
  assert.equal(Object.keys(ok.ok ? ok.value : {}).length, 1, "no client-supplied id is carried through");

  for (const bad of [{}, { applicationId: "" }, { applicationId: 7 }, null, "x", []]) {
    const res = parseDraftPreviewRequest(bad);
    assert.equal(res.ok, false, `${JSON.stringify(bad)} must be rejected`);
    assert.equal(!res.ok && res.error.code, "APPLICATION_REQUIRED");
  }
});

test("mapping summary counts total/mapped/required for the operator panel", () => {
  const { mappings } = selectPreviewMappings({ status: "DRAFT", mappingSnapshot: [] }, [
    field("A", { isRequired: true }),
    field("B", { sourcePath: null, sourceField: null, fallbackValue: null }),
    field("C", { sourcePath: null, sourceField: null, fallbackValue: "x" }),
  ]);
  assert.deepEqual(summarizePreviewMappings(mappings), { total: 3, mapped: 2, required: 1 });
});
