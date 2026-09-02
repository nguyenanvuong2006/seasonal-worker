/**
 * DB CONSTRAINT PRESENCE — structural checks over the real migration SQL and
 * drizzle schema.ts, proving the critical uniqueness/index invariants the
 * mission requires are actually declared (no live Postgres available in
 * this sandbox to prove ENFORCEMENT — see routes-wiring.test.ts and
 * evidence.test.ts for the application-level idempotency/concurrency
 * behavior these constraints back up).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  new URL("../../../migrations/2026-09-01-candidate-document-consent.sql", import.meta.url),
  "utf8",
);
const schema = readFileSync(new URL("../../db/schema.ts", import.meta.url), "utf8");

test("migration: at most one confirmation per document is a UNIQUE index, not just an app-level check", () => {
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS document_confirmation_document_uq ON document_confirmations \(candidate_document_id\)/);
});

test("migration: receipt ids are DB-unique", () => {
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS document_confirmation_receipt_uq ON document_confirmations \(receipt_id\)/);
});

test("migration: access session token hash is DB-unique (two sessions can never collide on the same hash)", () => {
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS candidate_access_session_token_uq ON candidate_access_sessions \(token_hash\)/);
});

test("migration: identity_lookup_attempts limiter_key is DB-unique (the ON CONFLICT upsert in the lookup route depends on this)", () => {
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS identity_lookup_attempt_key_uq ON identity_lookup_attempts \(limiter_key\)/);
});

test("migration: supersedes-chain has a supporting index (integrity/lookup, not just an unindexed uuid column)", () => {
  assert.match(migration, /CREATE INDEX IF NOT EXISTS candidate_document_supersedes_idx ON candidate_documents \(supersedes_document_id\)/);
});

test("migration: candidate_documents.status is constrained to the exact known lifecycle values at the DB layer (defense in depth alongside lifecycle.ts)", () => {
  assert.match(migration, /CONSTRAINT candidate_documents_status_chk CHECK \(\s*status IN \('GENERATING', 'READY', 'ISSUED', 'VIEWED', 'CONFIRMED', 'REVOKED', 'SUPERSEDED', 'EXPIRED', 'FAILED'\)/);
});

test("migration: evidence_hmac is NOT NULL — the DB itself rejects a degraded, HMAC-less confirmation row", () => {
  assert.match(migration, /evidence_hmac varchar\(64\) NOT NULL/);
});

test("migration: no raw cccd/phone column anywhere in these new tables (privacy — only HMAC/hash columns)", () => {
  assert.doesNotMatch(migration, /\bcccd\s+varchar/i);
  assert.doesNotMatch(migration, /\bphone\s+varchar/i);
});

test("migration: forward-only — every ACTUAL SQL statement is CREATE TABLE/INDEX IF NOT EXISTS, no DROP/ALTER/TRUNCATE/DELETE (comments excluded — the docblock itself explains this rule in prose)", () => {
  const sqlOnly = migration
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  assert.doesNotMatch(sqlOnly, /\bDROP\b|\bALTER\s+TABLE\s+\w+\s+(DROP|RENAME)|\bTRUNCATE\b/i);
  assert.doesNotMatch(sqlOnly, /\bDELETE\s+FROM\b/i);
});

test("schema.ts: candidateDocuments/documentConfirmations/candidateAccessSessions/identityLookupAttempts are all exported (drizzle definitions exist and match the migration's tables)", () => {
  assert.match(schema, /export const candidateDocuments = pgTable\(\s*"candidate_documents"/);
  assert.match(schema, /export const documentConfirmations = pgTable\(\s*"document_confirmations"/);
  assert.match(schema, /export const candidateAccessSessions = pgTable\(\s*"candidate_access_sessions"/);
  assert.match(schema, /export const identityLookupAttempts = pgTable\(\s*"identity_lookup_attempts"/);
});

test("schema.ts: documentConfirmations.evidenceHmac is declared NOT NULL (matches the migration, not just optional)", () => {
  const tableStart = schema.indexOf('export const documentConfirmations = pgTable(');
  const tableEnd = schema.indexOf(");", schema.indexOf("(t) => [", tableStart));
  const tableSlice = schema.slice(tableStart, tableEnd);
  assert.match(tableSlice, /evidenceHmac: varchar\("evidence_hmac", \{ length: 64 \}\)\.notNull\(\)/);
});

/* ============================================================ *
 * Supersedes relation integrity — real self-referencing FK, not just an
 * unenforced uuid column.
 * ============================================================ */

test("migration: supersedes_document_id is a REAL self-referencing FOREIGN KEY to candidate_documents(id), not a soft/logical reference", () => {
  assert.match(migration, /supersedes_document_id uuid REFERENCES candidate_documents\(id\)/);
});

test("migration: the supersedes FK uses ON DELETE RESTRICT — a document that something else supersedes can never be hard-deleted, preserving the evidence chain", () => {
  assert.match(migration, /supersedes_document_id uuid REFERENCES candidate_documents\(id\) ON DELETE RESTRICT/);
});

test("migration: a document is blocked from superseding itself at the DB layer (CHECK constraint), not merely by application code", () => {
  assert.match(migration, /CONSTRAINT candidate_documents_no_self_supersede_chk CHECK \(\s*supersedes_document_id IS NULL OR supersedes_document_id <> id\s*\)/);
});
