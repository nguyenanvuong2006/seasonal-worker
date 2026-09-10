#!/usr/bin/env node
/**
 * STRICTLY READ-ONLY Production audit — Phase 9 of the Daily Operations UX
 * mission. Investigates why "Nhập mã công nhật" / "IT Code / Vân tay" /
 * "Báo cơm" show zero records for 2026-09-10.
 *
 * Key hypothesis being tested: all three routes currently filter by
 * daily_applications.reg_date = <selected date> (the REGISTRATION date),
 * but their own code comments describe the intended semantics as "đã nhập
 * DW Data trong ngày đang chọn" (imported into DW Data ON the selected
 * day) — those are two different dates whenever DW-import happens on a
 * later day than registration. This script checks BOTH interpretations
 * against real Production data to see which one is empty and which one
 * (if either) actually has rows for 2026-09-10, without ever writing
 * anything.
 *
 * Only aggregate counts and opaque ids are printed — no names/CCCD/phone.
 *
 * Cách dùng:
 *   DATABASE_URL=... node scripts/audit-daily-operations-zero-data.mjs
 */
import pg from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("❌ Thiếu DATABASE_URL. KHÔNG chạy nếu không chắc chắn đây là production!");
  process.exit(1);
}

const client = new pg.Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
const TARGET_DATE = "2026-09-10";
console.log(`✅ Kết nối DB. TARGET_DATE=${TARGET_DATE}\n`);

console.log("=== 0) daily_applications overall shape (no date filter) ===");
const { rows: overall } = await client.query(
  `select count(*)::int as total,
          count(*) filter (where deleted_at is null)::int as not_deleted,
          count(*) filter (where deleted_at is null and dw_imported_at is not null)::int as dw_imported,
          min(reg_date)::text as min_reg_date, max(reg_date)::text as max_reg_date,
          min(dw_imported_at)::text as min_dw_imported_at, max(dw_imported_at)::text as max_dw_imported_at
   from daily_applications`,
);
console.log(`  total=${overall[0].total} not_deleted=${overall[0].not_deleted} dw_imported=${overall[0].dw_imported}`);
console.log(`  reg_date range: ${overall[0].min_reg_date} .. ${overall[0].max_reg_date}`);
console.log(`  dw_imported_at range: ${overall[0].min_dw_imported_at} .. ${overall[0].max_dw_imported_at}`);

console.log(`\n=== 1) Current query semantics: reg_date = '${TARGET_DATE}' (what the 3 routes actually filter by) ===`);
const { rows: byRegDate } = await client.query(
  `select count(*)::int as c,
          count(*) filter (where dw_imported_at is not null)::int as dw_imported,
          count(*) filter (where deleted_at is not null)::int as soft_deleted
   from daily_applications where reg_date = $1`,
  [TARGET_DATE],
);
console.log(`  DAILY_APPLICATIONS_FOR_DATE (reg_date)=${byRegDate[0].c} (dw_imported=${byRegDate[0].dw_imported}, soft_deleted=${byRegDate[0].soft_deleted})`);

console.log(`\n=== 2) Alternate hypothesis: DATE(dw_imported_at) = '${TARGET_DATE}' (matches the routes' OWN code comments — "imported ON the selected day") ===`);
const { rows: byDwImportDate } = await client.query(
  `select count(*)::int as c
   from daily_applications
   where deleted_at is null and dw_imported_at is not null and dw_imported_at::date = $1`,
  [TARGET_DATE],
);
console.log(`  DW_DATA_FOR_DATE (by dw_imported_at::date)=${byDwImportDate[0].c}`);

console.log(`\n=== 3) Cross-check: for rows with reg_date = target date, what IS their dw_imported_at date (if any)? ===`);
const { rows: crossCheck } = await client.query(
  `select dw_imported_at::date::text as import_date, count(*)::int as c
   from daily_applications where reg_date = $1 and deleted_at is null
   group by dw_imported_at::date
   order by import_date nulls first`,
  [TARGET_DATE],
);
for (const r of crossCheck) console.log(`  import_date=${r.import_date ?? "NULL"} count=${r.c}`);

console.log(`\n=== 4) Cross-check: for rows dw_imported_at::date = target date, what IS their reg_date? ===`);
const { rows: crossCheck2 } = await client.query(
  `select reg_date::text as reg_date, count(*)::int as c
   from daily_applications
   where deleted_at is null and dw_imported_at is not null and dw_imported_at::date = $1
   group by reg_date
   order by reg_date`,
  [TARGET_DATE],
);
for (const r of crossCheck2) console.log(`  reg_date=${r.reg_date} count=${r.c}`);

console.log(`\n=== 5) Recent daily_applications activity (last 10 distinct reg_date values with counts) — sanity check the system isn't globally idle ===`);
const { rows: recent } = await client.query(
  `select reg_date::text as reg_date, count(*)::int as c, count(*) filter (where dw_imported_at is not null)::int as dw_imported
   from daily_applications where deleted_at is null
   group by reg_date order by reg_date desc limit 10`,
);
for (const r of recent) console.log(`  reg_date=${r.reg_date} total=${r.c} dw_imported=${r.dw_imported}`);

console.log(`\n=== 6) WORKERS_WITH_TIMECODE / WORKERS_WITH_IT_CODE / MEAL_ELIGIBLE — using CURRENT route semantics (reg_date = target), joined to dw_data ===`);
const { rows: eligibility } = await client.query(
  `select
     count(*)::int as dw_imported_rows,
     count(*) filter (where dw.code is not null and length(trim(dw.code)) > 0)::int as workers_with_timecode,
     count(*) filter (where dw.it_code is not null and length(trim(dw.it_code)) > 0)::int as workers_with_it_code,
     count(*) filter (where dw.code is not null and length(trim(dw.code)) > 0)::int as meal_eligible
   from daily_applications da
   join dw_data dw on dw.id = da.dw_id
   where da.reg_date = $1 and da.deleted_at is null and da.dw_imported_at is not null`,
  [TARGET_DATE],
);
console.log(`  (reg_date semantics) dw_imported_rows=${eligibility[0].dw_imported_rows} WORKERS_WITH_TIMECODE=${eligibility[0].workers_with_timecode} WORKERS_WITH_IT_CODE=${eligibility[0].workers_with_it_code} MEAL_ELIGIBLE=${eligibility[0].meal_eligible}`);

console.log(`\n=== 7) Same, using ALTERNATE (dw_imported_at::date = target) semantics ===`);
const { rows: eligibilityAlt } = await client.query(
  `select
     count(*)::int as dw_imported_rows,
     count(*) filter (where dw.code is not null and length(trim(dw.code)) > 0)::int as workers_with_timecode,
     count(*) filter (where dw.it_code is not null and length(trim(dw.it_code)) > 0)::int as workers_with_it_code,
     count(*) filter (where dw.code is not null and length(trim(dw.code)) > 0)::int as meal_eligible
   from daily_applications da
   join dw_data dw on dw.id = da.dw_id
   where da.deleted_at is null and da.dw_imported_at is not null and da.dw_imported_at::date = $1`,
  [TARGET_DATE],
);
console.log(`  (dw_imported_at semantics) dw_imported_rows=${eligibilityAlt[0].dw_imported_rows} WORKERS_WITH_TIMECODE=${eligibilityAlt[0].workers_with_timecode} WORKERS_WITH_IT_CODE=${eligibilityAlt[0].workers_with_it_code} MEAL_ELIGIBLE=${eligibilityAlt[0].meal_eligible}`);

await client.end();
console.log("\n=== HOÀN TẤT — read-only, không ghi dữ liệu nào. ===");
