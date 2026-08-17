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
  buildIndividualStorageKey,
  sanitizeFilenameSegment,
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
  it("bỏ dấu tiếng Việt + chuẩn hoá khoảng trắng thành gạch nối", () => {
    assert.equal(sanitizeFilenameSegment("Nguyễn Văn An"), "Nguyen-Van-An");
  });

  it("loại bỏ ký tự nguy hiểm filesystem/URL", () => {
    assert.equal(sanitizeFilenameSegment("A<B>:C/D\\E|F?G*H"), "A-B-C-D-E-F-G-H");
  });

  it("fallback khi rỗng", () => {
    assert.equal(sanitizeFilenameSegment(""), "ung-vien");
    assert.equal(sanitizeFilenameSegment("   "), "ung-vien");
    assert.equal(sanitizeFilenameSegment(null as unknown as string), "ung-vien");
  });

  it("cắt độ dài quá mức", () => {
    const long = "x".repeat(300);
    assert.equal(sanitizeFilenameSegment(long, 120).length, 120);
  });

  it("filename individual deterministic + đúng chuẩn YYYYMMDD_HoTen_TenTaiLieu_AppID", () => {
    const date = new Date("2026-08-17T00:00:00Z");
    assert.equal(
      buildIndividualPdfFilename(date, "Nguyễn Văn An", "Dang-ky-tap-nghe", "APP001928"),
      "20260817_Nguyen-Van-An_Dang-ky-tap-nghe_APP001928.pdf",
    );
    assert.equal(
      buildIndividualPdfFilename(date, "Trần Thị B", "Dang-ky-tap-nghe", "f47ac10b-58cc-4372-a567-0e02b2c3d479"),
      "20260817_Tran-Thi-B_Dang-ky-tap-nghe_f47ac10b-58cc-4372-a567-0e02b2c3d479.pdf",
    );
  });

  it("batch filename + storage key layout", () => {
    assert.equal(buildBatchPdfFilename("Dang_ky_tap_nghe", 500), "Dang-ky-tap-nghe_500_ung-vien.pdf");
    assert.equal(buildBatchZipFilename("Dang_ky_tap_nghe", 500), "Dang-ky-tap-nghe_500_ung-vien.zip");
    assert.equal(
      buildIndividualStorageKey(new Date("2026-08-17T00:00:00Z"), "20260817_A.pdf"),
      "Candidate Documents/2026/08/17/20260817_A.pdf",
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
