import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("Legal Pages - Privacy Policy", () => {
  const privacyPath = path.join(__dirname, "privacy", "page.tsx");
  assert.ok(fs.existsSync(privacyPath), "/privacy route exists");
  
  const privacyCode = fs.readFileSync(privacyPath, "utf-8");
  
  assert.match(privacyCode, /Chính sách bảo mật/, "Privacy page contains expected title");
  assert.match(privacyCode, /0263 3620295/, "Public phone/contact text is present");
  
  // Negative assertions
  assert.doesNotMatch(privacyCode, /bảo mật tuyệt đối/i, "No unsupported absolute-security wording");
  assert.doesNotMatch(privacyCode, /[0-9]+\s+(ngày|tháng|năm)\s+sau/i, "No invented fixed retention period");
  assert.doesNotMatch(privacyCode, /đảm bảo việc làm/i, "No claim that registration guarantees employment");
  assert.doesNotMatch(privacyCode, /auth/i, "Pages do not require auth (no auth middleware/imports)");
  assert.doesNotMatch(privacyCode, /admin/i, "Pages do not import admin-only modules");
});

test("Legal Pages - Terms of Service", () => {
  const termsPath = path.join(__dirname, "terms", "page.tsx");
  assert.ok(fs.existsSync(termsPath), "/terms route exists");
  
  const termsCode = fs.readFileSync(termsPath, "utf-8");
  
  assert.match(termsCode, /Điều khoản sử dụng/, "Terms page contains expected title");
  assert.match(termsCode, /0263 3620295/, "Public phone/contact text is present");
  
  // Negative assertions
  assert.match(termsCode, /không(<[^>]+>)?( tạo ra)? bất kỳ hợp đồng/i, "Does not guarantee employment contract");
  assert.doesNotMatch(termsCode, /bảo mật tuyệt đối/i, "No unsupported absolute-security wording");
  assert.doesNotMatch(termsCode, /auth/i, "Pages do not require auth (no auth middleware/imports)");
  assert.doesNotMatch(termsCode, /admin/i, "Pages do not import admin-only modules");
  assert.doesNotMatch(termsCode, /giá trị tương đương với việc ký kết bằng văn bản/i, "Does not claim PKI equivalent signature");
  assert.doesNotMatch(termsCode, /bằng việc nộp hồ sơ, bạn đồng ý/i, "Does not claim explicit consent unsupported by UI");
});

test("Legal Pages - Homepage links", () => {
  const homePath = path.join(__dirname, "page.tsx");
  assert.ok(fs.existsSync(homePath), "Homepage exists");
  
  const homeCode = fs.readFileSync(homePath, "utf-8");
  
  assert.match(homeCode, /href="\/privacy"/, "Homepage contains link to /privacy");
  assert.match(homeCode, /href="\/terms"/, "Homepage contains link to /terms");
});
