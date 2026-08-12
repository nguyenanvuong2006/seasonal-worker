import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// bootstrapInitialAdmin() không export (private trong seed.ts) và ensureSeed() (hàm
// export) còn seed rất nhiều bảng khác (formQuestions/fieldDefinitions/workflowStages/
// scheduledJobs...) đòi hỏi stub cả loạt schema/data không liên quan tới việc test admin
// bootstrap. Trích ĐÚNG SOURCE THẬT của const + function cần test, chạy trong vm với
// "db" giả lập ghi lại lời gọi insert — kiểm thử đúng logic thật, không viết lại.
const seedSource = readFileSync(new URL("./seed.ts", import.meta.url), "utf8");

function extractConst(name: string): string {
  const marker = `const ${name} = `;
  const start = seedSource.indexOf(marker);
  assert.notEqual(start, -1, `Missing const ${name}`);
  const end = seedSource.indexOf(";", start);
  return seedSource.slice(start, end + 1);
}

function extractFunction(name: string): string {
  const asyncMarker = `async function ${name}(`;
  const asyncStart = seedSource.indexOf(asyncMarker);
  const start = asyncStart !== -1 ? asyncStart : seedSource.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `Missing function ${name}`);
  const openBrace = seedSource.indexOf("{", start);
  let depth = 0;
  for (let i = openBrace; i < seedSource.length; i++) {
    if (seedSource[i] === "{") depth++;
    if (seedSource[i] === "}") depth--;
    if (depth === 0) return seedSource.slice(start, i + 1);
  }
  throw new Error(`Could not parse ${name}`);
}

const tsSnippet = [
  extractConst("MIN_INITIAL_ADMIN_PASSWORD_LENGTH"),
  extractFunction("bootstrapInitialAdmin"),
  "exports.bootstrapInitialAdmin = bootstrapInitialAdmin;",
].join("\n\n");
const jsSnippet = ts.transpileModule(tsSnippet, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

interface InsertCall {
  table: unknown;
  values: Record<string, unknown>;
}

function makeContext() {
  const insertCalls: InsertCall[] = [];
  const consoleWarnings: string[] = [];
  const usersTableRef = { __table: "users" };
  const db = {
    insert(table: unknown) {
      return {
        values(values: Record<string, unknown>) {
          insertCalls.push({ table, values });
          return { onConflictDoNothing: async () => undefined };
        },
      };
    },
  };
  const context = vm.createContext({
    exports: {},
    db,
    users: usersTableRef,
    hashPassword: (plain: string) => `HASHED(${plain})`,
    console: { warn: (msg: string) => consoleWarnings.push(msg), error: () => {} },
    process: { env: { ...process.env } },
  });
  vm.runInContext(jsSnippet, context);
  return {
    bootstrapInitialAdmin: (context as unknown as { exports: { bootstrapInitialAdmin: () => Promise<void> } }).exports
      .bootstrapInitialAdmin,
    insertCalls,
    consoleWarnings,
    setEnv: (env: Record<string, string | undefined>) => {
      (context as unknown as { process: { env: Record<string, string | undefined> } }).process.env = env;
    },
    usersTableRef,
  };
}

test("Database trống + KHÔNG có INITIAL_ADMIN_* -> không insert gì, không sinh admin/password hardcoded", async () => {
  const { bootstrapInitialAdmin, insertCalls, consoleWarnings, setEnv } = makeContext();
  setEnv({});
  await bootstrapInitialAdmin();
  assert.equal(insertCalls.length, 0);
  assert.ok(consoleWarnings.some((w) => w.includes("Chưa có tài khoản nào")));
});

test("Chỉ có INITIAL_ADMIN_USERNAME, thiếu PASSWORD -> không insert", async () => {
  const { bootstrapInitialAdmin, insertCalls, setEnv } = makeContext();
  setEnv({ INITIAL_ADMIN_USERNAME: "admin" });
  await bootstrapInitialAdmin();
  assert.equal(insertCalls.length, 0);
});

test("PASSWORD ngắn hơn ngưỡng tối thiểu -> từ chối bootstrap, không insert", async () => {
  const { bootstrapInitialAdmin, insertCalls, consoleWarnings, setEnv } = makeContext();
  setEnv({ INITIAL_ADMIN_USERNAME: "admin", INITIAL_ADMIN_PASSWORD: "short" });
  await bootstrapInitialAdmin();
  assert.equal(insertCalls.length, 0);
  assert.ok(consoleWarnings.some((w) => w.includes("tối thiểu")));
});

test("Bootstrap bằng INITIAL_ADMIN_USERNAME/PASSWORD hợp lệ -> thành công, đúng role ADMIN, password đã HASH (không phải plaintext)", async () => {
  const { bootstrapInitialAdmin, insertCalls, usersTableRef, setEnv } = makeContext();
  setEnv({ INITIAL_ADMIN_USERNAME: "admin", INITIAL_ADMIN_PASSWORD: "mat-khau-du-dai-123" });
  await bootstrapInitialAdmin();
  assert.equal(insertCalls.length, 1);
  assert.equal(insertCalls[0].table, usersTableRef);
  assert.equal(insertCalls[0].values.username, "admin");
  assert.equal(insertCalls[0].values.role, "ADMIN");
  assert.equal(insertCalls[0].values.passwordHash, "HASHED(mat-khau-du-dai-123)");
  assert.notEqual(insertCalls[0].values.passwordHash, "mat-khau-du-dai-123");
});

test("Không log password thật (plaintext) ở bất kỳ nhánh nào", async () => {
  const { bootstrapInitialAdmin, consoleWarnings, setEnv } = makeContext();
  const secretPassword = "cuc-ky-bi-mat-999";
  setEnv({ INITIAL_ADMIN_USERNAME: "admin", INITIAL_ADMIN_PASSWORD: "short" }); // nhánh từ chối do quá ngắn
  await bootstrapInitialAdmin();
  setEnv({ INITIAL_ADMIN_USERNAME: "admin", INITIAL_ADMIN_PASSWORD: secretPassword }); // nhánh thành công
  await bootstrapInitialAdmin();
  assert.ok(!consoleWarnings.some((w) => w.includes(secretPassword)));
});

// ── Bootstrap không overwrite user hiện hữu: đây là trách nhiệm của ensureSeed()
// (chỉ gọi bootstrapInitialAdmin() khi `SELECT ... FROM users LIMIT 1` rỗng) VÀ của
// onConflictDoNothing() trên chính insert — cả 2 lớp bảo vệ đã xác nhận bằng code
// review trực tiếp (seed.ts dòng ensureSeed: "if (existing.length === 0) { await
// bootstrapInitialAdmin(); }", và .insert(users).values(...).onConflictDoNothing()
// ở đây). Không thể test qua DB thật trong môi trường này (không có DATABASE_URL/
// Postgres sống) — xác nhận bằng static check thay vì "chạy giả rồi tuyên bố pass".
test("STATIC CHECK: ensureSeed chỉ gọi bootstrapInitialAdmin khi bảng users rỗng, và insert dùng onConflictDoNothing", () => {
  assert.match(seedSource, /if \(existing\.length === 0\) \{\s*await bootstrapInitialAdmin\(\);/);
  assert.match(extractFunction("bootstrapInitialAdmin"), /\.onConflictDoNothing\(\)/);
});
