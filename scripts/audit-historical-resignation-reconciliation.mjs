#!/usr/bin/env node
/**
 * STRICTLY READ-ONLY Production audit — Phase 1 of the historical workforce
 * lifecycle data reconciliation mission (2026-09-10). Classifies every
 * resignation movement into A-E per the mission's canonical rule, using
 * ONLY structural fields (dates/status/ids) — never candidate name/CCCD/
 * phone/address. Only opaque movement/session ids and aggregate counts are
 * printed.
 *
 * Classification (applies only to APPROVED resignations, status='INACTIVE'
 * — PENDING_HR/REJECTED rows have no lifecycle effect to evaluate and are
 * reported separately as NOT_APPLICABLE):
 *   A. CORRECT_EFFECTIVE_TERMINATION — lifecycle_applied_at set ON/AFTER its
 *      own effective_date (applied at the right time), session correctly
 *      ended with end_date matching effective_date.
 *   B. HISTORICAL_EARLY_TERMINATION — lifecycle_applied_at set BEFORE its
 *      own effective_date (the pre-PR#188 old-code artifact: applied
 *      immediately at approval regardless of a future effective date).
 *   C. FUTURE_PENDING_EFFECT — lifecycle_applied_at still NULL, effective_date
 *      still in the future — correctly deferred under current code, nothing
 *      wrong.
 *   D. INCONSISTENT_STATE — anything structurally contradictory: approved +
 *      due (effective_date <= today) but never applied (lifecycle_applied_at
 *      still NULL, a stuck movement); OR employmentSessionId points at a row
 *      that doesn't exist; OR session end_date doesn't match effective_date
 *      despite timing looking correct.
 *   E. CANNOT_DETERMINE — no employmentSessionId to correlate to (pre-dates
 *      that FK) — cannot verify against employment_sessions at all.
 *
 * Cách dùng:
 *   DATABASE_URL=... node scripts/audit-historical-resignation-reconciliation.mjs
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
console.log(`✅ Kết nối DB. today=${today}\n`);

const { rows: movements } = await client.query(
  `select wm.id as movement_id, wm.status, wm.effective_date, wm.confirmed_at, wm.lifecycle_applied_at,
          wm.employment_session_id, wm.worker_id,
          es.id as session_id, es.status as session_status, es.start_date, es.end_date, es.end_reason
   from workforce_movements wm
   left join employment_sessions es on es.id = wm.employment_session_id
   where wm.movement_type = 'resignation'
   order by wm.effective_date`,
);

console.log(`TOTAL_RESIGNATIONS=${movements.length}`);

const notApplicable = movements.filter((m) => m.status !== "INACTIVE");
console.log(`NOT_APPLICABLE (status not INACTIVE — PENDING_HR/REJECTED, no lifecycle effect to evaluate)=${notApplicable.length}`);
for (const m of notApplicable) {
  console.log(`  movement=${m.movement_id} status=${m.status}`);
}

const approved = movements.filter((m) => m.status === "INACTIVE");
console.log(`\nAPPROVED (status=INACTIVE, subject to A-E classification)=${approved.length}\n`);

const buckets = { A: [], B: [], C: [], D: [], E: [] };

for (const m of approved) {
  const hasSession = m.employment_session_id !== null;
  const sessionFound = m.session_id !== null;

  if (!hasSession) {
    buckets.E.push(m);
    continue;
  }
  if (!sessionFound) {
    // employmentSessionId set but no matching row — orphaned FK, contradictory.
    buckets.D.push(m);
    continue;
  }

  const appliedDate = m.lifecycle_applied_at ? new Date(m.lifecycle_applied_at).toISOString().slice(0, 10) : null;
  const effectiveDate = new Date(m.effective_date).toISOString().slice(0, 10);
  const endDate = m.end_date ? new Date(m.end_date).toISOString().slice(0, 10) : null;

  if (appliedDate === null) {
    if (effectiveDate > today) {
      buckets.C.push(m);
    } else {
      // approved + due + never applied — stuck movement.
      buckets.D.push(m);
    }
    continue;
  }

  if (appliedDate < effectiveDate) {
    buckets.B.push(m);
    continue;
  }

  // appliedDate >= effectiveDate — applied at/after its own effective date.
  if (endDate === effectiveDate) {
    buckets.A.push(m);
  } else {
    // Timing looks right but the session's own end_date doesn't match — contradictory.
    buckets.D.push(m);
  }
}

function printBucket(label, list) {
  console.log(`${label}=${list.length}`);
  for (const m of list) {
    console.log(
      `  movement=${m.movement_id} session=${m.session_id ?? "null"} effective_date=${new Date(m.effective_date).toISOString().slice(0, 10)} confirmed_at=${m.confirmed_at ? new Date(m.confirmed_at).toISOString() : null} lifecycle_applied_at=${m.lifecycle_applied_at ? new Date(m.lifecycle_applied_at).toISOString() : null} session_status=${m.session_status ?? "null"} session_start_date=${m.start_date ? new Date(m.start_date).toISOString().slice(0, 10) : null} session_end_date=${m.end_date ? new Date(m.end_date).toISOString().slice(0, 10) : null} session_end_reason=${m.end_reason ?? "null"}`,
    );
  }
}

console.log("\n=== A. CORRECT_EFFECTIVE_TERMINATION ===");
printBucket("CORRECT_EFFECTIVE_TERMINATIONS", buckets.A);

console.log("\n=== B. HISTORICAL_EARLY_TERMINATION ===");
printBucket("HISTORICAL_EARLY_TERMINATIONS", buckets.B);

console.log("\n=== C. FUTURE_PENDING_EFFECT ===");
printBucket("FUTURE_PENDING_EFFECT", buckets.C);

console.log("\n=== D. INCONSISTENT_STATE ===");
printBucket("INCONSISTENT_STATE", buckets.D);

console.log("\n=== E. CANNOT_DETERMINE (no employmentSessionId) ===");
printBucket("CANNOT_DETERMINE", buckets.E);

console.log("\n=== Deep-dive on each HISTORICAL_EARLY_TERMINATION (bucket B) ===");
for (const m of buckets.B) {
  const effectiveDate = new Date(m.effective_date).toISOString().slice(0, 10);
  const stillFutureAsOfToday = effectiveDate > today;

  // Did the worker subsequently receive another employment_session (regDate after this
  // session's end_date, or any session with a different id at all after end_date)?
  const { rows: laterSessions } = await client.query(
    `select id, reg_date, status, end_date from employment_sessions
     where worker_id = $1 and id != $2 and reg_date > $3
     order by reg_date`,
    [m.worker_id, m.session_id, m.end_date],
  );

  // Any workforce_movements (resignation or transfer) for this worker created after the
  // early end_date — a sign of continued/downstream business activity.
  const { rows: laterMovements } = await client.query(
    `select id, movement_type, status, created_at from workforce_movements
     where worker_id = $1 and id != $2 and created_at > $3::date
     order by created_at`,
    [m.worker_id, m.movement_id, m.end_date],
  );

  // candidate_documents/document_confirmations tied to a LATER session (proves post-
  // end-date engagement activity even if no new workforce_movements row exists).
  const laterSessionIds = laterSessions.map((s) => s.id);
  let laterDocs = 0;
  if (laterSessionIds.length) {
    const { rows } = await client.query(
      `select count(*)::int as c from candidate_documents where employment_session_id = any($1::uuid[])`,
      [laterSessionIds],
    );
    laterDocs = rows[0].c;
  }

  // Overlapping-session risk: does the worker currently have ANOTHER APPROVED + end_date
  // IS NULL session? If we reopened THIS session (status back to APPROVED, end_date NULL),
  // the DB's own partial unique index (employment_session_one_active_uq) would reject it —
  // i.e., reopening is not just semantically wrong but would fail outright.
  const { rows: activeOther } = await client.query(
    `select id from employment_sessions where worker_id = $1 and id != $2 and status = 'APPROVED' and end_date is null`,
    [m.worker_id, m.session_id],
  );

  console.log(`  movement=${m.movement_id} session=${m.session_id}`);
  console.log(`    still_future_as_of_today=${stillFutureAsOfToday}`);
  console.log(`    session_currently_inactive=${m.session_status !== "APPROVED" || m.end_date !== null}`);
  console.log(`    current_end_date=${m.end_date ? new Date(m.end_date).toISOString().slice(0, 10) : null}`);
  console.log(`    subsequent_employment_sessions=${laterSessions.length}`);
  console.log(`    subsequent_workforce_movements=${laterMovements.length}`);
  console.log(`    subsequent_candidate_documents_on_later_session=${laterDocs}`);
  console.log(`    overlapping_active_session_exists=${activeOther.length > 0}`);
  console.log(`    would_reopening_create_overlap=${activeOther.length > 0}`);
}

await client.end();
console.log("\n=== HOÀN TẤT — read-only, không ghi dữ liệu nào. ===");
