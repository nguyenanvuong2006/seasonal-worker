/**
 * job-progress-panel.tsx — regression tests (2026-09, "Lịch sử Merge"
 * persistent reopen feature). No jsdom in this repo — static-source
 * assertions, matching merge-workspace.test.ts's established pattern.
 *
 * This component was ALREADY fully DB-driven before this change (polls
 * GET /api/document-merge/jobs/[id] purely by jobId prop, no dependency on
 * how it got mounted) — these tests lock in that property plus the new
 * explicit Xem/Tải/In PDF labeling this mission asked for.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SOURCE_PATH = "src/components/document-merge/job-progress-panel.tsx";

function readSource(): string {
  return readFileSync(join(ROOT, SOURCE_PATH), "utf8");
}

test("polls GET /api/document-merge/jobs/[id] purely by the jobId prop — read-only, no re-trigger/re-run", () => {
  const code = readSource();
  assert.match(code, /fetch\(`\/api\/document-merge\/jobs\/\$\{jobId\}`/);
});

test("never reads/writes localStorage — reopening after reload must come from the DB, not the browser", () => {
  const code = readSource();
  assert.doesNotMatch(code, /localStorage/);
});

test("outputPdfUrl exposes explicit Xem PDF / Tải PDF / In PDF actions, all pointing at the SAME persisted artifact URL (never regenerated)", () => {
  const code = readSource();
  const block = code.slice(code.indexOf("data.outputPdfUrl &&"), code.indexOf("data.outputZipUrl &&"));
  assert.match(block, />\s*Xem PDF\s*</);
  assert.match(block, />\s*Tải PDF\s*</);
  assert.match(block, />\s*In PDF\s*</);
  // All three must use the same href — no separate render/regenerate call.
  const hrefs = block.match(/href=\{data\.outputPdfUrl\}/g) ?? [];
  assert.equal(hrefs.length, 3);
});

test("continues polling regardless of terminal/non-terminal status — reopening a COMPLETED job still fetches its persisted result, not just a live one", () => {
  const code = readSource();
  // load() and the poll interval are set up unconditionally in the mount
  // effect — not gated behind an isTerminal check.
  const effectBlock = code.slice(code.indexOf("useEffect(() => {\n    load();"), code.indexOf("}, [load]);"));
  assert.match(effectBlock, /setInterval\(load, POLL_INTERVAL_MS\)/);
  assert.doesNotMatch(effectBlock, /if\s*\(\s*isTerminal/);
});
