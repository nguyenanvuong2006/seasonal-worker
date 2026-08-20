import test from "node:test";
import assert from "node:assert/strict";
import { checkEngineDefault, checkAuthEnv, checkStorageEnv } from "./production-readiness.ts";

test("checkEngineDefault: PASS chỉ khi GOOGLE_DOCS (default an toàn), BLOCKED nếu đã là HTML_PDF", () => {
  assert.deepEqual(checkEngineDefault({}), { value: "GOOGLE_DOCS", isGoogleDocs: true }, "không set -> mặc định an toàn");
  assert.deepEqual(checkEngineDefault({ DOCUMENT_MERGE_ENGINE: "GOOGLE_DOCS" }), { value: "GOOGLE_DOCS", isGoogleDocs: true });
  assert.deepEqual(checkEngineDefault({ DOCUMENT_MERGE_ENGINE: "HTML_PDF" }), { value: "HTML_PDF", isGoogleDocs: false });
  assert.deepEqual(
    checkEngineDefault({ DOCUMENT_MERGE_ENGINE: "garbage" }),
    { value: "GOOGLE_DOCS", isGoogleDocs: true },
    "giá trị không hợp lệ -> fallback an toàn GOOGLE_DOCS (đúng hành vi parseDocumentMergeEngine hiện có)",
  );
});

test("checkAuthEnv: pass=true chỉ khi đủ mọi biến worker-auth bắt buộc", () => {
  const full = {
    PDF_MERGE_WORKER_URL: "https://worker.example.run.app",
    MERGE_WORKER_SECRET: "secret",
    GOOGLE_WIF_PROJECT_NUMBER: "123",
    GOOGLE_WIF_POOL_ID: "pool",
    GOOGLE_WIF_PROVIDER_ID: "provider",
    GOOGLE_WIF_SERVICE_ACCOUNT: "sa@project.iam.gserviceaccount.com",
  };
  assert.deepEqual(checkAuthEnv(full), { pass: true, missing: [] });

  const missingOne = { ...full, MERGE_WORKER_SECRET: "" };
  const result = checkAuthEnv(missingOne);
  assert.equal(result.pass, false);
  assert.deepEqual(result.missing, ["MERGE_WORKER_SECRET"]);

  assert.equal(checkAuthEnv({}).pass, false);
  assert.equal(checkAuthEnv({}).missing.length, 6, "thiếu hết -> báo đủ 6 biến, không rơi rớt cái nào");
});

test("checkStorageEnv: fail rõ ràng khi STORAGE_PROVIDER != google_drive", () => {
  const result = checkStorageEnv({ STORAGE_PROVIDER: "local" });
  assert.equal(result.pass, false);
  assert.equal(result.provider, "local");
  assert.ok(result.missing.some((m) => m.includes("STORAGE_PROVIDER")));
});

test("checkStorageEnv: pass=true với OAuth set đầy đủ", () => {
  const result = checkStorageEnv({
    STORAGE_PROVIDER: "google_drive",
    GOOGLE_DRIVE_ROOT_FOLDER_ID: "folder-id",
    GOOGLE_CLIENT_ID: "id",
    GOOGLE_CLIENT_SECRET: "secret",
    GOOGLE_REFRESH_TOKEN: "token",
  });
  assert.deepEqual(result, { pass: true, missing: [], provider: "google_drive" });
});

test("checkStorageEnv: pass=true với service-account set đầy đủ (không cần OAuth)", () => {
  const result = checkStorageEnv({
    STORAGE_PROVIDER: "google_drive",
    GOOGLE_DRIVE_ROOT_FOLDER_ID: "folder-id",
    GOOGLE_SERVICE_ACCOUNT_EMAIL: "sa@project.iam.gserviceaccount.com",
    GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----",
  });
  assert.deepEqual(result, { pass: true, missing: [], provider: "google_drive" });
});

test("checkStorageEnv: fail khi google_drive nhưng thiếu CẢ 2 bộ auth", () => {
  const result = checkStorageEnv({ STORAGE_PROVIDER: "google_drive", GOOGLE_DRIVE_ROOT_FOLDER_ID: "folder-id" });
  assert.equal(result.pass, false);
  assert.ok(result.missing.some((m) => m.includes("GOOGLE_CLIENT_ID")));
});
