/* ============================================================
   /api/recruitment-requests/facets — Distinct values cho filter dropdown
   ------------------------------------------------------------
   Trước đây (PHASE 5 audit bug) UI gọi `?limit=5000` để dựng dropdown
   filter. Server cap 1000 → facet bị rỗng → user chọn filter nhưng
   kết quả rỗng vì filter không có trong 1000 bản ghi đầu.

   Endpoint này CHỈ trả distinct values cho các cột filter, KHÔNG load rows.
   - Query: `SELECT DISTINCT col` (set-based, không N+1).
   - Bỏ qua giá trị rỗng.
   - Tối đa 200 giá trị / cột (chống cardinality nổ).
   - Data Scope áp dụng giống list endpoint.
   ============================================================ */

import { NextResponse } from "next/server";
import { isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { recruitmentRequests } from "@/db/schema";
import { getUserScope, requirePermission } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FACET_COLUMNS = [
  "month",
  "location",
  "division",
  "department",
  "section",
  "group_name",
  "requester",
  "reason",
  "status",
] as const;

const MAX_VALUES_PER_FACET = 200;

export async function GET() {
  const guard = await requirePermission(
    ["ADMIN", "HR_RECRUITER", "DEPT_MANAGER", "HR_DIRECTOR"],
    "planning.view",
  );
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const scope = await getUserScope(guard.session);

  try {
    const result: Record<string, string[]> = {};
    for (const col of FACET_COLUMNS) {
      // Drizzle chưa có API generic typed-DISTINCT cho mọi cột varchar;
      // dùng raw SQL với tên cột whitelisted để chống SQL injection.
      // Tên cột đã được hard-code trong FACET_COLUMNS — KHÔNG từ user input.
      const where: ReturnType<typeof sql>[] = [sql`${sql.raw(col)} IS NOT NULL`, sql`${sql.raw(col)} <> ''`, sql`deleted_at IS NULL`];
      if (scope !== null) {
        if (scope.length === 0) {
          result[col] = [];
          continue;
        }
        where.push(sql`department_id = ANY(${scope}::uuid[])`);
      }
      const whereClause = sql.join(where, sql` AND `);
      const rows = await db.execute<{ value: string }>(sql`
        SELECT ${sql.raw(col)} AS value
          FROM recruitment_requests
         WHERE ${whereClause}
         GROUP BY ${sql.raw(col)}
         ORDER BY ${sql.raw(col)} ASC
         LIMIT ${MAX_VALUES_PER_FACET}
      `);
      const list = (rows.rows ?? [])
        .map((r) => (r as { value?: unknown }).value)
        .filter((v): v is string => typeof v === "string" && v.length > 0);
      result[col] = list;
    }
    return NextResponse.json({ facets: result, generatedAt: new Date().toISOString() });
  } catch (err) {
    return NextResponse.json(
      { error: "Không tải được danh sách filter.", detail: (err as Error).message },
      { status: 500 },
    );
  }
}
