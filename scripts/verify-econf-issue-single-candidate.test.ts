/**
 * REGRESSION TESTS — scripts/verify-econf-issue-single-candidate.ts (2026-09).
 *
 * Locks in the safety properties: it reuses the SAME atomic CAS UPDATE the
 * real issue route uses (never a looser/different write), it refuses to run
 * against any id other than the one this mission authorized, and it never
 * touches the candidate-facing view/confirm routes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const SCRIPT_PATH = "scripts/verify-econf-issue-single-candidate.ts";

function readScript(): string {
  return readFileSync(join(ROOT, SCRIPT_PATH), "utf8");
}

function stripJsComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

test("refuses to run unless CANDIDATE_DOCUMENT_ID matches the one hardcoded, authorized id", () => {
  const code = readScript();
  assert.match(code, /EXPECTED_CANDIDATE_DOCUMENT_ID\s*=\s*"9bd3e051-c9f5-48b7-b495-dd73db8a9340"/);
  assert.match(code, /targetId\s*!==\s*EXPECTED_CANDIDATE_DOCUMENT_ID/);
  const guardIdx = code.indexOf("targetId !== EXPECTED_CANDIDATE_DOCUMENT_ID");
  const guardBlockEnd = code.indexOf("\n  }", guardIdx);
  const guardBlock = code.slice(guardIdx, guardBlockEnd);
  assert.match(guardBlock, /process\.exit\(1\)/);
});

test("uses the SAME atomic CAS WHERE clause as the real issue route — status='READY' AND pdfSha256 AND storageKey both present", () => {
  const code = readScript();
  assert.match(code, /eq\(candidateDocuments\.status,\s*"READY"\)/);
  assert.match(code, /isNotNull\(candidateDocuments\.pdfSha256\)/);
  assert.match(code, /isNotNull\(candidateDocuments\.storageKey\)/);
  assert.match(code, /status:\s*"ISSUED"/);
});

test("never touches the candidate-facing view or confirm flow — no VIEWED/CONFIRMED writes, no pdf byte streaming", () => {
  const code = stripJsComments(readScript());
  assert.doesNotMatch(code, /\bVIEWED\b/);
  assert.doesNotMatch(code, /\bCONFIRMED\b/);
  assert.doesNotMatch(code, /getStorageProvider/);
  assert.doesNotMatch(code, /confirm\/route/i);
});

test("writes the same DOCUMENT_ISSUED audit shape the real route's writeAudit() call produces", () => {
  const code = readScript();
  assert.match(code, /action:\s*"DOCUMENT_ISSUED"/);
  assert.match(code, /targetType:\s*"candidate_documents"/);
});

test("issues at most once per run — a single update(candidateDocuments) call in the whole script", () => {
  const code = readScript();
  const matches = [...code.matchAll(/\.update\(candidateDocuments\)/g)];
  assert.equal(matches.length, 1, "expected exactly one update(candidateDocuments) call");
});
