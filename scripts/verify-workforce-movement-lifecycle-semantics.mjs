#!/usr/bin/env node
/**
 * STRICTLY READ-ONLY Production verification — resignation/transfer effective-
 * date lifecycle semantics, on REAL existing rows only (never fabricates a
 * movement). Companion to run-workforce-movement-effective-lifecycle-migration.mjs
 * (Section 6/7/8 of the mission this script serves).
 *
 * Reports aggregate counts + per-movement STRUCTURAL state only (ids, dates,
 * booleans) — never worker names/CCCD/phone.
 *
 * Cách dùng:
 *   DATABASE_URL=... node scripts/verify-workforce-movement-lifecycle-semantics.mjs
 */
import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("❌ Thiếu DATABASE_URL. KHÔNG chạy nếu không chắc chắn đây là production!");
  process.exit(1);
}

const client = new pg.Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
const today = new Date().toISOString().slice(0, 10);
console.log(`✅ Kết nối DB. today=${today}`);

console.log("\n=== PENDING resignation/transfer (status = PENDING_HR) — phải KHÔNG có hiệu lực gì ===");
const pending = await client.query(
  `SELECT id, movement_type, effective_date, confirmed_at, lifecycle_applied_at, employment_session_id
   FROM workforce_movements WHERE status = 'PENDING_HR' ORDER BY effective_date`,
);
console.log(`  count=${pending.rows.length}`);
for (const r of pending.rows) {
  console.log(`  id=${r.id} type=${r.movement_type} effective_date=${r.effective_date} confirmed_at=${r.confirmed_at} lifecycle_applied_at=${r.lifecycle_applied_at} employment_session_id=${r.employment_session_id}`);
}
const anyPendingHasEffect = pending.rows.some((r) => r.lifecycle_applied_at !== null || r.confirmed_at !== null);
console.log(`  ${anyPendingHasEffect ? "❌" : "✅"} Không dòng PENDING nào có lifecycle_applied_at/confirmed_at (chưa duyệt = chưa có hiệu lực)`);

console.log("\n=== EFFECTIVE approved resignations (status=INACTIVE, effective_date <= today) — session PHẢI không còn ACTIVE ===");
const effectiveResignations = await client.query(
  `SELECT wm.id, wm.effective_date, wm.confirmed_at, wm.lifecycle_applied_at, wm.employment_session_id,
          es.id AS session_id, es.status AS session_status, es.end_date AS session_end_date
   FROM workforce_movements wm
   LEFT JOIN employment_sessions es ON es.id = wm.employment_session_id
   WHERE wm.movement_type = 'resignation' AND wm.status = 'INACTIVE' AND wm.effective_date <= $1
   ORDER BY wm.effective_date`,
  [today],
);
console.log(`  count=${effectiveResignations.rows.length}`);
let effectiveAllEnded = true;
for (const r of effectiveResignations.rows) {
  const ended = r.session_end_date !== null;
  if (!ended) effectiveAllEnded = false;
  console.log(
    `  movement=${r.id} effective_date=${r.effective_date} confirmed_at=${r.confirmed_at} lifecycle_applied_at=${r.lifecycle_applied_at} session_id=${r.session_id} session_end_date=${r.session_end_date} ${ended ? "✅ session ended" : "❌ session still ACTIVE (end_date NULL) despite effective_date <= today"}`,
  );
}
console.log(`  ${effectiveAllEnded && effectiveResignations.rows.length > 0 ? "✅" : effectiveResignations.rows.length === 0 ? "ℹ️  NO_REAL_PRODUCTION_CASE" : "❌"} Mọi resignation ĐÃ hiệu lực đều có session end_date được set`);

console.log("\n=== FUTURE approved resignations (status=INACTIVE, effective_date > today) — worker PHẢI vẫn ACTIVE cho tới effective_date ===");
const futureResignations = await client.query(
  `SELECT wm.id, wm.effective_date, wm.confirmed_at, wm.lifecycle_applied_at, wm.employment_session_id,
          es.id AS session_id, es.status AS session_status, es.end_date AS session_end_date
   FROM workforce_movements wm
   LEFT JOIN employment_sessions es ON es.id = wm.employment_session_id
   WHERE wm.movement_type = 'resignation' AND wm.status = 'INACTIVE' AND wm.effective_date > $1
   ORDER BY wm.effective_date`,
  [today],
);
console.log(`  count=${futureResignations.rows.length}`);
for (const r of futureResignations.rows) {
  const ended = r.session_end_date !== null;
  console.log(
    `  movement=${r.id} effective_date=${r.effective_date} confirmed_at=${r.confirmed_at} lifecycle_applied_at=${r.lifecycle_applied_at} session_id=${r.session_id} session_end_date=${r.session_end_date} ${ended ? "⚠️  session ALREADY ended despite future effective_date (OLD-code artifact, pre-existing — NOT caused by this migration, which never writes to employment_sessions)" : "✅ session still ACTIVE (end_date NULL) — correct 'not yet effective' state"}`,
  );
}

console.log("\n=== Transfers (movement_type = 'transfer') — real Production cases available for each state ===");
const transferStates = await client.query(
  `SELECT status, count(*)::int AS c, count(*) FILTER (WHERE effective_date <= $1)::int AS due_or_past, count(*) FILTER (WHERE effective_date > $1)::int AS future
   FROM workforce_movements WHERE movement_type = 'transfer' GROUP BY status`,
  [today],
);
console.log(`  transfer rows by status: ${JSON.stringify(transferStates.rows)}`);
console.log(`  ${transferStates.rows.length === 0 ? "ℹ️  NO_REAL_PRODUCTION_CASE — 0 transfer movements exist in Production at all" : "ℹ️  see breakdown above"}`);

await client.end();
console.log("\n=== HOÀN TẤT — read-only, không ghi dữ liệu nào. ===");
