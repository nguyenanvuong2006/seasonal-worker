import { redirect } from "next/navigation";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { dailyApplications, departments, dwData } from "@/db/schema";
import { getSession, getUserScope, hasPermission } from "@/lib/auth";
import { todayStr } from "@/lib/helpers";
import RegistrationsGrid from "@/components/registrations-grid";
import DailyApplicationScoped from "@/components/daily-application-scoped";
import { Badge, MetricStrip, MetricStripItem, PageHeader, SectionLabel } from "@/components/ui";
import { CheckCircle2, Clock, Database, ShieldCheck, UserPlus2, Zap } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function HrRegistrationsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  // DYNAMIC RBAC V2 — thay danh sách role hardcode bằng quyền registrations.view.
  if (!(await hasPermission(session.role, "registrations.view"))) redirect("/admin/dashboard");

  // Ngườu dùng CÓ Data Scope (Quản lý bộ phận) chỉ thấy bộ phận được phân quyền —
  // dropdown bộ lọc và toàn bộ số liệu đều thu hẹp theo scope.
  const scope = await getUserScope(session);
  const scoped = scope !== null;

  const depts =
    scoped && scope.length === 0
      ? []
      : await db
          .select({
            id: departments.id,
            deptName: departments.deptName,
            groupName: departments.groupName,
            vnName: departments.vnName,
            dailyQuota: departments.dailyQuota,
          })
          .from(departments)
          .where(
            scoped && scope.length > 0
              ? and(eq(departments.isActive, true), inArray(departments.id, scope))
              : eq(departments.isActive, true),
          )
          .orderBy(asc(departments.deptName), asc(departments.groupName));

  const dw = scope === null ? (await db.select({ c: sql<number>`count(*)::int` }).from(dwData))[0] : null;

  // RECRUITER PIPELINE (cá nhân hoá theo vai trò) — số liệu hôm nay để HR nắm nhanh khối lượng việc.
  // Với người có Data Scope, chỉ đếm trong các bộ phận được phân quyền.
  const pipelineFilters = [eq(dailyApplications.regDate, todayStr()), sql`${dailyApplications.deletedAt} is null`];
  if (scoped && scope.length > 0) pipelineFilters.push(inArray(dailyApplications.deptId, scope));

  const pipeline =
    scoped && scope.length === 0
      ? { pending: 0, approved: 0, newToDw: 0, total: 0 }
      : (
          await db
            .select({
              pending: sql<number>`count(*) filter (where ${dailyApplications.status} = 'PENDING')::int`,
              approved: sql<number>`count(*) filter (where ${dailyApplications.status} = 'APPROVED')::int`,
              newToDw: sql<number>`count(*) filter (where ${dailyApplications.dwMatch} = 'NEW')::int`,
              total: sql<number>`count(*)::int`,
            })
            .from(dailyApplications)
            .where(and(...pipelineFilters))
        )[0];

  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow={<SectionLabel>Recruitment Operations</SectionLabel>}
        title="Daily Application — Tiếp nhận & Xếp việc Tập nghề"
        description={
          scoped
            ? "Bộ lọc và danh sách chỉ hiển thị trong Data Scope được cấp cho tài khoản của bạn."
            : "Mặc định chỉ hiện DW hôm nay. Tick ô “Xem khoảng ngày” để tra cứu & xuất kết quả các ngày trước. Cột DW Data tự động đối chiếu 3 tầng (CCCD → Tên+Năm sinh → Tên+SĐT)."
        }
        actions={
          <>
            <Badge tone="gray">Sheet: Daily Application</Badge>
            {scoped ? (
              <Badge tone="purple" dot>Chế độ Quản lý bộ phận — chỉ bộ phận phân quyền</Badge>
            ) : (
              <>
                <Badge tone="gold" dot>Inline edit như Google Sheet</Badge>
                <Badge tone="green" dot>
                  Đối chiếu {(dw?.c ?? 0).toLocaleString("vi-VN")} DW Data
                </Badge>
              </>
            )}
          </>
        }
      />

      <MetricStrip
        items={[
          <MetricStripItem key="total" icon={<Zap className="h-4 w-4" aria-hidden />} value={pipeline?.total ?? 0} label="Tổng DW hôm nay" tone="primary" />,
          <MetricStripItem key="pending" icon={<Clock className="h-4 w-4" aria-hidden />} value={pipeline?.pending ?? 0} label="Chờ duyệt" tone="warning" />,
          <MetricStripItem key="approved" icon={<CheckCircle2 className="h-4 w-4" aria-hidden />} value={pipeline?.approved ?? 0} label="Đã nhận việc" tone="success" />,
          <MetricStripItem key="new" icon={<UserPlus2 className="h-4 w-4" aria-hidden />} value={pipeline?.newToDw ?? 0} label="Người mới (chưa có DW)" tone="accent" />,
          <MetricStripItem key="dw" icon={<Database className="h-4 w-4" aria-hidden />} value={dw ? dw.c.toLocaleString("vi-VN") : "—"} label={dw ? "Hồ sơ DW Data" : "DW Data ngoài scope"} tone="info" />,
        ]}
      />

      {scoped ? (
        <DailyApplicationScoped departments={depts} initialFrom={todayStr()} />
      ) : (
        <RegistrationsGrid departments={depts} canEdit />
      )}
    </div>
  );
}
