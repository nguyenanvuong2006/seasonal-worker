/**
 * POST /api/document-merge/verification/check-db
 * Kiểm tra kết nối Neon + các bảng merge tồn tại.
 * Chỉ ADMIN + non-production (VERIFICATION_ENABLED=true).
 */

import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { requirePermission } from "@/lib/auth";
import { db } from "@/db";
import { isVerificationEnabled } from "@/lib/verification/helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const guard = await requirePermission(["ADMIN"], "document_merge.history.view");
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  if (!isVerificationEnabled()) {
    return NextResponse.json({ error: "Verification chỉ khả dụng ở non-production." }, { status: 403 });
  }

  const startedAt = Date.now();
  try {
    const pingResult = await db.execute(sql`SELECT 1 AS ok`);
    const countsResult = await db.execute(sql`
      SELECT
        (SELECT count(*) FROM merge_templates) AS templates,
        (SELECT count(*) FROM merge_template_fields WHERE is_orphaned = false) AS fields,
        (SELECT count(*) FROM merge_template_versions WHERE status = 'PUBLISHED') AS published_versions,
        (SELECT count(*) FROM merge_jobs) AS jobs,
        (SELECT count(*) FROM document_history) AS history
    `);
    const ping = pingResult.rows?.[0];
    const counts = countsResult.rows?.[0];
    return NextResponse.json({
      pass: true,
      stage: "DATABASE",
      ping: Boolean(ping && (ping as Record<string, unknown>).ok),
      counts,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    return NextResponse.json(
      {
        pass: false,
        stage: "DATABASE",
        error: error instanceof Error ? error.message.slice(0, 300) : String(error),
        durationMs: Date.now() - startedAt,
      },
      { status: 200 },
    );
  }
}
