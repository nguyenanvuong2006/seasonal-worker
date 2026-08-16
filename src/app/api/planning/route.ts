import { NextResponse } from "next/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { departments, planningPeriods, planningTargets, recruitmentRequests } from "@/db/schema";
import { getUserScope, requirePermission, writeAudit } from "@/lib/auth";
import {
  batchComputePlanningMetrics,
  createPeriod,
  legacyPlanningMetrics,
  requestKpiToPlanningMetrics,
  type PlanningMetricsWithSource,
} from "@/lib/planning";
import { batchComputeRequestKpis } from "@/lib/workforce-request";
import { todayStr } from "@/lib/helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Danh sách kế hoạch — lọc theo Data Scope cho DEPT_MANAGER, kèm nhu cầu Nam/Nữ, phân bổ, nghỉ việc, cần tuyển. */
export async function GET(req: Request) {
  const requestId = cryptoRandomRequestId();
  const t0 = Date.now();
  try {
    return await handlePlanningList(req, requestId, t0);
  } catch (err) {
    const queryDurationMs = Date.now() - t0;
    const errorCode = (err as { code?: string })?.code ?? "INTERNAL_ERROR";
    // PHASE 4 — server log: structured (requestId, errorCode, queryDurationMs).
    console.error("[planning.list] failure", {
      requestId,
      errorCode,
      message: (err as Error).message,
      queryDurationMs,
    });
    return NextResponse.json(
      {
        error: "Máy chủ gặp sự cố khi tải kế hoạch. Vui lòng thử lại.",
        code: errorCode,
        requestId,
        queryDurationMs,
      },
      { status: 500 },
    );
  }
}

function cryptoRandomRequestId(): string {
  // 12 hex chars from time + random — sufficient for log correlation, no extra deps.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function handlePlanningList(req: Request, requestId: string, t0: number) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER", "DEPT_MANAGER", "HR_DIRECTOR"], "planning.view");
  if (!guard.ok) return NextResponse.json({ error: guard.error, requestId }, { status: guard.status });

  const url = new URL(req.url);
  const statusParam = url.searchParams.get("status");
  const deptParam = url.searchParams.get("departmentId");
  const requestTypeParam = url.searchParams.get("requestType");

  const filters = [];
  if (statusParam && statusParam !== "ALL") filters.push(eq(planningPeriods.status, statusParam));
  if (deptParam) filters.push(eq(planningPeriods.departmentId, deptParam));
  if (requestTypeParam && requestTypeParam !== "ALL") filters.push(eq(planningPeriods.requestType, requestTypeParam));

  const scope = await getUserScope(guard.session);
  if (scope !== null) {
    if (scope.length === 0) return NextResponse.json({ rows: [], requestId, queryDurationMs: Date.now() - t0, rowCount: 0 });
    if (deptParam && !scope.includes(deptParam)) return NextResponse.json({ rows: [], requestId, queryDurationMs: Date.now() - t0, rowCount: 0 });
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
      requestId: planningPeriods.requestId,
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

  // WORKFORCE REQUEST LINKAGE (mục 8 + 9): period CÓ request_id → KPI lấy từ
  // Workforce Request (source of truth); period không liên kết → luồng cũ.
  const linkedIds = rows.filter((r) => r.requestId).map((r) => r.requestId as string);
  const requestRows = linkedIds.length > 0
    ? await db
        .select({
          id: recruitmentRequests.id,
          maleRq: recruitmentRequests.maleRq,
          femaleRq: recruitmentRequests.femaleRq,
          totalRequest: recruitmentRequests.totalRequest,
          requestedDate: recruitmentRequests.requestedDate,
          expectedDate: recruitmentRequests.expectedDate,
          createdAt: recruitmentRequests.createdAt,
        })
        .from(recruitmentRequests)
        .where(inArray(recruitmentRequests.id, linkedIds))
    : [];
  const requestKpis = await batchComputeRequestKpis(requestRows, todayStr());
  const requestKpiByRequestId = new Map(requestRows.map((r) => [r.id, requestKpis.get(r.id)]));

  const legacyIds = rows.filter((r) => !r.requestId).map((r) => r.id);
  const metricsMap = await batchComputePlanningMetrics(legacyIds);

  const withMetrics = rows.map((r) => {
    // Period liên kết request → metrics từ request (không tự tính khác đi).
    if (r.requestId) {
      const kpi = requestKpiByRequestId.get(r.requestId);
      if (kpi) return { ...r, metrics: requestKpiToPlanningMetrics(kpi, r.requestId), fillRate: fillRateFromMetrics(requestKpiToPlanningMetrics(kpi, r.requestId)) };
      return { ...r, metrics: emptyMetricsWithSource(r), fillRate: fillRateFromMetrics(emptyMetricsWithSource(r)) };
    }

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
      metrics: legacyPlanningMetrics(metrics, null),
      // Backward compatibility fields for legacy clients
      fillRate: {
        demand: metrics.demandTotal,
        active: metrics.allocatedTotal,
        missing: metrics.recruitmentNeededTotal,
        percent: metrics.fillRatePercent,
      },
    };
  });

  const queryDurationMs = Date.now() - t0;
  // PHASE 4 — structured log: rowCount, requestId, queryDurationMs, errorCode (null on success).
  console.log("[planning.list] ok", {
    requestId,
    rowCount: withMetrics.length,
    queryDurationMs,
    errorCode: null,
  });

  return NextResponse.json({ rows: withMetrics, requestId, queryDurationMs, rowCount: withMetrics.length });
}

function fillRateFromMetrics(metrics: PlanningMetricsWithSource) {
  return {
    demand: metrics.demandTotal,
    active: metrics.allocatedTotal,
    missing: metrics.recruitmentNeededTotal,
    percent: metrics.fillRatePercent,
  };
}

function emptyMetricsWithSource(r: { demandMale: number | null; demandFemale: number | null; targetCount: number | null }): PlanningMetricsWithSource {
  const demandMale = r.demandMale ?? 0;
  const demandFemale = r.demandFemale ?? 0;
  const demandTotal = demandMale + demandFemale > 0 ? demandMale + demandFemale : r.targetCount ?? 0;
  return {
    demandMale,
    demandFemale,
    demandTotal,
    allocatedMale: 0,
    allocatedFemale: 0,
    allocatedTotal: 0,
    resignedMale: 0,
    resignedFemale: 0,
    resignedTotal: 0,
    recruitmentNeededMale: demandMale,
    recruitmentNeededFemale: demandFemale,
    recruitmentNeededTotal: demandTotal,
    fillRatePercent: 0,
    metricsSource: "linked_request",
    requestId: null,
    warnings: [],
  };
}

/** Tạo kế hoạch mới (Kế hoạch gốc hoặc Yêu cầu bổ sung). */
export async function POST(req: Request) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER", "DEPT_MANAGER"], "planning.request");
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

  // Scope is role-independent. The DEPT_MANAGER DRAFT-only rule remains a separate business
  // permission rule and is intentionally unchanged.
  const scope = await getUserScope(guard.session);
  if (scope !== null && !scope.includes(body.departmentId)) {
    return NextResponse.json({ error: "Bộ phận này không thuộc Data Scope được cấp." }, { status: 403 });
  }
  let activateNow = body.activateNow !== false;
  if (guard.session.role === "DEPT_MANAGER") activateNow = false;

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
      activateNow,
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
