import test from "node:test";
import assert from "node:assert/strict";
import {
  isDiagnosticPath,
  isDiagnosticsEnabled,
  isOverlayE2EPath,
  isRestrictedWorkerPath,
  shouldBlockDiagnosticRequest,
  shouldBlockOverlayE2ERequest,
  shouldBlockRestrictedWorkerRequest,
} from "./worker-diag-gate.ts";

test("isDiagnosticPath: chỉ true cho path bắt đầu bằng /diag/", () => {
  assert.equal(isDiagnosticPath("/diag/db-identity"), true);
  assert.equal(isDiagnosticPath("/diag/claim-probe"), true);
  assert.equal(isDiagnosticPath("/diag/claim-existing"), true);
  assert.equal(isDiagnosticPath("/health"), false);
  assert.equal(isDiagnosticPath("/run"), false);
  assert.equal(isDiagnosticPath("/diagnostics"), false, "không phải path /diag/* thật (thiếu dấu / sau diag)");
});

test("isOverlayE2EPath: chỉ true cho đúng path /run-overlay", () => {
  assert.equal(isOverlayE2EPath("/run-overlay"), true);
  assert.equal(isOverlayE2EPath("/run"), false);
  assert.equal(isOverlayE2EPath("/run-overlay/extra"), false);
  assert.equal(isOverlayE2EPath("/health"), false);
  assert.equal(isOverlayE2EPath("/diag/claim-probe"), false);
});

test("isRestrictedWorkerPath: gộp /diag/* + /run-overlay", () => {
  assert.equal(isRestrictedWorkerPath("/diag/db-identity"), true);
  assert.equal(isRestrictedWorkerPath("/run-overlay"), true);
  assert.equal(isRestrictedWorkerPath("/run"), false);
  assert.equal(isRestrictedWorkerPath("/health"), false);
  assert.equal(isRestrictedWorkerPath("/verify-visual"), false);
});

test("isDiagnosticsEnabled: false khi WORKER_ENV=production, true mọi trường hợp khác", () => {
  assert.equal(isDiagnosticsEnabled({ WORKER_ENV: "production" }), false);
  assert.equal(isDiagnosticsEnabled({ WORKER_ENV: "staging" }), true);
  assert.equal(isDiagnosticsEnabled({}), true, "không set WORKER_ENV -> giữ hành vi hiện tại (bật)");
  assert.equal(isDiagnosticsEnabled({ WORKER_ENV: "Production" }), true, "so khớp chính xác chữ thường — không đoán case-insensitive");
});

test("shouldBlockDiagnosticRequest: chỉ chặn path /diag/* khi WORKER_ENV=production", () => {
  assert.equal(shouldBlockDiagnosticRequest("/diag/db-identity", { WORKER_ENV: "production" }), true);
  assert.equal(shouldBlockDiagnosticRequest("/diag/claim-probe", { WORKER_ENV: "production" }), true);
  assert.equal(shouldBlockDiagnosticRequest("/health", { WORKER_ENV: "production" }), false, "/health không bao giờ bị chặn");
  assert.equal(shouldBlockDiagnosticRequest("/run", { WORKER_ENV: "production" }), false, "/run không bao giờ bị chặn");
  assert.equal(shouldBlockDiagnosticRequest("/diag/db-identity", { WORKER_ENV: "staging" }), false);
  assert.equal(shouldBlockDiagnosticRequest("/diag/db-identity", {}), false);
});

test("shouldBlockOverlayE2ERequest: chỉ chặn /run-overlay khi WORKER_ENV=production", () => {
  assert.equal(shouldBlockOverlayE2ERequest("/run-overlay", { WORKER_ENV: "production" }), true);
  assert.equal(shouldBlockOverlayE2ERequest("/run-overlay", { WORKER_ENV: "staging" }), false);
  assert.equal(shouldBlockOverlayE2ERequest("/run-overlay", {}), false);
  assert.equal(shouldBlockOverlayE2ERequest("/run", { WORKER_ENV: "production" }), false);
  assert.equal(shouldBlockOverlayE2ERequest("/health", { WORKER_ENV: "production" }), false);
});

test("shouldBlockRestrictedWorkerRequest: gate tổng cho mọi restricted path", () => {
  assert.equal(shouldBlockRestrictedWorkerRequest("/diag/db-identity", { WORKER_ENV: "production" }), true);
  assert.equal(shouldBlockRestrictedWorkerRequest("/run-overlay", { WORKER_ENV: "production" }), true);
  assert.equal(shouldBlockRestrictedWorkerRequest("/diag/claim-probe", { WORKER_ENV: "production" }), true);
  assert.equal(shouldBlockRestrictedWorkerRequest("/run-overlay", { WORKER_ENV: "staging" }), false);
  assert.equal(shouldBlockRestrictedWorkerRequest("/run-overlay", {}), false);
  assert.equal(shouldBlockRestrictedWorkerRequest("/run", { WORKER_ENV: "production" }), false, "/run production KHÔNG bị chặn (engine gate riêng)");
  assert.equal(shouldBlockRestrictedWorkerRequest("/health", { WORKER_ENV: "production" }), false);
});

