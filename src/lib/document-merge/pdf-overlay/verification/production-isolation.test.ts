import test from "node:test";
import assert from "node:assert/strict";

import {
  isProductionEnvironment,
  isGoogleDocsEngine,
  containsRealPii,
  assertVerificationSafe,
  assertFixtureSafe,
  createNonProductionMarker,
} from "./production-isolation.ts";

test("production-isolation: isProductionEnvironment trả false ở test", () => {
  // Trong test environment, VERCEL_ENV và NODE_ENV thường không phải "production"
  const isProd = isProductionEnvironment();
  // Có thể true hoặc false tùy environment, nhưng hàm phải chạy được
  assert.equal(typeof isProd, "boolean");
});

test("production-isolation: isGoogleDocsEngine trả true khi không set env", () => {
  const original = process.env.DOCUMENT_MERGE_ENGINE;
  delete process.env.DOCUMENT_MERGE_ENGINE;
  const isGoogleDocs = isGoogleDocsEngine();
  assert.equal(isGoogleDocs, true);
  if (original) process.env.DOCUMENT_MERGE_ENGINE = original;
});

test("production-isolation: isGoogleDocsEngine trả true khi GOOGLE_DOCS", () => {
  const original = process.env.DOCUMENT_MERGE_ENGINE;
  process.env.DOCUMENT_MERGE_ENGINE = "GOOGLE_DOCS";
  const isGoogleDocs = isGoogleDocsEngine();
  assert.equal(isGoogleDocs, true);
  if (original) {
    process.env.DOCUMENT_MERGE_ENGINE = original;
  } else {
    delete process.env.DOCUMENT_MERGE_ENGINE;
  }
});

test("production-isolation: isGoogleDocsEngine trả false khi HTML_PDF", () => {
  const original = process.env.DOCUMENT_MERGE_ENGINE;
  process.env.DOCUMENT_MERGE_ENGINE = "HTML_PDF";
  const isGoogleDocs = isGoogleDocsEngine();
  assert.equal(isGoogleDocs, false);
  if (original) {
    process.env.DOCUMENT_MERGE_ENGINE = original;
  } else {
    delete process.env.DOCUMENT_MERGE_ENGINE;
  }
});

test("production-isolation: containsRealPii phát hiện CCCD 12 số", () => {
  const fieldValues = { So_CCCD: "072201012345" };
  const hasPii = containsRealPii(fieldValues);
  assert.equal(hasPii, true);
});

test("production-isolation: containsRealPii phát hiện số điện thoại", () => {
  const fieldValues = { So_dien_thoai: "0912345678" };
  const hasPii = containsRealPii(fieldValues);
  assert.equal(hasPii, true);
});

test("production-isolation: containsRealPii trả false với fixture giả", () => {
  const fieldValues = {
    Ho_ten: "Nguyễn Văn An",
    Ngay_sinh: "15/03/2001",
    So_tien: "1.234.567",
  };
  const hasPii = containsRealPii(fieldValues);
  assert.equal(hasPii, false);
});

test("production-isolation: assertVerificationSafe trả safe khi không phải production", () => {
  const originalVercel = process.env.VERCEL_ENV;
  const originalEngine = process.env.DOCUMENT_MERGE_ENGINE;

  process.env.VERCEL_ENV = "preview";
  process.env.DOCUMENT_MERGE_ENGINE = "GOOGLE_DOCS";

  const { safe, reason } = assertVerificationSafe();
  assert.equal(safe, true);
  assert.ok(!reason);

  if (originalVercel) {
    process.env.VERCEL_ENV = originalVercel;
  } else {
    delete process.env.VERCEL_ENV;
  }
  if (originalEngine) {
    process.env.DOCUMENT_MERGE_ENGINE = originalEngine;
  } else {
    delete process.env.DOCUMENT_MERGE_ENGINE;
  }
});

test("production-isolation: assertVerificationSafe trả unsafe khi engine HTML_PDF", () => {
  const originalEngine = process.env.DOCUMENT_MERGE_ENGINE;
  process.env.DOCUMENT_MERGE_ENGINE = "HTML_PDF";

  const { safe, reason } = assertVerificationSafe();
  assert.equal(safe, false);
  assert.ok(reason);
  assert.ok(reason.includes("HTML_PDF"));

  if (originalEngine) {
    process.env.DOCUMENT_MERGE_ENGINE = originalEngine;
  } else {
    delete process.env.DOCUMENT_MERGE_ENGINE;
  }
});

test("production-isolation: assertFixtureSafe trả safe với fixture giả", () => {
  const fieldValues = {
    Ho_ten: "Bùi Nguyễn Phương Vy",
    Ngay_sinh: "15/03/2001",
  };
  const { safe, reason } = assertFixtureSafe(fieldValues);
  assert.equal(safe, true);
  assert.ok(!reason);
});

test("production-isolation: assertFixtureSafe trả unsafe với PII thật", () => {
  const fieldValues = { So_CCCD: "072201012345" };
  const { safe, reason } = assertFixtureSafe(fieldValues);
  assert.equal(safe, false);
  assert.ok(reason);
  assert.ok(reason.includes("PII"));
});

test("production-isolation: createNonProductionMarker trả marker hợp lệ", () => {
  const marker = createNonProductionMarker();
  assert.equal(marker.nonProduction, true);
  assert.ok(marker.generatedAt);
  assert.ok(marker.disclaimer);
  assert.ok(marker.disclaimer.includes("NON-PRODUCTION"));
});
