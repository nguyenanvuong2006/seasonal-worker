import test from "node:test";
import assert from "node:assert/strict";
import { isDiagnosticPath, isDiagnosticsEnabled, shouldBlockDiagnosticRequest } from "./worker-diag-gate.ts";

test("isDiagnosticPath: chỉ true cho path bắt đầu bằng /diag/", () => {
  assert.equal(isDiagnosticPath("/diag/db-identity"), true);
  assert.equal(isDiagnosticPath("/diag/claim-probe"), true);
  assert.equal(isDiagnosticPath("/diag/claim-existing"), true);
  assert.equal(isDiagnosticPath("/health"), false);
  assert.equal(isDiagnosticPath("/run"), false);
  assert.equal(isDiagnosticPath("/diagnostics"), false, "không phải path /diag/* thật (thiếu dấu / sau diag)");
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
