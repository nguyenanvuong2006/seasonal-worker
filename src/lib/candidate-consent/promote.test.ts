import test from "node:test";
import assert from "node:assert/strict";
import { promoteOne, type CandidateDocumentGenerating, type MergeJobRecordSnapshot, type PromoteDeps } from "./promote.ts";

const NOW = new Date("2026-09-01T10:00:00.000Z");

function doc(overrides: Partial<CandidateDocumentGenerating> = {}): CandidateDocumentGenerating {
  return { id: "cdoc-1", mergeJobRecordId: "rec-1", applicationId: "app-1", ...overrides };
}

function record(overrides: Partial<MergeJobRecordSnapshot> = {}): MergeJobRecordSnapshot {
  return {
    id: "rec-1",
    status: "COMPLETED",
    errorMessage: null,
    storageKey: null,
    pdfUrl: null,
    sha256: null,
    fileSize: null,
    filename: null,
    templateId: "tpl-1",
    ...overrides,
  };
}

function makeDeps(overrides: Partial<PromoteDeps> = {}): PromoteDeps {
  return {
    fetchGoogleDocsPdfBytes: async () => new TextEncoder().encode("fake-pdf-bytes"),
    storagePut: async (key: string, bytes: Uint8Array) => ({ key, size: bytes.byteLength }),
    now: () => NOW,
    ...overrides,
  };
}

test("promoteOne: missing linked record -> FAILED (never silently stuck)", async () => {
  const result = await promoteOne(doc(), null, makeDeps());
  assert.equal(result.outcome, "failed");
});

test("promoteOne: linked record still QUEUED/PROCESSING -> unchanged (still generating)", async () => {
  for (const status of ["QUEUED", "PROCESSING", "RETRY", "PENDING", "RUNNING"]) {
    const result = await promoteOne(doc(), record({ status }), makeDeps());
    assert.equal(result.outcome, "unchanged", `status ${status} should stay unchanged`);
  }
});

test("promoteOne: linked record FAILED -> propagates the error message", async () => {
  const result = await promoteOne(doc(), record({ status: "FAILED", errorMessage: "Google API lỗi" }), makeDeps());
  assert.equal(result.outcome, "failed");
  if (result.outcome === "failed") assert.equal(result.errorMessage, "Google API lỗi");
});

test("promoteOne: linked record CANCELLED -> FAILED (treated as a dead end, never confirmable)", async () => {
  const result = await promoteOne(doc(), record({ status: "CANCELLED" }), makeDeps());
  assert.equal(result.outcome, "failed");
});

test("promoteOne: HTML_PDF-style COMPLETED record (already has storageKey+sha256) is reused verbatim — never re-hashed", async () => {
  let storagePutCalled = false;
  let fetchCalled = false;
  const deps = makeDeps({
    storagePut: async (key, bytes) => {
      storagePutCalled = true;
      return { key, size: bytes.byteLength };
    },
    fetchGoogleDocsPdfBytes: async () => {
      fetchCalled = true;
      return new TextEncoder().encode("x");
    },
  });
  const result = await promoteOne(
    doc(),
    record({ status: "COMPLETED", storageKey: "html-pdf/abc.pdf", sha256: "d".repeat(64), fileSize: 12345, filename: "ho-so.pdf" }),
    deps,
  );
  assert.equal(result.outcome, "issued");
  if (result.outcome === "issued") {
    assert.equal(result.pdfSha256, "d".repeat(64));
    assert.equal(result.storageKey, "html-pdf/abc.pdf");
    assert.equal(result.fileSize, 12345);
  }
  assert.equal(storagePutCalled, false, "must not re-store an already-stored HTML_PDF output");
  assert.equal(fetchCalled, false, "must not re-fetch bytes that are already hashed");
});

test("promoteOne: GOOGLE_DOCS-style COMPLETED record (no storageKey/sha256 yet) fetches bytes exactly once, hashes, and stores under our own key", async () => {
  let fetchCallCount = 0;
  let putKeyUsed: string | null = null;
  const deps = makeDeps({
    fetchGoogleDocsPdfBytes: async () => {
      fetchCallCount += 1;
      return new TextEncoder().encode("google-docs-pdf-bytes");
    },
    storagePut: async (key, bytes) => {
      putKeyUsed = key;
      return { key, size: bytes.byteLength };
    },
  });
  const result = await promoteOne(doc({ id: "cdoc-42" }), record({ status: "COMPLETED" }), deps);
  assert.equal(result.outcome, "issued");
  assert.equal(fetchCallCount, 1);
  assert.equal(putKeyUsed, "candidate-documents/cdoc-42.pdf");
  if (result.outcome === "issued") {
    assert.equal(result.pdfSha256.length, 64);
  }
});

test("promoteOne: GOOGLE_DOCS hashing is deterministic for identical bytes", async () => {
  const bytes = new TextEncoder().encode("identical-content");
  const deps = makeDeps({ fetchGoogleDocsPdfBytes: async () => bytes });
  const r1 = await promoteOne(doc({ id: "a" }), record({ status: "COMPLETED" }), deps);
  const r2 = await promoteOne(doc({ id: "b" }), record({ status: "COMPLETED" }), deps);
  assert.equal(r1.outcome, "issued");
  assert.equal(r2.outcome, "issued");
  if (r1.outcome === "issued" && r2.outcome === "issued") {
    assert.equal(r1.pdfSha256, r2.pdfSha256, "same PDF bytes must hash identically regardless of which candidate_document it belongs to");
  }
});
