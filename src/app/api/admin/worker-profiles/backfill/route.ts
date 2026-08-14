import { NextResponse } from "next/server";
import { isNull } from "drizzle-orm";
import { db, pool } from "@/db";
import { dailyApplications, dwData } from "@/db/schema";
import { requirePermission, writeAudit } from "@/lib/auth";
import { isValidCccd, normalizeCccd } from "@/lib/validators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * DIGITAL WORKER FILE (#10) — đồng bộ dữ liệu CŨ (đã có trước khi tính năng này ra đời)
 * vào mô hình worker_profiles/employment_sessions. An toàn chạy lại nhiều lần (idempotent):
 * dùng ON CONFLICT nên không tạo trùng. KHÔNG đổi/xoá bất kỳ dữ liệu daily_applications/dw_data
 * nào — chỉ đọc và tổng hợp thêm.
 */
export async function POST() {
  const guard = await requirePermission(["ADMIN"], "worker_profile.edit");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const client = await pool.connect();
  try {
    // 1) Từ DW Data — mỗi CCCD tạo/khớp 1 worker_profiles.
    const dwRows = await db.select().from(dwData).where(isNull(dwData.deletedAt));
    let profilesFromDw = 0;
    for (const w of dwRows) {
      if (!isValidCccd(w.cccd) || w.cccd !== normalizeCccd(w.cccd)) continue;
      const cccd = normalizeCccd(w.cccd);
      const res = await client.query(
        `INSERT INTO worker_profiles (cccd, full_name, gender, dob, phone, permanent_address, residential_address, dw_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (cccd) WHERE deleted_at IS NULL DO UPDATE SET dw_id = EXCLUDED.dw_id
         RETURNING id`,
        [cccd, w.fullName, w.gender, w.bod, w.phone, w.permanentAddress, w.residentialAddress, w.id],
      );
      if (res.rowCount) profilesFromDw++;
    }

    // 2) Từ Daily Application — tạo/khớp worker_profiles + 1 employment_session cho mỗi đơn.
    const appRows = await db.select().from(dailyApplications).where(isNull(dailyApplications.deletedAt));
    let profilesFromApps = 0;
    let sessionsCreated = 0;
    for (const a of appRows) {
      if (!isValidCccd(a.cccd) || a.cccd !== normalizeCccd(a.cccd)) continue;
      const cccd = normalizeCccd(a.cccd);
      const pRes = await client.query(
        `INSERT INTO worker_profiles (cccd, full_name, gender, dob, phone, permanent_address, residential_address, dw_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (cccd) WHERE deleted_at IS NULL DO UPDATE SET updated_at = now()
         RETURNING id`,
        [cccd, a.fullName, a.gender, a.dob, a.phone, a.permanentAddress, a.residentialAddress, a.dwId],
      );
      const profileId = pRes.rows[0]?.id;
      if (!profileId) continue;
      profilesFromApps++;

      const sRes = await client.query(
        `INSERT INTO employment_sessions (worker_id, daily_application_id, dept_id, reg_date, status, starting_date)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (daily_application_id) WHERE daily_application_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [profileId, a.id, a.deptId, a.regDate, a.status, a.startingDate],
      );
      if (sRes.rowCount) sessionsCreated++;
    }

    const stats = { profilesFromDw, profilesFromApps, sessionsCreated, totalDwRows: dwRows.length, totalAppRows: appRows.length };
    await writeAudit(guard.session, "BACKFILL_WORKER_PROFILES", "worker_profiles", stats, "SYSTEM");
    return NextResponse.json({ success: true, ...stats });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Lỗi không xác định" }, { status: 500 });
  } finally {
    client.release();
  }
}

export async function GET() {
  const guard = await requirePermission(["ADMIN"], "worker_profile.edit");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const client = await pool.connect();
  try {
    const profiles = await client.query(`SELECT count(*)::int c FROM worker_profiles WHERE deleted_at IS NULL`);
    const sessions = await client.query(`SELECT count(*)::int c FROM employment_sessions`);
    return NextResponse.json({ profiles: profiles.rows[0].c, sessions: sessions.rows[0].c });
  } finally {
    client.release();
  }
}
