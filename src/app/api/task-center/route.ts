import { NextResponse } from "next/server";
import { and, desc, eq, gte, ilike, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  dailyApplications,
  departments,
  planningPeriods,
  planningTargets,
  planningTasks,
  workerProfiles,
  workforceMovements,
} from "@/db/schema";
import { getUserScope, hasPermission, requirePermission } from "@/lib/auth";
import { todayStr } from "@/lib/helpers";
import { normalizePersonName } from "@/lib/person-name";
import { movementScopeVisibility } from "@/lib/data-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SECTION_LIMIT = 50;

/**
 * TASK CENTER (Phase 2, Step 5) — màn hình đầu tiên của HR, tổng hợp việc cần xử lý
 * từ nhiều module. KHÔNG lưu trùng dữ liệu (không có bảng "tasks" riêng) — query
 * trực tiếp từ các bảng nghiệp vụ đã có, lọc theo Data Scope giống các module gốc.
 *
 * Phase 3 (Production Hardening Audit):
 * 3.1 — trước đây chỉ dùng requireRole(), không tôn trọng permission chi tiết
 *       (role_permissions/hasPermission) — nay mỗi mục chỉ trả về nếu role còn quyền tương ứng;
 *       mục bị ẩn do permission được liệt kê ở `hiddenSections` để frontend giải thích rõ lý do.
 * 3.2 — "Người mới chờ duyệt" là việc CHỈ ADMIN/HR_RECRUITER xử lý được — trang đích
 *       `/hr/registrations` tự redirect DEPT_MANAGER đi nơi khác (xem page.tsx), nên mục này
 *       LUÔN ẩn với DEPT_MANAGER (không phải tuỳ permission) — trước đây vẫn hiện + link dẫn
 *       vào 1 trang sẽ redirect ngay, thành "dead link" cho Manager.
 * 3.4 — hỗ trợ tìm kiếm server-side qua query `q` (tên/CCCD), trả kèm `total` mỗi mục để
 *       frontend biết còn dữ liệu ngoài 50 dòng đầu hay không (không còn fetch-rồi-lọc-client).
 */
