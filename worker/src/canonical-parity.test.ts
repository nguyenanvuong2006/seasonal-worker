/**
 * WORKER ↔ PREVIEW PARITY (Phase 5 / Phase 9).
 *
 * Proves the Cloud Run HTML_PDF worker renders through the SAME
 * renderCanonicalDocument() function as Preview, from the SAME immutable job
 * snapshot, and that it fails closed rather than substituting any other body.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseCanonicalSnapshot,
  renderCanonicalDocument,
  type CanonicalMapping,
} from "../../src/lib/document-merge/canonical-document.ts";
import {
  canonicalSnapshotFixture,
  LEGACY_TEMPLATE_SENTINEL,
} from "../../src/lib/test-support/canonical-fixture.ts";

const ROOT = join(process.cwd(), process.cwd().endsWith("worker") ? ".." : ".");
const workerSource = readFileSync(join(ROOT, "worker/src/index.ts"), "utf8");

const MAPPINGS: CanonicalMapping[] = [
  {
    placeholder: "Ho_ten",
    sourceType: "CORE_FIELD",
    sourceEntity: null,
    sourceField: null,
    sourcePath: "fullName",
    optionValue: null,
    formatType: null,
    fallbackValue: null,
    isRequired: true,
  },
];

const RECORD = { id: "app-1", fullName: "Nguyễn Thị Ánh Dương" };
const CONTEXT = { currentUserName: "admin", currentDate: new Date("2026-08-23T00:00:00Z"), mergeIndex: 1, mergeCount: 1 };

const COMPUTED_MAPPINGS: CanonicalMapping[] = [
  ...MAPPINGS,
  {
    placeholder: "Ngay_ky_day",
    sourceType: "COMPUTED",
    sourceEntity: null,
    sourceField: null,
    sourcePath: "day(SigningDate)",
    optionValue: null,
    formatType: null,
    fallbackValue: null,
    isRequired: false,
  },
  {
    placeholder: "Nam_thue",
    sourceType: "COMPUTED",
    sourceEntity: null,
    sourceField: null,
    sourcePath: "year(SigningDate)",
    optionValue: null,
    formatType: null,
    fallbackValue: null,
    isRequired: false,
  },
];

test("worker imports the canonical renderer and no static template body", () => {
  assert.match(workerSource, /renderCanonicalDocument/);
  assert.match(workerSource, /canonical-document\.ts/);

  // No static/legacy document-body source may be reachable from the worker.
  assert.doesNotMatch(workerSource, /dangKyTapNgheTemplate/);
  assert.doesNotMatch(workerSource, /canonical-template\.generated/);
  assert.doesNotMatch(workerSource, /getHtmlTemplateByGoogleDocId/);
  assert.doesNotMatch(workerSource, new RegExp(LEGACY_TEMPLATE_SENTINEL));
});

test("worker renders exclusively from the immutable job snapshot", () => {
  // It must parse the snapshot rather than re-query merge_template_versions
  // during item rendering.
  assert.match(workerSource, /parseCanonicalSnapshot\(snap, templateId\)/);
  const processItem = workerSource.slice(
    workerSource.indexOf("async function processItem"),
    workerSource.indexOf("async function sha256Hex"),
  );
  assert.doesNotMatch(processItem, /mergeTemplateVersions/, "processItem must not re-read the versions table");
});

test("worker fails closed and marks canonical config errors non-retryable", () => {
  assert.match(workerSource, /CANONICAL_ERROR\.SNAPSHOT_EMPTY/);
  assert.match(workerSource, /retryable: false/);
  // No implicit substitution of another document source ON THE HTML_PDF PATH.
  // Since the 28–29/08 incident the worker is also the GOOGLE_DOCS executor —
  // reading the Google Doc template is allowed ONLY inside that runner (which
  // executes exclusively for jobs carrying the frozen googleDocs snapshot).
  const htmlPath = workerSource.slice(
    workerSource.indexOf("async function runItemProcessing"),
    workerSource.indexOf("async function sha256Hex"),
  );
  assert.doesNotMatch(htmlPath, /getDocumentContent/, "HTML_PDF path must never read Google Docs content");
  const googleDocsRunner = workerSource.slice(
    workerSource.indexOf("async function runGoogleDocsItem"),
    workerSource.indexOf("async function finalizeGoogleDocsJob"),
  );
  assert.match(googleDocsRunner, /getDocumentContent/, "GOOGLE_DOCS executor reads the template it snapshotted at job creation");
});

test("TEST A/B/C: worker output is byte-identical to Preview for the same snapshot", () => {
  const snapshot = canonicalSnapshotFixture(MAPPINGS);

  // Preview renders the in-memory snapshot.
  const preview = renderCanonicalDocument(snapshot, RECORD, CONTEXT);
  // Worker re-hydrates the identical snapshot from job metadata JSON.
  const worker = renderCanonicalDocument(
    parseCanonicalSnapshot(JSON.parse(JSON.stringify(snapshot)), snapshot.templateId),
    RECORD,
    CONTEXT,
  );

  assert.equal(preview.html, worker.html, "TEST A: HTML parity");
  assert.equal(preview.printCss, worker.printCss, "TEST B: printCss parity");
  assert.equal(preview.templateId, worker.templateId, "TEST C: templateId parity");
  assert.equal(preview.templateVersion, worker.templateVersion, "TEST C: templateVersion parity");
  assert.deepEqual(preview.missingFields, worker.missingFields);
  assert.equal(preview.valid, worker.valid);
});

test("H3: worker output is byte-identical to Preview for COMPUTED placeholders driven by a frozen Signing Context", () => {
  const snapshot = canonicalSnapshotFixture(COMPUTED_MAPPINGS, {
    htmlBody: `<div class="paper"><p><<Ho_ten>> ký ngày <<Ngay_ky_day>>, năm thuế <<Nam_thue>></p></div>`,
    printCss: "",
  });
  const contextWithSigningContext = { ...CONTEXT, signingContext: { signingDate: "2026-08-26", signingLocation: null, documentDate: null, receivedDate: null, receivedBy: null, signingLatitude: null, signingLongitude: null, signingLocationCapturedAt: null } };

  // Preview renders the in-memory snapshot directly.
  const preview = renderCanonicalDocument(snapshot, RECORD, contextWithSigningContext);
  // Worker re-hydrates the identical snapshot from job metadata JSON — the
  // SAME parseCanonicalSnapshot() call processItem() uses.
  const worker = renderCanonicalDocument(
    parseCanonicalSnapshot(JSON.parse(JSON.stringify(snapshot)), snapshot.templateId),
    RECORD,
    contextWithSigningContext,
  );

  assert.equal(preview.html, worker.html, "TEST A: HTML parity for COMPUTED placeholders");
  assert.match(preview.html, /ký ngày 26, năm thuế 2026/);
  assert.equal(preview.valid, worker.valid);
});

test("parity holds for an incomplete candidate too (same INCOMPLETE verdict)", () => {
  const snapshot = canonicalSnapshotFixture(MAPPINGS);
  const empty = { id: "app-2" };

  const preview = renderCanonicalDocument(snapshot, empty, CONTEXT);
  const worker = renderCanonicalDocument(
    parseCanonicalSnapshot(JSON.parse(JSON.stringify(snapshot)), snapshot.templateId),
    empty,
    CONTEXT,
  );

  assert.equal(preview.valid, false);
  assert.deepEqual(preview.missingFields, ["Ho_ten"]);
  assert.equal(preview.html, worker.html);
  assert.deepEqual(preview.missingFields, worker.missingFields);
});
