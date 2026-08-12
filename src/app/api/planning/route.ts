import { NextResponse } from "next/server";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { departments, employmentSessions, planningAllocations, planningPeriods, planningTargets } from "@/db/schema";
import { getUserScope, requireRoleAndPermission, writeAudit } from "@/lib/auth";
import { createPeriod } from "@/lib/planning";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Danh sách kế hoạch — lọc theo Data Scope cho DEPT_MANAGER, kèm nhu cầu + tỷ lệ lấp đầy. */
export async function GET(req: Request) {
  const guard = await requireRoleAndPermission(["ADMIN", "HR_RECRUITER", "DEPT_MANAGER"], "planning.view");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const url = new URL(req.url);
  const statusParam = url.searchParams.get("status");

  const filters = [];
  if (statusParam && statusParam !== "ALL") filters.push(eq(planningPeriods.status, statusParam));

  if (guard.session.role === "DEPT_MANAGER") {
    const scope = await getUserScope(guard.session);
    if (!scope || scope.length === 0) return NextResponse.json({ rows: [] });
    filters.push(inArray(planningPeriods.departmentId, scope));
  }

  const rows = await db
    .select({
      id: planningPeriods.id,
      departmentId: planningPeriods.departmentId,
      deptName: departments.deptName,
      section: planningPeriods.section,
      startDate: planningPeriods.startDate,
      endDate: planningPeriods.endDate,
      status: planningPeriods.status,
      version: planningPeriods.version,
      supersededBy: planningPeriods.supersededBy,
      createdBy: planningPeriods.createdBy,
      createdAt: planningPeriods.createdAt,
      targetCount: planningTargets.targetCount,
    })
    .from(planningPeriods)
    .leftJoin(departments, eq(planningPeriods.departmentId, departments.id))
    .leftJoin(planningTargets, eq(planningTargets.planningPeriodId, planningPeriods.id))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(planningPeriods.createdAt))
    .limit(300);

  // Phase 4 (Production Hardening Audit) — TRƯỚC ĐÂY gọi computeFillRate() cho TỪNG dòng ACTIVE
  // (Promise.all(rows.map(...))), mỗi lần lại tự query lại targetCount (đã có sẵn từ JOIN ở trên)
  // + đếm allocations riêng — N+1 query tăng tuyến tính theo số kế hoạch ACTIVE. Nay: `demand`
  // lấy thẳng từ `targetCount` đã JOIN sẵn (không query lại), và `active` (số đã phân bổ) tổng
  // hợp bằng ĐÚNG 1 query GROUP BY cho toàn bộ period ACTIVE đang hiển thị — tổng số query không
  // tăng theo N nữa. Response shape giữ nguyên (`fillRate: {demand,active,missing,percent}|null`).
  const activeIds = rows.filter((r) => r.status === "ACTIVE").map((r) => r.id);
  const allocatedCounts =
    activeIds.length > 0
      ? await db
          .select({ planningPeriodId: planningAllocations.planningPeriodId, active: sql<number>`count(*)::int` })
          .from(planningAllocations)
          .innerJoin(employmentSessions, eq(planningAllocations.employmentSessionId, employmentSessions.id))
          .where(
            and(
              inArray(planningAllocations.planningPeriodId, activeIds),
              eq(employmentSessions.status, "APPROVED"),
              isNull(employmentSessions.endDate),
            ),
          )
          .groupBy(planningAllocations.planningPeriodId)
      : [];
  const activeByPeriod = new Map(allocatedCounts.map((r) => [r.planningPeriodId, r.active]));

  const withFillRate = rows.map((r) => {
    if (r.status !== "ACTIVE") return { ...r, fillRate: null };
    const demand = r.targetCount ?? 0;
    const active = activeByPeriod.get(r.id) ?? 0;
    return {
      ...r,
      fillRate: { demand, active, missing: Math.max(0, demand - active), percent: demand > 0 ? Math.round((active / demand) * 100) : 0 },
    };
  });

  return NextResponse.json({ rows: withFillRate });
}

/** Tạo kế hoạch mới (Draft hoặc Active ngay) — kiểm tra overlap nếu kích hoạt ngay. */
export async function POST(req: Request) {
  const guard = await requireRoleAndPermission(["ADMIN", "HR_RECRUITER"], "planning.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const body = (await req.json()) as {
    departmentId?: string;
    section?: string | null;
    startDate?: string;
    endDate?: string;
    targetCount?: number;
    note?: string;
    activateNow?: boolean;
  };

  if (!body.departmentId || !body.startDate || !body.endDate || body.targetCount === undefined) {
    return NextResponse.json({ error: "Thiếu bộ phận, ngày bắt đầu/kết thúc, hoặc nhu cầu." }, { status: 400 });
  }

  try {
    const period = await createPeriod({
      departmentId: body.departmentId,
      section: body.section || null,
      startDate: body.startDate,
      endDate: body.endDate,
      targetCount: Number(body.targetCount) || 0,
      note: body.note,
      createdBy: guard.session.username,
      activateNow: Boolean(body.activateNow),
    });
    await writeAudit(guard.session, "CREATE_PLANNING_PERIOD", "planning_periods", { id: period.id, status: period.status });
    return NextResponse.json({ success: true, row: period });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
