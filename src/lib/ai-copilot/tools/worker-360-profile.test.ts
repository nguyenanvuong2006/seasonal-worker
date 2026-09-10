/**
 * AI COPILOT — structural proof for get_worker_employment_history (Worker
 * 360° Profile mission, 2026-09-10, Section 21). Same convention as
 * read-only-audit.test.ts/privacy-audit.test.ts/workers-drilldown.test.ts —
 * worker-360-profile.ts imports "server-only" and touches the DB (via
 * getWorker360Profile), so it is proven structurally here rather than
 * executed; the canonical service it delegates to is ALREADY proven
 * functionally end-to-end in src/lib/worker-360-profile.test.ts (RBAC/Data
 * Scope/IDOR), which is exactly the point of reusing that service instead
 * of re-implementing its logic here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FILE = join(HERE, "worker-360-profile.ts");
const REGISTRY_FILE = join(HERE, "..", "tool-registry.ts");

function readSource(): string {
  return readFileSync(FILE, "utf8");
}

test("get_worker_employment_history is exported via worker360ProfileTools", () => {
  const src = readSource();
  assert.match(src, /export const worker360ProfileTools = \[get_worker_employment_history\];/);
});

test("get_worker_employment_history is registered in the AI Copilot tool registry", () => {
  const src = readFileSync(REGISTRY_FILE, "utf8");
  assert.match(src, /import \{ worker360ProfileTools \} from "\.\/tools\/worker-360-profile\.ts";/);
  assert.match(src, /\.\.\.worker360ProfileTools,/);
});

test("execute() re-resolves Data Scope from the session on every call (never accepts a caller-supplied scope) and delegates to the CANONICAL getWorker360Profile service, never a second re-implementation", () => {
  const src = readSource();
  assert.match(src, /import \{ getWorker360Profile, type Worker360Profile \} from "@\/lib\/worker-360-profile";/);
  assert.match(src, /const scope = await getUserScope\(ctx\.session\);/, "must call getUserScope(ctx.session) inside execute(), not accept scope as an argument");
  assert.match(src, /const profile = await getWorker360Profile\(args\.workerId, scope\);/, "must pass the session-derived scope straight through — never widen it");
});

test("a null profile (IDOR: out-of-scope OR non-existent workerId) is surfaced as NOT_FOUND, never a distinguishable existence oracle", () => {
  const src = readSource();
  assert.match(src, /if \(!profile\) throw new ToolExecutionError\("NOT_FOUND", "[^"]+"\);/);
});

test("workerId is validated as a UUID and the tool never declares or reads a raw cccd argument — CCCD must never be an AI-tool input", () => {
  const src = readSource();
  assert.match(src, /const UUID_RE = \/\^\[0-9a-f\]/, "must validate workerId as a UUID before ever calling the service");
  assert.match(src, /if \(!workerId \|\| !UUID_RE\.test\(workerId\)\)/);
  assert.doesNotMatch(src, /properties:\s*\{\s*cccd:/, "must never declare a raw cccd input parameter");
  assert.doesNotMatch(src, /args\.cccd\b/, "must never read args.cccd");
});

test("no new execute_sql/run_query/raw_sql tool name was introduced alongside this tool", () => {
  const src = readSource();
  assert.doesNotMatch(src, /name:\s*"execute_sql"/);
  assert.doesNotMatch(src, /name:\s*"run_query"/);
  assert.doesNotMatch(src, /name:\s*"raw_sql"/);
});

test("the returned data is exactly the canonical service's profile object — no extra field is appended, minimizing surface for privacy-audit.test.ts's raw-column scan", () => {
  const src = readSource();
  assert.match(src, /return \{ data: profile, source: \{ domains: \[[^\]]+\], asOf: todayStr\(\) \} \};/);
});
