import { NextResponse } from "next/server";
import { and, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { dailyApplications, departments, planningPeriods, planningTargets, workerProfiles, workforceMovements } from "@/db/schema";
import { getUserScope, requireRole } from "@/lib/auth";
import { todayStr } from "@/lib/helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * TASK CENTER (Phase 2, Step 5) — màn hình đầu tiên của HR, tổng hợp việc cần xử lý
 * từ nhiều module. KHÔNG lưu trùng dữ liệu (không có bảng "tasks" riêng) — query
 * trực tiếp từ các bảng nghiệp vụ đã có, lọc theo Data Scope giống các module gốc.
 */
export async function GET() {
  const guard = await requireRole(["ADMIN", "HR_RECRUITER", "DEPT_MANAGER"]);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const scope = await getUserScope(guard.session);
  const today = todayStr();
  const in7days = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

  // 1) Người mới chờ duyệt (Daily Application, PENDING)
  const newApplicantsFilters = [eq(dailyApplications.status, "PENDING"), isNull(dailyApplications.deletedAt)];
  if (scope) newApplicantsFilters.push(inArray(dailyApplications.deptId, scope.length ? scope : ["__none__"]));
  const newApplicants = await db.select().from(dailyApplications).where(and(...newApplicantsFilters)).orderBy(desc(dailyApplications.submittedAt)).limit(50);

  // 2) Nghỉ việc chờ duyệt
  const resignFilters = [eq(workforceMovements.movementType, "resignation"), eq(workforceMovements.status, "PENDING_HR")];
  if (scope) resignFilters.push(inArray(workforceMovements.fromDeptId, scope.length ? scope : ["__none__"]));
  const resignations = await db
    .select({
      id: workforceMovements.id,
      workerName: workerProfiles.fullName,
      workerCccd: workerProfiles.cccd,
      effectiveDate: workforceMovements.effectiveDate,
      requestedBy: workforceMovements.requestedBy,
      createdAt: workforceMovements.createdAt,
    })
    .from(workforceMovements)
    .leftJoin(workerProfiles, eq(workforceMovements.workerId, workerProfiles.id))
    .where(and(...resignFilters))
    .orderBy(desc(workforceMovements.createdAt))
    .limit(50);

  // 3) Thuyên chuyển chờ xử lý (PENDING_HR hoặc WAITING_DECISION)
  const transferFilters = [eq(workforceMovements.movementType, "transfer"), sql`${workforceMovements.status} IN ('PENDING_HR','WAITING_DECISION')`];
  if (scope) transferFilters.push(inArray(workforceMovements.fromDeptId, scope.length ? scope : ["__none__"]));
  const transfers = await db
    .select({
      id: workforceMovements.id,
      workerName: workerProfiles.fullName,
      workerCccd: workerProfiles.cccd,
      status: workforceMovements.status,
      effectiveDate: workforceMovements.effectiveDate,
      requestedBy: workforceMovements.requestedBy,
      createdAt: workforceMovements.createdAt,
    })
    .from(workforceMovements)
    .leftJoin(workerProfiles, eq(workforceMovements.workerId, workerProfiles.id))
    .where(and(...transferFilters))
    .orderBy(desc(workforceMovements.createdAt))
    .limit(50);

  // 4) Planning sắp hết hạn (7 ngày tới)
  const expiringFilters = [eq(planningPeriods.status, "ACTIVE"), gte(planningPeriods.endDate, today), lte(planningPeriods.endDate, in7days)];
  if (scope) expiringFilters.push(inArray(planningPeriods.departmentId, scope.length ? scope : ["__none__"]));
  const expiringPlans = await db
    .select({
      id: planningPeriods.id,
      deptName: departments.deptName,
      section: planningPeriods.section,
      endDate: planningPeriods.endDate,
      targetCount: planningTargets.targetCount,
    })
    .from(planningPeriods)
    .leftJoin(departments, eq(planningPeriods.departmentId, departments.id))
    .leftJoin(planningTargets, eq(planningTargets.planningPeriodId, planningPeriods.id))
    .where(and(...expiringFilters))
    .limit(50);

  return NextResponse.json({
    newApplicants: newApplicants.map((r) => ({ id: r.id, fullName: r.fullName, cccd: r.cccd, submittedAt: r.submittedAt })),
    resignations,
    transfers,
    expiringPlans,
    generatedAt: new Date().toISOString(),
  });
}
