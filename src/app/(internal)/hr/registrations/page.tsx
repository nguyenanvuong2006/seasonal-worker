import { redirect } from "next/navigation";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { dailyApplications, departments, dwData } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { todayStr } from "@/lib/helpers";
import RegistrationsGrid from "@/components/registrations-grid";
import { Badge, KpiCard, PageHeader } from "@/components/ui";
import { CheckCircle2, Clock, UserPlus2 } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function HrRegistrationsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!["ADMIN", "HR_RECRUITER"].includes(session.role)) redirect("/department");

  const depts = await db
    .select({
      id: departments.id,
      deptName: departments.deptName,
      groupName: departments.groupName,
      vnName: departments.vnName,
      dailyQuota: departments.dailyQuota,
    })
    .from(departments)
    .where(eq(departments.isActive, true))
    .orderBy(asc(departments.deptName), asc(departments.groupName));

  const [dw] = await db.select({ c: sql<number>`count(*)::int` }).from(dwData);

  // RECRUITER PIPELINE (cá nhân hoá theo vai trò) — số liệu hôm nay để HR nắm nhanh khối lượng việc.
  const [pipeline] = await db
    .select({
      pending: sql<number>`count(*) filter (where ${dailyApplications.status} = 'PENDING')::int`,
      approved: sql<number>`count(*) filter (where ${dailyApplications.status} = 'APPROVED')::int`,
      newToDw: sql<number>`count(*) filter (where ${dailyApplications.dwMatch} = 'NEW')::int`,
    })
    .from(dailyApplications)
    .where(and(eq(dailyApplications.regDate, todayStr()), sql`${dailyApplications.deletedAt} is null`));

  return (
    <div className="space-y-5">
      <PageHeader
        title="Tiếp nhận & Xếp việc Tập nghề theo ngày"
        description={
          <>
            Màn hình mặc định <b>chỉ hiện đơn hôm nay</b>. Tick ô <b>&ldquo;Xem khoảng ngày&rdquo;</b> để tra cứu &amp; xuất
            kết quả các ngày trước làm tham khảo. Cột <b>DW Data</b> tự động đối chiếu 3 tầng (CCCD → Tên+Năm sinh →
            Tên+SĐT) để xác định người tập nghề CŨ hay MỚI, không phụ thuộc vào lời tự khai.
          </>
        }
        actions={
          <>
            <Badge tone="gray">Sheet: Daily Application</Badge>
            <Badge tone="gold">Inline edit như Google Sheet</Badge>
            <Badge tone="green">Đối chiếu {dw.c.toLocaleString("vi-VN")} DW Data</Badge>
          </>
        }
      />

      <div className="grid grid-cols-3 gap-3">
        <KpiCard icon={<Clock className="h-4 w-4" />} label="Chờ duyệt hôm nay" value={pipeline?.pending ?? 0} tone="warning" />
        <KpiCard icon={<CheckCircle2 className="h-4 w-4" />} label="Đã nhận việc hôm nay" value={pipeline?.approved ?? 0} tone="success" />
        <KpiCard icon={<UserPlus2 className="h-4 w-4" />} label="Người tập nghề mới" value={pipeline?.newToDw ?? 0} tone="info" />
      </div>

      <RegistrationsGrid departments={depts} canEdit />
    </div>
  );
}
