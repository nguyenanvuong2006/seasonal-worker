import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import ts from "typescript";

// auth.ts imports "server-only" và "next/headers" (cần request context thật của
// Next.js server, không chạy được ngoài framework) — import cả module là bất khả thi
// trong 1 test đơn giản. hashPassword/verifyPassword lại là 2 hàm THUẦN (chỉ dùng
// node:crypto, không phụ thuộc DB/Next.js) nên trích trực tiếp SOURCE THẬT của chúng
// ra, transpile TS -> JS (dùng chính package "typescript" của project), rồi chạy
// trong vm sandbox — vẫn kiểm thử ĐÚNG code thật đang chạy production, không phải
// bản viết lại riêng cho test.
const authSource = readFileSync(new URL("./auth.ts", import.meta.url), "utf8");

function extractFunction(name: string): string {
  const marker = `export function ${name}(`;
  const start = authSource.indexOf(marker);
  assert.notEqual(start, -1, `Missing export function ${name} in auth.ts`);
  const openBrace = authSource.indexOf("{", start);
  let depth = 0;
  for (let i = openBrace; i < authSource.length; i++) {
    if (authSource[i] === "{") depth++;
    if (authSource[i] === "}") depth--;
    if (depth === 0) return authSource.slice(start, i + 1);
  }
  throw new Error(`Could not parse ${name}`);
}

const tsSnippet = [extractFunction("hashPassword"), extractFunction("verifyPassword")].join("\n\n");
const jsSnippet = ts.transpileModule(tsSnippet, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

const context = vm.createContext({ randomBytes, scryptSync, timingSafeEqual, Buffer, exports: {} });
vm.runInContext(jsSnippet, context);
const { hashPassword, verifyPassword } = context as unknown as {
  hashPassword: (plain: string) => string;
  verifyPassword: (plain: string, stored: string) => boolean;
};

test("hashPassword/verifyPassword round-trip đúng mật khẩu", () => {
  const hash = hashPassword("mat-khau-that-manh-123");
  assert.equal(verifyPassword("mat-khau-that-manh-123", hash), true);
});

test("verifyPassword từ chối mật khẩu sai", () => {
  const hash = hashPassword("mat-khau-dung");
  assert.equal(verifyPassword("mat-khau-sai", hash), false);
});

test("verifyPassword không throw với dữ liệu hash hỏng/định dạng lạ", () => {
  assert.equal(verifyPassword("bat-ky-gi", "khong-phai-dinh-dang-salt:hash"), false);
  assert.equal(verifyPassword("bat-ky-gi", ""), false);
  assert.equal(verifyPassword("bat-ky-gi", "chi-1-phan-khong-co-dau-hai-cham"), false);
});

test("hashPassword sinh salt khác nhau mỗi lần -> 2 hash khác nhau cho cùng 1 mật khẩu", () => {
  const h1 = hashPassword("cung-1-mat-khau");
  const h2 = hashPassword("cung-1-mat-khau");
  assert.notEqual(h1, h2);
  assert.equal(verifyPassword("cung-1-mat-khau", h1), true);
  assert.equal(verifyPassword("cung-1-mat-khau", h2), true);
});
