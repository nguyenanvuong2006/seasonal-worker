/**
 * AI COPILOT — Phase 3 "Safe Action Copilot" structural write-boundary
 * proof. Static source scan (no DB, no live registry import — importing
 * action-registry.ts/tool-registry.ts here would pull in "server-only",
 * which throws under plain `node --test`; see deepseek-provider.ts's own
 * docblock for the same constraint). This is the strongest cheap
 * guarantee available that:
 *
 *   1. A business-table write primitive (.insert/.update/.delete/
 *      .transaction) inside actions/*.ts appears ONLY inside that file's
 *      `execute:` handler — never inside parseArgs/validate/buildPreview,
 *      which must stay read-only (prepare causes zero business writes).
 *   2. proposals.ts (the ai_action_proposals bookkeeping table) is the
 *      ONLY file outside actions/*.ts allowed to contain a write
 *      primitive in the whole ai-copilot/ tree.
 *   3. READ_TOOLS names (tools/*.ts) and ACTION_TOOLS names (actions/*.ts)
 *      are completely disjoint sets — the two registries can never
 *      collide (mirrors the runtime throw in action-registry.ts, proven
 *      here without needing to import either registry).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ACTIONS_DIR = join(HERE, "actions");
const TOOLS_DIR = join(HERE, "tools");
const PROPOSALS_FILE = join(HERE, "proposals.ts");

const WRITE_PATTERN = /\.(insert|update|delete|transaction)\s*\(/;

function listTsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".test.ts"))
    .map((e) => join(dir, e.name));
}

function declaredNames(dir: string): string[] {
  const names: string[] = [];
  for (const file of listTsFiles(dir)) {
    for (const match of readFileSync(file, "utf8").matchAll(/name:\s*"([a-z_]+)"/g)) names.push(match[1]);
  }
  return names;
}

test("every write primitive inside actions/*.ts occurs strictly AFTER that file's `execute:` key — never in parseArgs/validate/buildPreview", () => {
  const files = listTsFiles(ACTIONS_DIR);
  assert.ok(files.length >= 1, "expected at least one action file — did the scan path break?");
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const executeKeyIndex = source.search(/^\s*execute:\s*async/m);
    assert.ok(executeKeyIndex >= 0, `${file}: could not locate an \`execute:\` handler`);
    const before = source.slice(0, executeKeyIndex);
    const beforeLines = before.split("\n");
    const offendingLines = beforeLines.filter((l) => WRITE_PATTERN.test(l));
    assert.deepEqual(offendingLines, [], `${file}: found a write primitive BEFORE the execute: handler (i.e. inside parseArgs/validate/buildPreview) — prepare() must never write: ${JSON.stringify(offendingLines)}`);
  }
});

test("outside actions/*.ts, only proposals.ts is allowed to contain a Drizzle write primitive anywhere in src/lib/ai-copilot/", () => {
  const root = join(HERE);
  const offenders: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        if (full === PROPOSALS_FILE || full.startsWith(ACTIONS_DIR)) continue;
        const lines = readFileSync(full, "utf8").split("\n");
        if (lines.some((l) => WRITE_PATTERN.test(l))) offenders.push(full);
      }
    }
  }
  walk(root);
  assert.deepEqual(offenders, []);
});

test("READ_TOOLS names (tools/*.ts) and ACTION_TOOLS names (actions/*.ts) are completely disjoint — mirrors the runtime collision check in action-registry.ts", () => {
  const readNames = declaredNames(TOOLS_DIR);
  const actionNames = declaredNames(ACTIONS_DIR);
  assert.ok(readNames.length >= 20, `expected at least 20 read tool names, found ${readNames.length}`);
  assert.ok(actionNames.length >= 1, `expected at least 1 action name, found ${actionNames.length}`);
  const overlap = actionNames.filter((n) => readNames.includes(n));
  assert.deepEqual(overlap, [], `action name(s) collide with a READ_TOOLS name: ${overlap.join(", ")}`);
});

test("no action's declared name starts with get_/list_ (a read-shaped name) and no read tool's name starts with prepare_/execute_ (an action-shaped name) — naming stays unambiguous at a glance", () => {
  const actionNames = declaredNames(ACTIONS_DIR);
  for (const n of actionNames) assert.ok(!/^(get_|list_)/.test(n), `action "${n}" uses a read-shaped name prefix`);
  const readNames = declaredNames(TOOLS_DIR);
  for (const n of readNames) assert.ok(!/^(prepare_|execute_)/.test(n), `read tool "${n}" uses an action-shaped name prefix`);
});
