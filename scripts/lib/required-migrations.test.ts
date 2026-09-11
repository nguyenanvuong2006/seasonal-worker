/**
 * REQUIRED-MIGRATION CONTRACT — tests proving checkRequiredMigrationEvidence
 * correctly aggregates per-migration probe results (Mission B section 17/18).
 * Uses a hand-rolled fake client keyed by exact query text, not a real DB.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { REQUIRED_MIGRATIONS, checkRequiredMigrationEvidence } from "./required-migrations.mjs";

type FakeQueryHandler = (params: unknown[]) => { rows: Record<string, unknown>[]; rowCount: number };

/** A fake client that answers every probe as "object exists" or "absent" based on a caller-supplied predicate over (text, params). */
function makeFakeClient(exists: (text: string, params: unknown[]) => boolean) {
  return {
    async query(text: string, params: unknown[] = []) {
      const ok = exists(text, params);
      return ok ? { rows: [{}], rowCount: 1 } : { rows: [], rowCount: 0 };
    },
  };
}

test("REQUIRED_MIGRATIONS: registry covers the five migrations Mission B section 17 explicitly requires", () => {
  const ids = REQUIRED_MIGRATIONS.map((m) => m.migrationId);
  assert.ok(ids.includes("2026-09-09-ai-action-proposals.sql"));
  assert.ok(ids.includes("2026-09-10-ai-copilot-conversations.sql"));
  assert.ok(ids.includes("2026-09-10-electronic-confirmation-deadline-engagement.sql"));
  assert.ok(ids.includes("2026-09-10-workforce-movement-effective-lifecycle.sql"));
  assert.ok(ids.includes("2026-09-09-recruitment-requests-snapshot-columns-only.sql"));
});

test("checkRequiredMigrationEvidence: everything present -> allPresent true for every migration", async () => {
  const client = makeFakeClient(() => true);
  const results = await checkRequiredMigrationEvidence(client);
  assert.equal(results.length, REQUIRED_MIGRATIONS.length);
  for (const r of results) {
    assert.equal(r.allPresent, true, `expected ${r.migrationId} to report allPresent=true`);
    assert.ok(r.checks.every((c) => c.ok));
  }
});

test("checkRequiredMigrationEvidence: nothing present -> allPresent false, every check reported not-ok (never silently skipped)", async () => {
  const client = makeFakeClient(() => false);
  const results = await checkRequiredMigrationEvidence(client);
  for (const r of results) {
    assert.equal(r.allPresent, false, `expected ${r.migrationId} to report allPresent=false`);
    assert.ok(r.checks.length > 0, "every required migration must have at least one probe");
    assert.ok(r.checks.every((c) => c.ok === false));
  }
});

test("checkRequiredMigrationEvidence: partial evidence (one missing column) surfaces as allPresent=false for that migration, others unaffected", async () => {
  // Everything exists EXCEPT candidate_documents.confirmation_deadline_at.
  const client = makeFakeClient((text, params) => {
    if (/information_schema\.columns/i.test(text) && params[1] === "confirmation_deadline_at") return false;
    return true;
  });
  const results = await checkRequiredMigrationEvidence(client);
  const ec = results.find((r) => r.migrationId === "2026-09-10-electronic-confirmation-deadline-engagement.sql")!;
  assert.equal(ec.allPresent, false);
  const failing = ec.checks.filter((c) => !c.ok);
  assert.deepEqual(
    failing.map((c) => c.label),
    ["column:candidate_documents.confirmation_deadline_at"],
  );

  const others = results.filter((r) => r.migrationId !== ec.migrationId);
  assert.ok(others.every((r) => r.allPresent), "an unrelated migration's evidence must not be affected by another migration's missing column");
});
