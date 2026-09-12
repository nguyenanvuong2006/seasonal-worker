/**
 * BOOTSTRAP CONTENT GUARD — tests proving the ledger bootstrap's
 * governance-only content check catches every forbidden pattern and
 * requires every expected structural piece, and that the REAL
 * migrations/2026-09-12-schema-migrations-ledger.sql file passes it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkBootstrapContentAllowed } from "./bootstrap-content-guard.mjs";
import { LEDGER_BOOTSTRAP_MIGRATION_ID } from "./migration-ledger.mjs";

const VALID_SQL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  migration_id text PRIMARY KEY,
  checksum_sha256 text NOT NULL
);
CREATE INDEX IF NOT EXISTS schema_migrations_applied_at_idx ON schema_migrations (applied_at);`;

test("checkBootstrapContentAllowed: the REAL migrations/2026-09-12-schema-migrations-ledger.sql file passes", () => {
  const sqlText = readFileSync(`migrations/${LEDGER_BOOTSTRAP_MIGRATION_ID}`, "utf8");
  const result = checkBootstrapContentAllowed(sqlText);
  assert.deepEqual(result, { ok: true, reason: null });
});

test("checkBootstrapContentAllowed: a minimal synthetic governance-only SQL passes", () => {
  assert.deepEqual(checkBootstrapContentAllowed(VALID_SQL), { ok: true, reason: null });
});

const FORBIDDEN_EXAMPLES: [string, string][] = [
  ["DROP TABLE", `${VALID_SQL}\nDROP TABLE users;`],
  ["DELETE FROM", `${VALID_SQL}\nDELETE FROM users;`],
  ["TRUNCATE", `${VALID_SQL}\nTRUNCATE users;`],
  ["UPDATE ... SET", `${VALID_SQL}\nUPDATE users SET is_active = false;`],
  ["INSERT INTO", `${VALID_SQL}\nINSERT INTO users (id) VALUES (1);`],
  ["ALTER TABLE (business table)", `${VALID_SQL}\nALTER TABLE users ADD COLUMN foo text;`],
  ["DROP INDEX", `${VALID_SQL}\nDROP INDEX users_email_idx;`],
  ["GRANT", `${VALID_SQL}\nGRANT ALL ON users TO someone;`],
  ["REVOKE", `${VALID_SQL}\nREVOKE ALL ON users FROM someone;`],
];

for (const [label, sql] of FORBIDDEN_EXAMPLES) {
  test(`checkBootstrapContentAllowed: rejects ${label}`, () => {
    const result = checkBootstrapContentAllowed(sql);
    assert.equal(result.ok, false, `expected ${label} to be rejected`);
    assert.ok(result.reason, "must name a reason");
  });
}

const COMMENT_BYPASS_EXAMPLES: [string, string][] = [
  ["DROP/**/TABLE (empty block comment splitting the keywords)", `${VALID_SQL}\nDROP/**/TABLE users;`],
  ["UPDATE/**/... SET (empty block comment)", `${VALID_SQL}\nUPDATE/**/users SET is_active=false;`],
  ["DELETE/**/FROM (empty block comment)", `${VALID_SQL}\nDELETE/**/FROM users;`],
  ["DROP  -- comment\\n  TABLE (line comment splitting the keywords across a newline)", `${VALID_SQL}\nDROP  -- sneaky\n  TABLE users;`],
  ["multi-line block comment splitting INSERT INTO", `${VALID_SQL}\nINSERT/*\nmulti\nline\n*/INTO users (id) VALUES (1);`],
];

for (const [label, sql] of COMMENT_BYPASS_EXAMPLES) {
  test(`checkBootstrapContentAllowed: rejects comment-obfuscated forbidden statement — ${label}`, () => {
    const result = checkBootstrapContentAllowed(sql);
    assert.equal(result.ok, false, `expected comment-obfuscated statement to still be rejected: ${label}`);
    assert.ok(result.reason, "must name a reason");
  });
}

test("checkBootstrapContentAllowed: ALTER TABLE on schema_migrations itself is allowed (the one exempted table)", () => {
  const sql = `${VALID_SQL}\nALTER TABLE schema_migrations ADD COLUMN extra text;`;
  assert.deepEqual(checkBootstrapContentAllowed(sql), { ok: true, reason: null });
});

test("checkBootstrapContentAllowed: rejects missing CREATE TABLE schema_migrations", () => {
  const sql = `CREATE INDEX IF NOT EXISTS schema_migrations_applied_at_idx ON schema_migrations (applied_at);`;
  const result = checkBootstrapContentAllowed(sql);
  assert.equal(result.ok, false);
});

test("checkBootstrapContentAllowed: rejects missing CREATE INDEX schema_migrations_applied_at_idx", () => {
  const sql = `CREATE TABLE IF NOT EXISTS schema_migrations (migration_id text PRIMARY KEY);`;
  const result = checkBootstrapContentAllowed(sql);
  assert.equal(result.ok, false);
});

test("LEDGER_BOOTSTRAP_MIGRATION_ID is the exact fixed filename the bootstrap script hardcodes", () => {
  assert.equal(LEDGER_BOOTSTRAP_MIGRATION_ID, "2026-09-12-schema-migrations-ledger.sql");
});
