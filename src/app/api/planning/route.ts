import { NextResponse } from "next/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { departments, planningPeriods, planningTargets } from "@/db/schema";
import { getUserScope, requireRoleAndPermission, writeAudit } from "@/lib/auth";
import { batchComputePlanningMetrics, createPeriod } from "@/lib/planning";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Danh sách kế hoạch — lọc theo Data Scope cho DEPT_MANAGER, kèm nhu cầu Nam/Nữ, phân bổ, nghỉ việc, cần tuyển. */
export async function GET(req: Request) {
  const guard = await requireRoleAndPermission(["ADMIN", "HR_RECRUITER", "DEPT_MANAGER"], "planning.view");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const url = new URL(req.url);
  const statusParam = url.searchParams.get("status");
  const deptParam = url.searchParams.get("departmentId");
  const requestTypeParam = url.searchParams.get("requestType");

  const filters = [];
  if (statusParam && statusParam !== "ALL") filters.push(eq(planningPeriods.status, statusParam));
  if (deptParam) filters.push(eq(planningPeriods.departmentId, deptParam));
  if (requestTypeParam && requestTypeParam !== "ALL") filters.push(eq(planningPeriods.requestType, requestTypeParam));

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
      deptVnName: departments.vnName,
      location: departments.location,
      division: departments.division,
      section: departments.section,
      groupName: departments.groupName,
      periodSection: planningPeriods.section,
      periodGroupName: planningPeriods.groupName,
      startDate: planningPeriods.startDate,
      endDate: planningPeriods.endDate,
      status: planningPeriods.status,
      version: planningPeriods.version,
      requestType: planningPeriods.requestType,
      supplementIndex: planningPeriods.supplementIndex,
      parentPeriodId: planningPeriods.parentPeriodId,
      supersededBy: planningPeriods.supersededBy,
      createdBy: planningPeriods.createdBy,
      createdAt: planningPeriods.createdAt,
      demandMale: planningTargets.demandMale,
      demandFemale: planningTargets.demandFemale,
      targetCount: planningTargets.targetCount,
      note: planningTargets.note,
    })
    .from(planningPeriods)
    .leftJoin(departments, eq(planningPeriods.departmentId, departments.id))
    .leftJoin(planningTargets, eq(planningTargets.planningPeriodId, planningPeriods.id))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(planningPeriods.createdAt))
    .limit(300);

  const periodIds = rows.map((r) => r.id);
  const metricsMap = await batchComputePlanningMetrics(periodIds);

  const withMetrics = rows.map((r) => {
    const metrics = metricsMap.get(r.id) ?? {
      demandMale: r.demandMale ?? 0,
      demandFemale: r.demandFemale ?? 0,
      demandTotal: (r.demandMale ?? 0) + (r.demandFemale ?? 0) > 0
        ? (r.demandMale ?? 0) + (r.demandFemale ?? 0)
        : (r.targetCount ?? 0),
      allocatedMale: 0,
      allocatedFemale: 0,
      allocatedTotal: 0,
      resignedMale: 0,
      resignedFemale: 0,
      resignedTotal: 0,
      recruitmentNeededMale: r.demandMale ?? 0,
      recruitmentNeededFemale: r.demandFemale ?? 0,
      recruitmentNeededTotal: (r.demandMale ?? 0) + (r.demandFemale ?? 0) > 0
        ? (r.demandMale ?? 0) + (r.demandFemale ?? 0)
        : (r.targetCount ?? 0),
      fillRatePercent: 0,
    };

    return {
      ...r,
      metrics,
      // Backward compatibility fields for legacy clients
      fillRate: {
        demand: metrics.demandTotal,
        active: metrics.allocatedTotal,
        missing: metrics.recruitmentNeededTotal,
        percent: metrics.fillRatePercent,
      },
    };
  });

  return NextResponse.json({ rows: withMetrics });
}

/** Tạo kế hoạch mới (Kế hoạch gốc hoặc Yêu cầu bổ sung). */
export async function POST(req: Request) {
  const guard = await requireRoleAndPermission(["ADMIN", "HR_RECRUITER"], "planning.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const body = (await req.json()) as {
    departmentId?: string;
    section?: string | null;
    groupName?: string | null;
    startDate?: string;
    endDate?: string;
    demandMale?: number;
    demandFemale?: number;
    targetCount?: number;
    requestType?: "ORIGINAL" | "SUPPLEMENT";
    parentPeriodId?: string | null;
    note?: string;
    activateNow?: boolean;
  };

  if (!body.departmentId || !body.startDate || !body.endDate) {
    return NextResponse.json({ error: "Thiếu bộ phận hoặc ngày bắt đầu/kết thúc." }, { status: 400 });
  }

  const demandMale = Math.max(0, Number(body.demandMale) || 0);
  const demandFemale = Math.max(0, Number(body.demandFemale) || 0);
  const targetCount = body.targetCount !== undefined && Number(body.targetCount) > 0
    ? Number(body.targetCount)
    : demandMale + demandFemale;

  if (demandMale <= 0 && demandFemale <= 0 && targetCount <= 0) {
    return NextResponse.json({ error: "Vui lòng nhập nhu cầu tuyển dụng (Nam hoặc Nữ > 0)." }, { status: 400 });
  }

  try {
    const period = await createPeriod({
      departmentId: body.departmentId,
      section: body.section || null,
      groupName: body.groupName || null,
      startDate: body.startDate,
      endDate: body.endDate,
      demandMale,
      demandFemale,
      targetCount,
      requestType: body.requestType ?? "ORIGINAL",
      parentPeriodId: body.parentPeriodId ?? null,
      note: body.note,
      createdBy: guard.session.username,
      activateNow: body.activateNow !== false,
    });

    await writeAudit(guard.session, "CREATE_PLANNING_PERIOD", "planning_periods", {
      id: period.id,
      requestType: period.requestType,
      supplementIndex: period.supplementIndex,
      status: period.status,
      demandMale,
      demandFemale,
      targetCount,
    });

    return NextResponse.json({ success: true, row: period });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
