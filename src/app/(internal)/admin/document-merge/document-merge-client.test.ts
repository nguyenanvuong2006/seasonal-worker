/**
 * document-merge-client.tsx — "Lịch sử Merge" reopen regression tests
 * (2026-09). No jsdom in this repo — static-source assertions against the
 * real component source, matching merge-workspace.test.ts's established
 * pattern.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SOURCE_PATH = "src/app/(internal)/admin/document-merge/document-merge-client.tsx";

function readSource(): string {
  return readFileSync(join(ROOT, SOURCE_PATH), "utf8");
}

test("HistoryTab reopens every job by its persistent database jobId — JobProgressPanel keyed on job.id, not transient merge-action state", () => {
  const code = readSource();
  assert.match(code, /<JobProgressPanel\s+jobId=\{job\.id\}/);
});

test("reopen label reflects job status: PROCESSING -> Xem tiến độ, terminal -> Xem kết quả, FAILED -> Xem lỗi", () => {
  const code = readSource();
  assert.match(code, /function reopenLabel/);
  assert.match(code, /"FAILED"\)\s*return\s*"Xem lỗi"/);
  assert.match(code, /"Xem kết quả"/);
  assert.match(code, /"Xem tiến độ"/);
});

test("history list shows completed/expected output counts per row (e.g. completedRecords/recordCount)", () => {
  const code = readSource();
  assert.match(code, /job\.completedRecords/);
  assert.match(code, /job\.recordCount/);
  assert.match(code, /hồ sơ hoàn tất/);
});

test("history list reads from GET /api/document-merge/history (database-backed) — never from localStorage", () => {
  const code = readSource();
  assert.match(code, /fetch\("\/api\/document-merge\/history"/);
  assert.doesNotMatch(code, /localStorage/);
});

test("CandidateDocumentsStatusPanel (individual candidate documents reopen) is reachable from Lịch sử Merge, not only the Merge tab", () => {
  const code = readSource();
  const historyTabStart = code.indexOf("function HistoryTab");
  const historyTabBody = code.slice(historyTabStart, code.indexOf("\nfunction FieldsTab"));
  assert.match(historyTabBody, /<CandidateDocumentsStatusPanel\s*\/>/);
});

test("delete clears any open reopened job for that id — no orphaned panel referencing a deleted job", () => {
  const code = readSource();
  assert.match(code, /if \(openJobId === jobId\) setOpenJobId\(null\)/);
});
