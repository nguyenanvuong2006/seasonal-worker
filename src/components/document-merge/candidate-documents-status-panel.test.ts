/**
 * candidate-documents-status-panel.tsx — regression tests (2026-09,
 * "Lịch sử Merge" persistent reopen feature, individual candidate PDFs).
 * No jsdom in this repo — static-source assertions, matching
 * merge-workspace.test.ts's established pattern.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SOURCE_PATH = "src/components/document-merge/candidate-documents-status-panel.tsx";

function readSource(): string {
  return readFileSync(join(ROOT, SOURCE_PATH), "utf8");
}

test("loads ALL candidate_documents from the database on every mount — no jobId/session scoping, so reopening works after reload/relogin", () => {
  const code = readSource();
  assert.match(code, /fetch\("\/api\/document-merge\/candidate-documents"/);
  assert.doesNotMatch(code, /localStorage/);
});

test("each PDF-bearing row (READY onward) gets Xem / Tải / In actions via the admin-scoped per-document pdf route", () => {
  const code = readSource();
  assert.match(code, /HAS_PDF_STATUSES/);
  assert.match(code, /\/api\/document-merge\/candidate-documents\/\$\{doc\.id\}\/pdf\?mode=view/);
  assert.match(code, /\/api\/document-merge\/candidate-documents\/\$\{doc\.id\}\/pdf\?mode=download/);
});

test("N candidates never share one PDF — each action URL is keyed by that row's OWN doc.id, never a shared/batch id", () => {
  const code = readSource();
  const pdfUrls = code.match(/\/api\/document-merge\/candidate-documents\/\$\{doc\.id\}\/pdf/g) ?? [];
  // At least the 3 (Xem/Tải/In) row-level links, each templated on doc.id.
  assert.ok(pdfUrls.length >= 3, "expected at least 3 per-row PDF links keyed by doc.id");
});

test("HAS_PDF_STATUSES includes READY (staff can preview before issuing) but excludes GENERATING/FAILED (no PDF exists yet)", () => {
  const code = readSource();
  const match = code.match(/const HAS_PDF_STATUSES = new Set\(\[([^\]]+)\]\);/);
  assert.ok(match, "HAS_PDF_STATUSES set not found");
  const statuses = match![1];
  assert.match(statuses, /"READY"/);
  assert.doesNotMatch(statuses, /"GENERATING"/);
  assert.doesNotMatch(statuses, /"FAILED"/);
});
