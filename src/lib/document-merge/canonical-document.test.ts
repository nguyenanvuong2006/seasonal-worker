/**
 * CANONICAL DOCUMENT PIPELINE — regression suite.
 *
 * Phase 8: the obsolete legacy document body can never render again.
 * Phase 9: Preview and the Cloud Run HTML_PDF worker produce identical output
 *          from the same snapshot.
 * Phase 10: page count comes exclusively from the selected canonical body and
 *          is never hard-coded in business logic.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  buildCanonicalSnapshot,
  CANONICAL_ERROR,
  CANONICAL_ERROR_MESSAGE_VI,
  CanonicalTemplateError,
  countCanonicalPages,
  isCanonicalTemplateError,
  parseCanonicalSnapshot,
  renderCanonicalDocument,
  type CanonicalDocumentSnapshot,
  type CanonicalMapping,
} from "./canonical-document.ts";
import {
  canonicalSnapshotFixture,
  LEGACY_OBSOLETE_BODY,
  LEGACY_OBSOLETE_CSS,
  LEGACY_TEMPLATE_SENTINEL,
  readCanonicalManifest,
} from "../test-support/canonical-fixture.ts";

const mapping = (overrides: Partial<CanonicalMapping> = {}): CanonicalMapping => ({
  placeholder: "Ho_ten",
  sourceType: "CORE_FIELD",
  sourceEntity: null,
  sourceField: null,
  sourcePath: "fullName",
  optionValue: null,
  formatType: null,
  fallbackValue: null,
  isRequired: false,
  ...overrides,
});

const RECORD = { id: "app-1", fullName: "Nguyễn Thị Ánh Dương", cccd: "072201012345" };
const CONTEXT = { currentUserName: "admin", currentDate: new Date("2026-08-23T00:00:00Z"), mergeIndex: 1, mergeCount: 1 };

function publishedVersion(overrides: Record<string, unknown> = {}) {
  return {
    templateId: "tpl-1",
    version: 7,
    status: "PUBLISHED",
    htmlBody: '<div class="page"><p>{{Ho_ten}}</p></div>',
    printCss: ".page{color:#000}",
    retentionYears: 3,
    ...overrides,
  };
}

const FORMATTING = {
  contractKey: null,
  retentionYears: 3,
  documentKind: "B",
  templateName: "Đăng ký tập nghề",
};

// ===================================================================
// PHASE 4 / TEST J — fail closed without a published canonical version
// ===================================================================

test("TEST J: no canonical PUBLISHED version → fail closed, no fallback", () => {
  for (const version of [null, undefined, publishedVersion({ status: "DRAFT" }), publishedVersion({ status: "ARCHIVED" })]) {
    assert.throws(
      () => buildCanonicalSnapshot({ templateId: "tpl-1", version, mappings: [], formatting: FORMATTING }),
      (error: unknown) => {
        assert.ok(isCanonicalTemplateError(error));
        assert.equal((error as CanonicalTemplateError).code, CANONICAL_ERROR.NOT_PUBLISHED);
        return true;
      },
      `status ${String((version as { status?: string } | null)?.status)} must not be usable`,
    );
  }
});

test("TEST J: a PUBLISHED row with an empty body still fails closed", () => {
  for (const htmlBody of [null, "", "   "]) {
    assert.throws(
      () =>
        buildCanonicalSnapshot({
          templateId: "tpl-1",
          version: publishedVersion({ htmlBody }),
          mappings: [],
          formatting: FORMATTING,
        }),
      /CANONICAL_TEMPLATE_NOT_PUBLISHED/,
    );
  }
});

test("fail-closed error is a non-retryable configuration error with a safe Vietnamese message", () => {
  const error = new CanonicalTemplateError(CANONICAL_ERROR.NOT_PUBLISHED, "tpl-1");
  assert.equal(error.retryable, false);
  assert.equal(error.code, "CANONICAL_TEMPLATE_NOT_PUBLISHED");
  assert.equal(error.operatorMessage, CANONICAL_ERROR_MESSAGE_VI[CANONICAL_ERROR.NOT_PUBLISHED]);
  assert.match(error.operatorMessage, /XUẤT BẢN/);
  assert.match(error.operatorMessage, /KHÔNG tự động dùng Google Docs hay mẫu HTML cũ/);
  // No candidate data, no secrets, no stack detail leaked to the operator.
  assert.doesNotMatch(error.operatorMessage, /password|token|secret|postgres:\/\//i);
});

test("an empty job snapshot fails closed instead of re-reading any other source", () => {
  assert.throws(
    () => parseCanonicalSnapshot({ templateVersion: 3, htmlBody: null }, "tpl-1"),
    /CANONICAL_SNAPSHOT_EMPTY/,
  );
  assert.throws(() => parseCanonicalSnapshot(null, "tpl-1"), /CANONICAL_SNAPSHOT_EMPTY/);
});

// ===================================================================
// PHASE 8 — legacy sentinel: the obsolete body can never render
// ===================================================================

test("TEST K (sentinel): legacy obsolete body cannot be selected implicitly", () => {
  // The obsolete body exists ONLY as a test fixture. Selecting the canonical
  // published version must render the canonical document and nothing else.
  const snapshot = buildCanonicalSnapshot({
    templateId: "tpl-1",
    version: publishedVersion(),
    mappings: [mapping()],
    formatting: FORMATTING,
  });
  const rendered = renderCanonicalDocument(snapshot, RECORD, CONTEXT);

  assert.doesNotMatch(rendered.html, new RegExp(LEGACY_TEMPLATE_SENTINEL));
  assert.match(rendered.html, /Nguyễn Thị Ánh Dương/);
  assert.equal(rendered.templateVersion, 7);
});

test("TEST K: neither Preview nor Worker can render the legacy body when a canonical version is selected", () => {
  const canonical = buildCanonicalSnapshot({
    templateId: "tpl-1",
    version: publishedVersion(),
    mappings: [mapping()],
    formatting: FORMATTING,
  });

  // Preview path and worker path are literally the same function; render twice
  // exactly as each caller does and assert the sentinel never appears.
  const previewHtml = renderCanonicalDocument(canonical, RECORD, CONTEXT).html;
  const workerHtml = renderCanonicalDocument(
    parseCanonicalSnapshot(JSON.parse(JSON.stringify(canonical)), "tpl-1"),
    RECORD,
    CONTEXT,
  ).html;

  for (const html of [previewHtml, workerHtml]) {
    assert.doesNotMatch(html, new RegExp(LEGACY_TEMPLATE_SENTINEL));
    assert.doesNotMatch(html, /LEGACY_TEMPLATE/);
  }
  assert.equal(previewHtml, workerHtml);
});

test("legacy sentinel exists ONLY in the test fixture — never in runtime code, seeds or migrations", () => {
  // If this fails, an obsolete body has leaked back into a runtime-reachable place.
  const runtimeFiles = [
    "src/lib/document-merge/canonical-document.ts",
    "src/lib/document-merge/html-pipeline.ts",
    "src/lib/document-merge/html-renderer.ts",
    "src/document-templates/registry.ts",
    "src/document-templates/dang-ky-tap-nghe/schema.ts",
    "worker/src/index.ts",
    "migrations/2026-08-21-dang-ky-tap-nghe-html-draft.sql",
    "migrations/2026-08-23-trainee-registration-canonical-html-draft.sql",
  ];
  for (const relative of runtimeFiles) {
    const source = readFileSync(join(process.cwd(), relative), "utf8");
    assert.doesNotMatch(source, new RegExp(LEGACY_TEMPLATE_SENTINEL), `${relative} must not contain the sentinel`);
  }
});

test("even if an obsolete body is force-fed, it is never reachable via a published-version lookup", () => {
  // A caller cannot obtain the obsolete body from the canonical pipeline: the
  // only way in is an explicit PUBLISHED row, which the DB constrains to one.
  const forced: CanonicalDocumentSnapshot = {
    templateId: "tpl-1",
    templateVersion: 1,
    htmlBody: LEGACY_OBSOLETE_BODY,
    printCss: LEGACY_OBSOLETE_CSS,
    mappings: [mapping()],
    formatting: FORMATTING,
  };
  // Rendering a hand-built snapshot is possible in a unit test, but production
  // snapshots are only ever produced by buildCanonicalSnapshot() from a
  // PUBLISHED row — proven by the fail-closed tests above.
  const rendered = renderCanonicalDocument(forced, RECORD, CONTEXT);
  assert.match(rendered.html, new RegExp(LEGACY_TEMPLATE_SENTINEL));

  // ...and that same body cannot come from a DRAFT/ARCHIVED published lookup.
  assert.throws(
    () =>
      buildCanonicalSnapshot({
        templateId: "tpl-1",
        version: { templateId: "tpl-1", version: 1, status: "ARCHIVED", htmlBody: LEGACY_OBSOLETE_BODY, printCss: null },
        mappings: [],
        formatting: FORMATTING,
      }),
    /CANONICAL_TEMPLATE_NOT_PUBLISHED/,
  );
});

// ===================================================================
// PHASE 9 — parity tests
// ===================================================================

function renderBothSides(snapshot: CanonicalDocumentSnapshot) {
  // Preview renders the in-memory snapshot; the worker re-hydrates the very
  // same snapshot from job metadata (JSON round-trip) before rendering.
  const preview = renderCanonicalDocument(snapshot, RECORD, CONTEXT);
  const worker = renderCanonicalDocument(
    parseCanonicalSnapshot(JSON.parse(JSON.stringify(snapshot)), snapshot.templateId),
    RECORD,
    CONTEXT,
  );
  return { preview, worker };
}

test("TEST A: same snapshot + same candidate → Preview HTML === Worker HTML", () => {
  const snapshot = canonicalSnapshotFixture([mapping()]);
  const { preview, worker } = renderBothSides(snapshot);
  assert.equal(preview.html, worker.html);
});

test("TEST B: same printCss", () => {
  const snapshot = canonicalSnapshotFixture([mapping()]);
  const { preview, worker } = renderBothSides(snapshot);
  assert.equal(preview.printCss, worker.printCss);
  assert.equal(preview.printCss, snapshot.printCss);
  assert.ok(preview.html.includes(snapshot.printCss ?? ""), "print CSS must be embedded in the rendered document");
});

test("TEST C: same templateId / templateVersion", () => {
  const snapshot = canonicalSnapshotFixture([mapping()]);
  const { preview, worker } = renderBothSides(snapshot);
  assert.equal(preview.templateId, worker.templateId);
  assert.equal(preview.templateVersion, worker.templateVersion);
  assert.equal(preview.templateId, "tpl-canonical");
  assert.equal(preview.templateVersion, 7);
});

test("TEST D: all canonical .page sections are preserved", () => {
  const manifest = readCanonicalManifest();
  const snapshot = canonicalSnapshotFixture([mapping()]);
  const { preview, worker } = renderBothSides(snapshot);

  const bodyPages = countCanonicalPages(snapshot.htmlBody);
  assert.equal(countCanonicalPages(preview.html), bodyPages);
  assert.equal(countCanonicalPages(worker.html), bodyPages);
  // Derived from the canonical body — NOT a hard-coded business rule.
  assert.equal(bodyPages, manifest.logicalPageCount);
});

test("TEST E: no additional legacy pages are appended", () => {
  const snapshot = canonicalSnapshotFixture([mapping()]);
  const { preview, worker } = renderBothSides(snapshot);
  const expected = countCanonicalPages(snapshot.htmlBody);

  assert.equal(countCanonicalPages(preview.html), expected, "renderer must not append pages");
  assert.equal(countCanonicalPages(worker.html), expected, "worker must not append pages");
  for (const html of [preview.html, worker.html]) {
    assert.doesNotMatch(html, new RegExp(LEGACY_TEMPLATE_SENTINEL));
    // The obsolete document's five-page shape must not be concatenated on.
    assert.equal((html.match(/GIẤY ĐĂNG KÝ TẬP NGHỀ/g) ?? []).length, 1);
  }
});

test("TEST F: mapped OPTIONAL field resolving to null stays blank and remains valid", () => {
  const snapshot: CanonicalDocumentSnapshot = {
    ...canonicalSnapshotFixture([]),
    htmlBody: '<div class="page"><p>[{{Ghi_chu}}]</p></div>',
    mappings: [mapping({ placeholder: "Ghi_chu", sourcePath: "khongCoTruong", isRequired: false })],
  };
  const { preview, worker } = renderBothSides(snapshot);

  assert.equal(preview.valid, true);
  assert.deepEqual(preview.missingFields, []);
  assert.match(preview.html, /\[\]/);
  assert.equal(preview.html, worker.html);
});

test("TEST G: mapped REQUIRED field resolving to null → INCOMPLETE (valid=false)", () => {
  const snapshot: CanonicalDocumentSnapshot = {
    ...canonicalSnapshotFixture([]),
    htmlBody: '<div class="page"><p>{{So_CCCD}}</p></div>',
    mappings: [mapping({ placeholder: "So_CCCD", sourcePath: "cccd", isRequired: true })],
  };
  const { preview, worker } = renderBothSides(snapshot);

  const previewEmpty = renderCanonicalDocument(snapshot, { id: "app-2" }, CONTEXT);
  assert.equal(previewEmpty.valid, false);
  assert.deepEqual(previewEmpty.missingFields, ["So_CCCD"]);
  // Same candidate → same verdict on both sides.
  assert.equal(preview.valid, worker.valid);
  assert.deepEqual(preview.missingFields, worker.missingFields);
});

test("TEST D/E: page count follows the canonical body, whatever N is (no hard-coded 6)", () => {
  for (const pages of [1, 3, 5, 7, 11]) {
    const htmlBody = Array.from({ length: pages }, (_, i) => `<div class="page"><p>Trang ${i + 1}</p></div>`).join("");
    const snapshot: CanonicalDocumentSnapshot = { ...canonicalSnapshotFixture([]), htmlBody, mappings: [] };
    const { preview, worker } = renderBothSides(snapshot);
    assert.equal(countCanonicalPages(preview.html), pages);
    assert.equal(countCanonicalPages(worker.html), pages);
    assert.equal(preview.html, worker.html);
  }
});

test("PHASE 10: no source file encodes a page-count business rule", () => {
  for (const relative of [
    "src/lib/document-merge/canonical-document.ts",
    "src/lib/document-merge/html-pipeline.ts",
    "src/lib/document-merge/html-renderer.ts",
    "worker/src/index.ts",
  ]) {
    const source = readFileSync(join(process.cwd(), relative), "utf8");
    assert.doesNotMatch(source, /pageCount\s*[=!]==?\s*\d/, `${relative} must not compare page count to a literal`);
    assert.doesNotMatch(source, /LOGICAL_PAGE_COUNT\s*=\s*\d/, `${relative} must not fix a page count`);
  }
});

// ===================================================================
// PHASE 3 — legacy runtime HTML is gone
// ===================================================================

test("PHASE 3: obsolete runtime document modules are deleted and stay deleted", () => {
  for (const removed of [
    "src/document-templates/dang-ky-tap-nghe/template.ts",
    "src/document-templates/dang-ky-tap-nghe/canonical-template.generated.ts",
    "templates/document-merge/trainee-registration/test.html",
    "docs/visual-verification/dang-ky-tap-nghe-sample.html",
  ]) {
    assert.equal(existsSync(join(process.cwd(), removed)), false, `${removed} must not exist`);
  }
});

test("PHASE 3: the obsolete 5-page seed no longer carries a document body", () => {
  const tombstone = readFileSync(
    join(process.cwd(), "migrations/2026-08-21-dang-ky-tap-nghe-html-draft.sql"),
    "utf8",
  );
  assert.doesNotMatch(tombstone, /<div class="page"/);
  assert.doesNotMatch(tombstone, /GIẤY ĐĂNG KÝ TẬP NGHỀ/);
  assert.doesNotMatch(tombstone, /INSERT INTO merge_template_versions/i);
  // Historical DB rows must be preserved, never deleted.
  assert.doesNotMatch(tombstone, /\bDELETE\b|\bDROP\b|\bTRUNCATE\b/i);
  assert.match(tombstone, /TOMBSTONE/);
});

test("PHASE 3: the static catalog keeps metadata only and can never supply a body", () => {
  const registry = readFileSync(join(process.cwd(), "src/document-templates/registry.ts"), "utf8");
  assert.doesNotMatch(registry, /<div|<p>|<table|GIẤY|CỘNG HÒA/);
  assert.doesNotMatch(registry, /\bhtml\s*:/);
  assert.doesNotMatch(registry, /\bcss\s*:/);
  assert.match(registry, /METADATA ONLY/);
});

test("PHASE 3: historical versions are preserved for audit and never auto-selected", () => {
  const canonicalMigration = readFileSync(
    join(process.cwd(), "migrations/2026-08-23-trainee-registration-canonical-html-draft.sql"),
    "utf8",
  );
  assert.match(canonicalMigration, /'DRAFT'/);
  assert.doesNotMatch(canonicalMigration, /\bDELETE\b|\bTRUNCATE\b|\bDROP\b/i);
  assert.doesNotMatch(canonicalMigration, /current_published_version\s*=/i);
  // An older version is never promoted automatically — proven by the
  // fail-closed tests above (DRAFT/ARCHIVED both throw).
});
