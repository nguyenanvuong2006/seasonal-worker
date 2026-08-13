import { NextResponse } from "next/server";
import { and, desc, eq, ilike, inArray, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import {
  dailyApplications,
  departments,
  planningPeriods,
  workerProfiles,
  workforceMovements,
} from "@/db/schema";
import { getSession, getUserScope, hasPermission } from "@/lib/auth";
import { ROLE_LABEL } from "@/lib/helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIN_QUERY_LENGTH = 2;
const GROUP_LIMIT = 5;

type SearchItem = { id: string; title: string; subtitle: string; status?: string; href: string };
type SearchGroup = { type: string; label: string; items: SearchItem[] };

const mask = (v: string | null, visible: boolean) => (visible ? (v ?? "") : v ? "•••• (ẩn theo quyền)" : "");

/**
 * Tìm kiếm toàn hệ thống — CHỈ dành cho người dùng nội bộ đã đăng nhập. Mọi điều kiện phân
 * quyền/Data Scope/che PII ở đây MIRROR đúng logic đã có ở các API danh sách tương ứng
 * (GET /api/registrations, /api/workforce-movements, /api/planning, /api/departments,
 * /api/worker-profiles/[cccd]) — không tự phát minh luật phân quyền mới, không bao giờ trả PII
 * đầy đủ khi role không có quyền `privacy.view_cccd`/`privacy.view_phone`, không bao giờ vượt
 * Data Scope của DEPT_MANAGER dù query đi thẳng xuống DB.
 */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Chưa đăng nhập." }, { status: 401 });

  if (!(await hasPermission(session.role, "global_search.use"))) {
    return NextResponse.json({ error: "Tài khoản của bạn không có quyền sử dụng Tìm kiếm toàn hệ thống." }, { status: 403 });
  }

  const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
  if (q.length < MIN_QUERY_LENGTH) return NextResponse.json({ groups: [] });

  const pattern = `%${q.replace(/[%_]/g, (m) => "\\" + m)}%`;
  const groups: SearchGroup[] = [];

  const canViewCccd = await hasPermission(session.role, "privacy.view_cccd");
  const canViewPhone = await hasPermission(session.role, "privacy.view_phone");
  const scope = session.role === "DEPT_MANAGER" ? await getUserScope(session) : null; // null = không giới hạn

  /* ---------------- Người lao động (worker_profiles) — chỉ ADMIN/HR_RECRUITER có workers.view,
     giống hệt GET /api/worker-profiles/[cccd]. Không Data Scope (worker_profiles không gắn
     department cố định — đúng kiến trúc hiện có, không phát minh thêm). ---------------- */
  if (["ADMIN", "HR_RECRUITER"].includes(session.role) && (await hasPermission(session.role, "workers.view"))) {
    const rows = await db
      .select({ id: workerProfiles.id, cccd: workerProfiles.cccd, fullName: workerProfiles.fullName, phone: workerProfiles.phone })
      .from(workerProfiles)
      .where(
        and(
          isNull(workerProfiles.deletedAt),
          or(ilike(workerProfiles.fullName, pattern), ilike(workerProfiles.cccd, pattern), ilike(workerProfiles.phone, pattern)),
        ),
      )
      .limit(GROUP_LIMIT);

    if (rows.length > 0) {
      groups.push({
        type: "worker",
        label: "Hồ sơ Tập nghề",
        items: rows.map((r) => ({
          id: r.id,
          title: r.fullName,
          subtitle: `CCCD: ${mask(r.cccd, canViewCccd)}${r.phone ? " • SĐT: " + mask(r.phone, canViewPhone) : ""}`,
          href: `/admin/worker-profiles?cccd=${encodeURIComponent(r.cccd)}`,
        })),
      });
    }
  }

  /* ---------------- Daily Application — chỉ ADMIN/HR_RECRUITER (đúng trang /hr/registrations
     hiện có; DEPT_MANAGER bị chính trang đó redirect sang /department nên không đưa vào kết quả
     tìm kiếm để tránh dẫn tới đường cụt). ---------------- */
  if (["ADMIN", "HR_RECRUITER"].includes(session.role)) {
    const rows = await db
      .select({
        id: dailyApplications.id,
        cccd: dailyApplications.cccd,
        fullName: dailyApplications.fullName,
        phone: dailyApplications.phone,
        status: dailyApplications.status,
        regDate: dailyApplications.regDate,
        deptName: departments.deptName,
      })
      .from(dailyApplications)
      .leftJoin(departments, eq(dailyApplications.deptId, departments.id))
      .where(
        and(
          isNull(dailyApplications.deletedAt),
          or(ilike(dailyApplications.fullName, pattern), ilike(dailyApplications.cccd, pattern), ilike(dailyApplications.phone, pattern)),
        ),
      )
      .orderBy(desc(dailyApplications.regDate))
      .limit(GROUP_LIMIT);

    if (rows.length > 0) {
      groups.push({
        type: "daily_application",
        label: "Daily Application",
        items: rows.map((r) => ({
          id: r.id,
          title: r.fullName,
          subtitle: `CCCD: ${mask(r.cccd, canViewCccd)} • ${r.deptName ?? "Chưa xếp bộ phận"}`,
          status: r.status,
          href: `/hr/registrations?q=${encodeURIComponent(r.cccd)}&from=${r.regDate}&to=${r.regDate}&rangeMode=1`,
        })),
      });
    }
  }

  /* ---------------- Bộ phận — không permission riêng (giống GET /api/departments hiện có),
     nhưng vẫn giới hạn theo Data Scope nếu DEPT_MANAGER (không cho tìm thấy bộ phận ngoài phạm
     vi quản lý, dù bảng departments bản thân không có PII). ---------------- */
  {
    const filters = [
      isNull(departments.deletedAt),
      or(ilike(departments.deptName, pattern), ilike(departments.groupName, pattern), ilike(departments.vnName, pattern), ilike(departments.supervisor, pattern)),
    ];
    if (scope) {
      if (scope.length === 0) {
        // không có bộ phận nào được gán -> không trả kết quả nhóm này
      } else {
        filters.push(inArray(departments.id, scope));
      }
    }
    const rows =
      scope && scope.length === 0
        ? []
        : await db
            .select({ id: departments.id, deptName: departments.deptName, groupName: departments.groupName, vnName: departments.vnName, supervisor: departments.supervisor })
            .from(departments)
            .where(and(...filters))
            .limit(GROUP_LIMIT);

    if (rows.length > 0) {
      groups.push({
        type: "department",
        label: "Bộ phận",
        items: rows.map((r) => ({
          id: r.id,
          title: r.deptName,
          subtitle: [r.groupName, r.vnName, r.supervisor ? `Phụ trách: ${r.supervisor}` : null].filter(Boolean).join(" • ") || "—",
          href: session.role === "DEPT_MANAGER" ? `/department?dept=${r.id}` : `/admin/departments?q=${encodeURIComponent(r.deptName)}`,
        })),
      });
    }
  }

  /* ---------------- Planning — planning.view (đúng requireRoleAndPermission ở GET /api/planning),
     Data Scope theo departmentId cho DEPT_MANAGER. ---------------- */
  if (await hasPermission(session.role, "planning.view")) {
    const filters = [
      or(ilike(departments.deptName, pattern), ilike(planningPeriods.section, pattern), ilike(planningPeriods.status, pattern)),
    ];
    if (scope) {
      if (scope.length > 0) filters.push(inArray(planningPeriods.departmentId, scope));
    }
    const rows =
      scope && scope.length === 0
        ? []
        : await db
            .select({
              id: planningPeriods.id,
              deptName: departments.deptName,
              section: planningPeriods.section,
              status: planningPeriods.status,
              startDate: planningPeriods.startDate,
              endDate: planningPeriods.endDate,
            })
            .from(planningPeriods)
            .leftJoin(departments, eq(planningPeriods.departmentId, departments.id))
            .where(and(...filters))
            .orderBy(desc(planningPeriods.createdAt))
            .limit(GROUP_LIMIT);

    if (rows.length > 0) {
      groups.push({
        type: "planning",
        label: "Planning",
        items: rows.map((r) => ({
          id: r.id,
          title: `${r.deptName ?? "—"}${r.section ? " — " + r.section : ""}`,
          subtitle: `${r.startDate} → ${r.endDate}`,
          status: r.status,
          href: `/admin/planning?status=${r.status}&highlight=${r.id}`,
        })),
      });
    }
  }

  /* ---------------- Nghỉ việc / Thuyên chuyển — workforce_movements.view, Data Scope theo
     fromDeptId cho DEPT_MANAGER (đúng GET /api/workforce-movements). ---------------- */
  if (await hasPermission(session.role, "workforce_movements.view")) {
    const filters = [
      or(ilike(workerProfiles.fullName, pattern), ilike(workerProfiles.cccd, pattern), ilike(workforceMovements.status, pattern)),
    ];
    if (scope) {
      if (scope.length > 0) filters.push(inArray(workforceMovements.fromDeptId, scope));
    }
    const rows =
      scope && scope.length === 0
        ? []
        : await db
            .select({
              id: workforceMovements.id,
              movementType: workforceMovements.movementType,
              status: workforceMovements.status,
              workerName: workerProfiles.fullName,
              workerCccd: workerProfiles.cccd,
              effectiveDate: workforceMovements.effectiveDate,
            })
            .from(workforceMovements)
            .leftJoin(workerProfiles, eq(workforceMovements.workerId, workerProfiles.id))
            .where(and(...filters))
            .orderBy(desc(workforceMovements.createdAt))
            .limit(GROUP_LIMIT);

    if (rows.length > 0) {
      groups.push({
        type: "workforce_movement",
        label: "Nghỉ việc / Thuyên chuyển",
        items: rows.map((r) => ({
          id: r.id,
          title: r.workerName ?? "(Không rõ lao động)",
          subtitle: `${r.movementType === "resignation" ? "Nghỉ việc" : "Thuyên chuyển"} • CCCD: ${mask(r.workerCccd, canViewCccd)} • ${r.effectiveDate}`,
          status: r.status,
          href: `/admin/workforce-movements?highlight=${r.id}`,
        })),
      });
    }
  }

  return NextResponse.json({ groups, roleLabel: ROLE_LABEL[session.role] ?? session.role });
}
