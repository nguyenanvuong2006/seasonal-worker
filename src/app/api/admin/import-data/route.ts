import { NextResponse } from "next/server";
import { pool } from "@/db";
import { requireRoleAndPermission, writeAudit } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * IMPORT ENGINE v2 — quy trình nhập dữ liệu chính đã chuyển sang:
 *   POST /api/admin/import-data/upload  (upload file -> nạp staging, bulk)
 *   POST /api/admin/import-data/merge   (staging -> bảng chính, theo lô, resumable)
 *   GET  /api/admin/import-data/batches (lịch sử / resume)
 * File này CHỈ còn giữ "finalize" — thống kê tổng sau khi hoàn tất 1 đợt nhập nhiều loại.
 */
export async function POST(req: Request) {
  const guard = await requireRoleAndPermission(["ADMIN"], "import.run");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const body = (await req.json()) as { type?: string };
  if (body.type !== "finalize") {
    return NextResponse.json(
      { error: "Endpoint này chỉ còn hỗ trợ type=finalize. Dùng /upload rồi /merge để nhập dữ liệu." },
      { status: 400 },
    );
  }

  const stat = await pool.query(`
    SELECT (SELECT count(*) FROM departments) d,
           (SELECT count(*) FROM dw_data) w,
           (SELECT count(*) FROM daily_applications) a
  `);
  await writeAudit(guard.session, "IMPORT_FINALIZE", "system", stat.rows[0], "IMPORT");
  return NextResponse.json({ ok: true, stats: stat.rows[0] });
}
