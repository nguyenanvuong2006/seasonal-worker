/**
 * STRICTLY READ-ONLY Production diagnostic — reproduces the "Lỗi tải hồ sơ"
 * incident reported right after the Worker 360° Profile deploy (PR #189).
 *
 * Unlike scripts/worker-360-profile-production-diagnostic.ts (which only runs
 * raw aggregate COUNT queries and never actually calls the failing code
 * path), THIS script imports and calls the REAL getWorker360Profile()
 * service — the exact function GET /api/worker-profiles/by-id/[workerId]
 * calls — against real Production workerIds, with GLOBAL scope (null,
 * simulating ADMIN) so a scope-narrowing false negative can't mask a real
 * crash. Any thrown error is caught and its name/message/stack printed
 * (Postgres errors here are always column/table/type diagnostics, never
 * literal parameter values — drizzle uses parameterized queries) so the
 * exact SQL/runtime failure is visible without needing Production logs.
 *
 * ZERO writes: only SELECTs (via the real service, which itself never
 * writes — see read-only-audit.test.ts's structural proof for the module).
 * Never logs CCCD/phone/address/tokens/DATABASE_URL — only workerId
 * (opaque operational identifier, same convention as every other
 * diagnose-*.ts script in this repo) and structural counts/error text.
 *
 * Cách dùng (LƯU Ý --conditions=react-server — getWorker360Profile() imports
 * "server-only", whose package.json only picks the safe no-op export under
 * that condition; Next.js's own bundler sets this automatically for the
 * server build, a plain `node --import tsx` does not, and without it every
 * call below would fail with server-only's own throw — a FALSE POSITIVE
 * unrelated to the real Production incident):
 *   DATABASE_URL=... node --conditions=react-server --import tsx scripts/diagnose-worker-360-profile-endpoint-error.ts
 */
import { desc, sql } from "drizzle-orm";
import { db, pool } from "../src/db/index.ts";
import { employmentSessions } from "../src/db/schema.ts";
import { getWorker360Profile } from "../src/lib/worker-360-profile.ts";

function log(event: string, data: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...data }));
}

/** Drizzle wraps the real Postgres error as `.cause` — the wrapper's own
 * `.message` is just "Failed query: <sql>", never the actual DB reason
 * (e.g. "column X does not exist"). Walk the full cause chain so the real
 * reason is never lost. */
function describeError(error: unknown): { name: string | null; code: string | null; message: string | null; causeChain: string[] } {
  const causeChain: string[] = [];
  let cur: unknown = error;
  let depth = 0;
  while (cur && typeof cur === "object" && depth < 5) {
    const e = cur as { message?: string; code?: string; cause?: unknown };
    causeChain.push(`${e.code ? `[${e.code}] ` : ""}${e.message ?? String(cur)}`.slice(0, 300));
    cur = e.cause;
    depth += 1;
  }
  const top = error as { name?: string; message?: string; code?: string };
  return { name: top.name ?? null, code: top.code ?? null, message: top.message ? top.message.slice(0, 300) : null, causeChain };
}

async function tryProfile(label: string, workerId: string) {
  try {
    const profile = await getWorker360Profile(workerId, null);
    log("PROFILE_OK", {
      label,
      found: !!profile,
      engagementCount: profile?.engagements.length ?? null,
      legacyUnlinkedDocumentCount: profile?.legacyUnlinkedDocuments.length ?? null,
      unlinkedMovementCount: profile?.unlinkedMovements.length ?? null,
    });
  } catch (error) {
    log("PROFILE_ERROR", { label, ...describeError(error) });
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("❌ Thiếu DATABASE_URL. KHÔNG chạy nếu không chắc chắn đây là production!");
    process.exit(1);
  }

  // Ground truth: the ACTUAL columns Production's workforce_movements table
  // has right now, vs. what schema.ts declares — a mismatch here (a column
  // schema.ts expects that Production doesn't have yet, or a type drift)
  // is the leading suspect for a "select *"-shaped query failing universally.
  const actualColumns = await db.execute(
    sql`select column_name, data_type from information_schema.columns where table_name = 'workforce_movements' order by ordinal_position`,
  );
  log("WORKFORCE_MOVEMENTS_ACTUAL_COLUMNS", { columns: actualColumns.rows.map((r) => `${r.column_name}:${r.data_type}`) });

  // A worker with the MOST sessions (multi-engagement — the exact case this
  // mission's "returning worker" invariant is about) and, separately, a
  // worker with exactly one session — covers both shapes the real page hits.
  const grouped = await db
    .select({ workerId: employmentSessions.workerId, sessionCount: sql<number>`count(*)::int` })
    .from(employmentSessions)
    .groupBy(employmentSessions.workerId)
    .orderBy(desc(sql`count(*)`))
    .limit(1);

  const [singleSession] = await db.select({ workerId: employmentSessions.workerId }).from(employmentSessions).orderBy(employmentSessions.id).limit(1);

  if (grouped.length) await tryProfile("most-sessions", grouped[0].workerId);
  if (singleSession && singleSession.workerId !== grouped[0]?.workerId) await tryProfile("first-by-id", singleSession.workerId);

  // A workerId that does NOT exist (valid UUID shape, no row) — must resolve
  // to profile:null, never throw.
  await tryProfile("nonexistent", "00000000-0000-0000-0000-000000000000");

  log("diagnostic_complete", { note: "Read-only — zero rows written or modified." });
  await pool.end();
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ event: "fatal_error", error: message.slice(0, 500) }));
  process.exit(1);
});
