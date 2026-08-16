/**
 * Async PDF engine — pure-function tests (Phase 1).
 * Không cần DB: chỉ test filename sanitization, status vocabulary,
 * retry backoff và feature flag parsing.
 */

import test, { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseDocumentMergeEngine } from "./engine-config.ts";
import {
  buildBatchPdfFilename,
  buildBatchZipFilename,
  buildIndividualPdfFilename,
  buildStorageKey,
  sanitizeFilenamePart,
} from "./filename.ts";
import {
  normalizeItemStatus,
  normalizeJobStatus,
  retryBackoffSeconds,
  shouldRetry,
  isTerminalItemStatus,
  isTerminalJobStatus,
} from "./queue-types.ts";

describe("filename sanitization", () => {
  it("giữ nguyên tiếng Việt có dấu", () => {
    assert.equal(sanitizeFilenamePart("Nguyễn Văn An"), "Nguyễn Văn An");
  });

  it("loại bỏ ký tự nguy hiểm filesystem/URL", () => {
    assert.equal(sanitizeFilenamePart("A<B>:C/D\\E|F?G*H"), "ABCDEFGH");
  });

  it("fallback khi rỗng", () => {
    assert.equal(sanitizeFilenamePart(""), "ung-vien");
    assert.equal(sanitizeFilenamePart("   "), "ung-vien");
    assert.equal(sanitizeFilenamePart(null), "ung-vien");
  });

  it("cắt độ dài quá mức", () => {
    const long = "x".repeat(300);
    assert.equal(sanitizeFilenamePart(long).length, 120);
  });

  it("filename individual deterministic + đúng sequence", () => {
    assert.equal(
      buildIndividualPdfFilename(1, "Nguyễn Văn An", "012345678901"),
      "001_Nguyễn Văn An_012345678901.pdf",
    );
    assert.equal(buildIndividualPdfFilename(42, "Trần Thị B", null), "042_Trần Thị B.pdf");
  });

  it("batch filename + storage key layout", () => {
    assert.equal(buildBatchPdfFilename("Dang_ky_tap_nghe", 500), "Dang_ky_tap_nghe_500_ung_vien.pdf");
    assert.equal(buildBatchZipFilename("Dang_ky_tap_nghe", 500), "Dang_ky_tap_nghe_500_ung_vien.zip");
    assert.equal(
      buildStorageKey("job-123", "individual", "001_A.pdf"),
      "document-merge/job-123/individual/001_A.pdf",
    );
  });
});

describe("feature flag", () => {
  it("mặc định GOOGLE_DOCS khi chưa cấu hình", () => {
    assert.equal(parseDocumentMergeEngine(undefined), "GOOGLE_DOCS");
    assert.equal(parseDocumentMergeEngine(""), "GOOGLE_DOCS");
  });

  it("HTML_PDF (case-insensitive)", () => {
    assert.equal(parseDocumentMergeEngine("html_pdf"), "HTML_PDF");
    assert.equal(parseDocumentMergeEngine("HTML_PDF"), "HTML_PDF");
  });

  it("giá trị lạ → GOOGLE_DOCS (fail-safe)", () => {
    assert.equal(parseDocumentMergeEngine("something"), "GOOGLE_DOCS");
  });
});

describe("status vocabulary", () => {
  it("normalize legacy → canonical item", () => {
    assert.equal(normalizeItemStatus("PENDING"), "QUEUED");
    assert.equal(normalizeItemStatus("RUNNING"), "PROCESSING");
    assert.equal(normalizeItemStatus("completed"), "COMPLETED");
    assert.equal(normalizeItemStatus("failed"), "FAILED");
    assert.equal(normalizeItemStatus("garbage"), "QUEUED");
  });

  it("normalize legacy → canonical job", () => {
    assert.equal(normalizeJobStatus("PENDING"), "QUEUED");
    assert.equal(normalizeJobStatus("RUNNING"), "PROCESSING");
    assert.equal(normalizeJobStatus("CANCELLED"), "CANCELLED");
  });

  it("terminal states", () => {
    assert.equal(isTerminalItemStatus("COMPLETED"), true);
    assert.equal(isTerminalItemStatus("FAILED"), true);
    assert.equal(isTerminalItemStatus("CANCELLED"), true);
    assert.equal(isTerminalItemStatus("RETRY"), false);
    assert.equal(isTerminalJobStatus("COMPLETED"), true);
    assert.equal(isTerminalJobStatus("PROCESSING"), false);
  });
});

describe("retry policy", () => {
  it("không retry vô hạn (max 3 lần)", () => {
    assert.equal(shouldRetry(0), true);
    assert.equal(shouldRetry(1), true);
    assert.equal(shouldRetry(2), true);
    assert.equal(shouldRetry(3), false);
    assert.equal(shouldRetry(4), false);
  });

  it("backoff tăng dần và có trần", () => {
    const attempts = [1, 2, 3, 4, 5, 6, 7].map((n) => retryBackoffSeconds(n, 2000));
    for (let i = 1; i < attempts.length; i++) {
      // Cho phép jitter: trần so sánh để tránh flaky.
      assert.ok(attempts[i] >= Math.floor(attempts[i - 1] / 2), `backoff không được giảm mạnh: ${attempts}`);
    }
    for (const s of attempts) {
      assert.ok(s <= 62, `backoff phải có trần: ${s}`);
    }
  });
});
