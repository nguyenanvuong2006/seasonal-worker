import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// route.ts import next/server (NextResponse) — module chỉ resolve được bên trong
// Next.js build/dev thật, không resolve được bằng Node thuần ngoài framework, kể cả
// next đã cài trong node_modules. Thay vì chạy cả route qua 1 server Next.js thật chỉ
// để test 6 dòng logic auth, transpile CHÍNH source thật của route.ts (không viết lại)
// sang CommonJS rồi chạy trong vm sandbox với "require" giả lập CHỈ 2 module ngoài:
// next/server (NextResponse.json) và @/lib/scheduler (runDueJobs) — đây là 2 chỗ DUY
// NHẤT route.ts phụ thuộc vào runtime Next.js/DB, còn lại là logic auth thuần cần
// kiểm thử.
const routeSource = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
const jsSource = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

let runDueJobsCalled = false;

function makeContext() {
  runDueJobsCalled = false;
  const moduleObj = { exports: {} as Record<string, unknown> };
  const context = vm.createContext({
    module: moduleObj,
    exports: moduleObj.exports,
    require: (id: string) => {
      if (id === "next/server") {
        return { NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, body }) } };
      }
      if (id === "@/lib/scheduler") {
        return {
          runDueJobs: async () => {
            runDueJobsCalled = true;
            return [];
          },
        };
      }
      throw new Error(`Unexpected require("${id}") — route.ts should only import next/server and @/lib/scheduler`);
    },
    process,
    Request,
    console,
  });
  vm.runInContext(jsSource, context);
  return moduleObj.exports as { GET: (req: Request) => Promise<{ status: number; body: unknown }> };
}

const ORIGINAL_ENV = { ...process.env };
function resetEnv() {
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIGINAL_ENV)) delete process.env[k];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

// @types/node khai báo process.env.NODE_ENV là readonly — Object.assign vẫn ghi được
// (không đi qua kiểm tra gán trực tiếp của TS) nên dùng cách này thay vì ép kiểu "as any".
function setNodeEnv(value: "production" | "development") {
  Object.assign(process.env, { NODE_ENV: value });
}

test("production + thiếu CRON_SECRET -> 401, fail-closed, KHÔNG chạm runDueJobs", async () => {
  resetEnv();
  delete process.env.CRON_SECRET;
  setNodeEnv("production");
  const { GET } = makeContext();
  const res = await GET(new Request("https://example.com/api/cron/run"));
  assert.equal(res.status, 401);
  assert.equal(runDueJobsCalled, false);
  resetEnv();
});

test("production + CRON_SECRET đúng nhưng KHÔNG có Bearer token -> 401", async () => {
  resetEnv();
  process.env.CRON_SECRET = "test-secret";
  setNodeEnv("production");
  const { GET } = makeContext();
  const res = await GET(new Request("https://example.com/api/cron/run"));
  assert.equal(res.status, 401);
  assert.equal(runDueJobsCalled, false);
  resetEnv();
});

test("production + Bearer token SAI -> 401", async () => {
  resetEnv();
  process.env.CRON_SECRET = "correct-secret";
  setNodeEnv("production");
  const { GET } = makeContext();
  const res = await GET(
    new Request("https://example.com/api/cron/run", { headers: { authorization: "Bearer wrong-secret" } }),
  );
  assert.equal(res.status, 401);
  assert.equal(runDueJobsCalled, false);
  resetEnv();
});

test("production + Bearer token ĐÚNG -> chạy bình thường (qua auth, gọi runDueJobs)", async () => {
  resetEnv();
  process.env.CRON_SECRET = "correct-secret";
  setNodeEnv("production");
  const { GET } = makeContext();
  const res = await GET(
    new Request("https://example.com/api/cron/run", { headers: { authorization: "Bearer correct-secret" } }),
  );
  assert.notEqual(res.status, 401);
  assert.equal(runDueJobsCalled, true);
  resetEnv();
});

test("dev (NODE_ENV != production) + thiếu CRON_SECRET -> không bị chặn (tiện phát triển)", async () => {
  resetEnv();
  delete process.env.CRON_SECRET;
  setNodeEnv("development");
  const { GET } = makeContext();
  const res = await GET(new Request("https://example.com/api/cron/run"));
  assert.notEqual(res.status, 401);
  assert.equal(runDueJobsCalled, true);
  resetEnv();
});

test("dev + CRON_SECRET CÓ set nhưng token sai -> vẫn 401 (không nới lỏng khi đã cấu hình secret)", async () => {
  resetEnv();
  process.env.CRON_SECRET = "dev-secret";
  setNodeEnv("development");
  const { GET } = makeContext();
  const res = await GET(new Request("https://example.com/api/cron/run"));
  assert.equal(res.status, 401);
  assert.equal(runDueJobsCalled, false);
  resetEnv();
});