export async function GET(req: Request) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER", "DEPT_MANAGER", "HR_DIRECTOR"], "dashboard.view");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  const { role } = guard.session;

  const scope = await getUserScope(guard.session);
  const today = todayStr();
  const in7days = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const hiddenSections: string[] = [];

  // 1) Người mới chờ duyệt (Daily Application, PENDING) — quyền registrations.approve quyết định
  //    (Dynamic RBAC V2: bỏ điều kiện role !== DEPT_MANAGER — baseline DEPT_MANAGER không có quyền này).
  let newApplicants: { id: string; fullName: string; cccd: string; submittedAt: string }[] = [];
  let newApplicantsTotal = 0;
  const canSeeNewApplicants = await hasPermission(role, "registrations.approve");
  if (canSeeNewApplicants) {
    const filters = [eq(dailyApplications.status, "PENDING"), isNull(dailyApplications.deletedAt)];
    if (scope) filters.push(inArray(dailyApplications.deptId, scope.length ? scope : ["__none__"]));
    if (q) filters.push(or(ilike(dailyApplications.fullName, `%${q}%`), ilike(dailyApplications.cccd, `%${q}%`))!);
    const where = and(...filters);

    const rows = await db.select().from(dailyApplications).where(where).orderBy(desc(dailyApplications.submittedAt)).limit(SECTION_LIMIT);
    newApplicants = rows.map((r) => ({ id: r.id, fullName: normalizePersonName(r.fullName), cccd: r.cccd, submittedAt: r.submittedAt.toISOString() }));
    const [cnt] = await db.select({ c: sql<number>`count(*)::int` }).from(dailyApplications).where(where);
    newApplicantsTotal = cnt?.c ?? newApplicants.length;
  } else {
    hiddenSections.push("newApplicants");
  }

  // 2) Nghỉ việc chờ duyệt
  let resignations: { id: string; workerName: string | null; workerCccd: string | null; effectiveDate: string; requestedBy: string; createdAt: string }[] = [];
  let resignationsTotal = 0;
  const canSeeMovements = await hasPermission(role, "workforce_movements.view");
  if (canSeeMovements) {
    const filters = [eq(workforceMovements.movementType, "resignation"), eq(workforceMovements.status, "PENDING_HR")];
    if (scope) filters.push(inArray(workforceMovements.fromDeptId, scope.length ? scope : ["__none__"]));
    if (q) filters.push(or(ilike(workerProfiles.fullName, `%${q}%`), ilike(workerProfiles.cccd, `%${q}%`))!);
    const where = and(...filters);

    resignations = await db
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
      .where(where)
      .orderBy(desc(workforceMovements.createdAt))
      .limit(SECTION_LIMIT)
      .then((rows) => rows.map((r) => ({ ...r, workerName: normalizePersonName(r.workerName ?? "") || null, createdAt: r.createdAt.toISOString() })));
    const [cnt] = await db.select({ c: sql<number>`count(*)::int` }).from(workforceMovements).leftJoin(workerProfiles, eq(workforceMovements.workerId, workerProfiles.id)).where(where);
    resignationsTotal = cnt?.c ?? resignations.length;
  } else {
    hiddenSections.push("resignations");
  }

  // 3) Thuyên chuyển chờ xử lý (PENDING_HR hoặc WAITING_DECISION)
  let transfers: { id: string; workerName: string | null; workerCccd: string | null; status: string; effectiveDate: string; requestedBy: string | null; createdAt: string; scopeVisibility: "FULL" | "REDACTED_INCOMING" }[] = [];
  let transfersTotal = 0;
  if (canSeeMovements) {
    const filters = [eq(workforceMovements.movementType, "transfer"), sql`${workforceMovements.status} IN ('PENDING_HR','WAITING_DECISION')`];
    if (scope !== null) {
      if (q) {
        // Do not let a name/CCCD query discover an incoming worker whose source is outside scope.
        filters.push(inArray(workforceMovements.fromDeptId, scope.length ? scope : ["__none__"]));
      } else {
        filters.push(or(
          inArray(workforceMovements.fromDeptId, scope.length ? scope : ["__none__"]),
          inArray(workforceMovements.toDeptId, scope.length ? scope : ["__none__"]),
        )!);
      }
    }
    if (q) filters.push(or(ilike(workerProfiles.fullName, `%${q}%`), ilike(workerProfiles.cccd, `%${q}%`))!);
    const where = and(...filters);

    transfers = await db
      .select({
        id: workforceMovements.id,
        workerName: workerProfiles.fullName,
        workerCccd: workerProfiles.cccd,
        fromDeptId: workforceMovements.fromDeptId,
        toDeptId: workforceMovements.toDeptId,
        status: workforceMovements.status,
        effectiveDate: workforceMovements.effectiveDate,
        requestedBy: workforceMovements.requestedBy,
        createdAt: workforceMovements.createdAt,
      })
      .from(workforceMovements)
      .leftJoin(workerProfiles, eq(workforceMovements.workerId, workerProfiles.id))
      .where(where)
      .orderBy(desc(workforceMovements.createdAt))
      .limit(SECTION_LIMIT)
      .then((rows) => rows.flatMap((r) => {
        const visibility = movementScopeVisibility(scope, "transfer", r.fromDeptId, r.toDeptId);
        if (visibility === "NONE") return [];
        return [{
          id: r.id,
          workerName: visibility === "FULL" ? normalizePersonName(r.workerName ?? "") || null : null,
          workerCccd: visibility === "FULL" ? r.workerCccd : null,
          status: r.status,
          effectiveDate: r.effectiveDate,
          requestedBy: visibility === "FULL" ? r.requestedBy : null,
          createdAt: r.createdAt.toISOString(),
          scopeVisibility: visibility,
        }];
      }));
    const [cnt] = await db.select({ c: sql<number>`count(*)::int` }).from(workforceMovements).leftJoin(workerProfiles, eq(workforceMovements.workerId, workerProfiles.id)).where(where);
    transfersTotal = cnt?.c ?? transfers.length;
  } else {
    hiddenSections.push("transfers");
  }

  // 4) Planning sắp hết hạn (7 ngày tới)
  let expiringPlans: { id: string; deptName: string | null; section: string | null; endDate: string; targetCount: number | null }[] = [];
  let expiringPlansTotal = 0;
  const canSeePlanning = await hasPermission(role, "planning.view");
  if (canSeePlanning) {
    const filters = [eq(planningPeriods.status, "ACTIVE"), gte(planningPeriods.endDate, today), lte(planningPeriods.endDate, in7days)];
    if (scope) filters.push(inArray(planningPeriods.departmentId, scope.length ? scope : ["__none__"]));
    if (q) filters.push(or(ilike(departments.deptName, `%${q}%`), ilike(planningPeriods.section, `%${q}%`))!);
    const where = and(...filters);

    expiringPlans = await db
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
      .where(where)
      .limit(SECTION_LIMIT);
    const [cnt] = await db.select({ c: sql<number>`count(*)::int` }).from(planningPeriods).leftJoin(departments, eq(planningPeriods.departmentId, departments.id)).where(where);
    expiringPlansTotal = cnt?.c ?? expiringPlans.length;
  } else {
    hiddenSections.push("expiringPlans");
  }

  // 5) Yêu cầu tuyển dụng hết hạn còn DW cần chuyển phân bổ (Yêu cầu #7 & #14).
  //    Đây là mục DUY NHẤT đọc từ bảng `planning_tasks` — task được job
  //    `expire_recruitment_requests` tạo sẵn, có unique index chống trùng, nên
  //    không thể tổng hợp bằng live-query như bốn mục trên.
  //
  //    LƯU Ý NGHIỆP VỤ: task này CHỈ nói "yêu cầu đã hết hạn, cần xác nhận
  //    chuyển DW sang yêu cầu mới". Nó KHÔNG có nghĩa là DW nghỉ việc.
  let reallocationTasks: {
    id: string;
    requestCode: string | null;
    departmentName: string | null;
    section: string | null;
    groupName: string | null;
    endDate: string | null;
    totalActiveAllocations: number;
    maleCount: number;
    femaleCount: number;
    recruitmentRequestId: string | null;
    dueDate: string | null;
  }[] = [];
  let reallocationTasksTotal = 0;
  // Chỉ người thực sự chuyển được phân bổ mới thấy mục này — Dept Manager
  // không có `planning.reallocate` nên không bị giao việc họ không làm được.
  const canReallocate = await hasPermission(role, "planning.reallocate");
  if (canReallocate) {
    const filters = [
      eq(planningTasks.taskType, "PLANNING_REALLOCATION_REQUIRED"),
      inArray(planningTasks.status, ["OPEN", "IN_PROGRESS"]),
    ];
    if (scope) filters.push(inArray(planningTasks.departmentId, scope.length ? scope : ["__none__"]));
    if (q) filters.push(ilike(planningTasks.title, `%${q}%`));
    const where = and(...filters);

    const rows = await db
      .select({
        id: planningTasks.id,
        detail: planningTasks.detail,
        dueDate: planningTasks.dueDate,
        recruitmentRequestId: planningTasks.recruitmentRequestId,
        departmentName: departments.deptName,
      })
      .from(planningTasks)
      .leftJoin(departments, eq(planningTasks.departmentId, departments.id))
      .where(where)
      .orderBy(planningTasks.dueDate)
      .limit(SECTION_LIMIT);

    reallocationTasks = rows.map((r) => {
      const d = (r.detail ?? {}) as Record<string, unknown>;
      return {
        id: r.id,
        requestCode: (d.requestCode as string) ?? null,
        departmentName: r.departmentName ?? ((d.department as string) || null),
        section: (d.section as string) ?? null,
        groupName: (d.groupName as string) ?? null,
        endDate: (d.endDate as string) ?? null,
        totalActiveAllocations: Number(d.totalActiveAllocations ?? 0),
        maleCount: Number(d.maleCount ?? 0),
        femaleCount: Number(d.femaleCount ?? 0),
        recruitmentRequestId: r.recruitmentRequestId,
        dueDate: r.dueDate,
      };
    });

    const [cnt] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(planningTasks)
      .leftJoin(departments, eq(planningTasks.departmentId, departments.id))
      .where(where);
    reallocationTasksTotal = cnt?.c ?? reallocationTasks.length;
  } else {
    hiddenSections.push("reallocationTasks");
  }

  return NextResponse.json({
    newApplicants: { rows: newApplicants, total: newApplicantsTotal },
    resignations: { rows: resignations, total: resignationsTotal },
    transfers: { rows: transfers, total: transfersTotal },
    expiringPlans: { rows: expiringPlans, total: expiringPlansTotal },
    reallocationTasks: { rows: reallocationTasks, total: reallocationTasksTotal },
    hiddenSections,
    generatedAt: new Date().toISOString(),
  });
}
