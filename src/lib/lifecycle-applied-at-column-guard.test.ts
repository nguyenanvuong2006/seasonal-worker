/**
 * PRODUCTION INCIDENT REGRESSION (2026-09-10, "Lỗi tải hồ sơ") — static source
 * guard proving no live query in the affected files references
 * workforce_movements.lifecycle_applied_at.
 *
 * Root cause (proven via a read-only Production diagnostic, see
 * scripts/diagnose-worker-360-profile-endpoint-error.ts): the migration that
 * adds this column (migrations/2026-09-10-workforce-movement-effective-
 * lifecycle.sql) was written and merged but never actually applied to
 * Production — so ANY reference to the column, anywhere in a query
 * (SELECT list, WHERE, a raw SQL subquery fragment), makes the WHOLE query
 * throw with Postgres 42703 "column does not exist", not just omit a field.
 * This broke GET /api/worker-profiles/by-id/[workerId] (worker-360-profile.ts)
 * AND, independently, "Bộ phận của tôi" (workforce-roster.ts) the same way.
 *
 * The functional fix in both files works around the missing column (explicit
 * column lists / status-based predicates instead). This test is the tripwire
 * against silently reintroducing a reference to the column before the
 * migration is actually applied to Production — comments mentioning the
 * column name (documenting the incident, as directly above) are fine; only
 * code-shaped references (property/column access) are checked.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FILES = [join(HERE, "worker-360-profile.ts"), join(HERE, "workforce-roster.ts")];

/** Strip line/JSDoc comments and string-literal contents (but not template-literal
 * placeholders' own code, e.g. sql`${col}` — only the literal text around them). */
function stripCommentsAndStrings(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

test("worker-360-profile.ts and workforce-roster.ts never reference lifecycle_applied_at / lifecycleAppliedAt as a live query column outside a comment", () => {
  const offenders: { file: string; line: number; text: string }[] = [];
  for (const file of FILES) {
    const codeOnly = stripCommentsAndStrings(readFileSync(file, "utf8"));
    codeOnly.split("\n").forEach((line, i) => {
      // Allowed: the DTO field name itself (EngagementMovement.lifecycleAppliedAt,
      // WorkerCurrentState fields) and assigning it the literal `null` — never a
      // live reference to the DB column (workforceMovements.lifecycleAppliedAt /
      // raw "lifecycle_applied_at" SQL text).
      if (/workforceMovements\.lifecycleAppliedAt/.test(line) || /\blifecycle_applied_at\b/.test(line)) {
        offenders.push({ file, line: i + 1, text: line.trim() });
      }
    });
  }
  assert.deepEqual(offenders, [], `found a live reference to the not-yet-deployed lifecycle_applied_at column: ${JSON.stringify(offenders)}`);
});

test("EngagementMovement.lifecycleAppliedAt is always set to the literal null in worker-360-profile.ts (never read from a query result)", () => {
  const src = readFileSync(join(HERE, "worker-360-profile.ts"), "utf8");
  assert.match(src, /lifecycleAppliedAt:\s*null,/, "toMovement() must hardcode lifecycleAppliedAt: null until the column is deployed to Production");
});
