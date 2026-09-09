/**
 * AI COPILOT — read-only structural proof (mission requirement: "prove no
 * tool can mutate"). Static source scan, not a DB integration test — this
 * repo has no local Postgres for node:test to run against (see every other
 * *-kpi.ts/route.ts file: none are DB-integration-tested either), so the
 * strongest CHEAP guarantee available is: no file under ai-copilot/tools/
 * (the READ_TOOLS registry) ever references a Drizzle write primitive.
 *
 * This scan is scoped to tools/ ONLY, not the whole ai-copilot/ tree —
 * Phase 3 ("Safe Action Copilot") deliberately introduces a SEPARATE write
 * surface (action-registry.ts + actions/*.ts + proposals.ts) with its own,
 * much stricter, structural proof — see action-write-boundary.test.ts.
 * A regression here means someone added a mutation to what must stay a
 * strictly read-only tool surface.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const AI_COPILOT_DIR = join(HERE, ".."); // src/lib/ai-copilot
const READ_TOOLS_DIR = HERE; // src/lib/ai-copilot/tools

const FORBIDDEN_WRITE_PATTERNS: RegExp[] = [
  /\.insert\s*\(/,
  /\.update\s*\(/,
  /\.delete\s*\(/,
  /\.transaction\s*\(/,
  /\bdrizzle-orm\/pg-core\b.*\binsert\b/,
];

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectSourceFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

test("no file under src/lib/ai-copilot/tools/ (READ_TOOLS) contains a Drizzle write primitive (.insert/.update/.delete/.transaction)", () => {
  const files = collectSourceFiles(READ_TOOLS_DIR);
  assert.ok(files.length >= 9, `expected at least 9 read-tool source files, found ${files.length} — did the scan path break?`);
  const offenders: { file: string; line: number; text: string }[] = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (FORBIDDEN_WRITE_PATTERNS.some((re) => re.test(line))) {
        offenders.push({ file, line: i + 1, text: line.trim() });
      }
    });
  }
  assert.deepEqual(offenders, [], `found write-primitive references in the read-only AI Copilot tool surface: ${JSON.stringify(offenders)}`);
});

test("orchestrator-core.ts and scope-helpers.ts (shared, non-tool infrastructure) also contain no Drizzle write primitive", () => {
  const files = [join(AI_COPILOT_DIR, "orchestrator-core.ts"), join(AI_COPILOT_DIR, "scope-helpers.ts"), join(AI_COPILOT_DIR, "time-resolver.ts"), join(AI_COPILOT_DIR, "risk-rules.ts")];
  const offenders: { file: string; line: number; text: string }[] = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (FORBIDDEN_WRITE_PATTERNS.some((re) => re.test(line))) offenders.push({ file, line: i + 1, text: line.trim() });
    });
  }
  assert.deepEqual(offenders, []);
});

test("no tool's declared `name:` field is execute_sql / run_query / raw_sql (no free-text SQL escape hatch)", () => {
  const toolFiles = collectSourceFiles(join(AI_COPILOT_DIR, "tools"));
  const declaredNames: string[] = [];
  for (const file of toolFiles) {
    for (const match of readFileSync(file, "utf8").matchAll(/name:\s*"([a-z_]+)"/g)) declaredNames.push(match[1]);
  }
  assert.ok(declaredNames.length >= 15, `expected at least 15 declared tool names, found ${declaredNames.length}`);
  const forbidden = declaredNames.filter((n) => /execute_sql|run_query|raw_sql|runrawquery/i.test(n));
  assert.deepEqual(forbidden, []);
});
