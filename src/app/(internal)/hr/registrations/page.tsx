import { redirect } from "next/navigation";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { dailyApplications, departments, dwData } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { todayStr } from "@/lib/helpers";
import RegistrationsGrid from "@/components/registrations-grid";

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
      <div className="grid grid-cols-3 gap-3">
        <div className="hasfarm-card rounded-[18px] bg-gradient-to-br from-amber-400 to-amber-600 p-4 text-white">
          <p className="text-[10px] font-black uppercase tracking-widest opacity-80">Chờ duyệt hôm nay</p>
          <p className="mt-1 text-3xl font-black leading-none">{pipeline?.pending ?? 0}</p>
        </div>
        <div className="hasfarm-card rounded-[18px] bg-gradient-to-br from-hasfarm-600 to-hasfarm-800 p-4 text-white">
          <p className="text-[10px] font-black uppercase tracking-widest opacity-80">Đã duyệt hôm nay</p>
          <p className="mt-1 text-3xl font-black leading-none">{pipeline?.approved ?? 0}</p>
        </div>
        <div className="hasfarm-card rounded-[18px] bg-gradient-to-br from-gold-400 to-gold-600 p-4 text-hasfarm-900">
          <p className="text-[10px] font-black uppercase tracking-widest opacity-80">Lao động mới</p>
          <p className="mt-1 text-3xl font-black leading-none">{pipeline?.newToDw ?? 0}</p>
        </div>
      </div>

      <div className="rounded-[20px] bg-white p-6 shadow-sm ring-1 ring-black/5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-hasfarm-700 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-white">
                Sheet: Daily Application
              </span>
              <span className="rounded-full bg-gold-500 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-hasfarm-900">
                Inline edit như Google Sheet
              </span>
              <span className="rounded-full bg-emerald-100 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-emerald-800">
                Đối chiếu {dw.c.toLocaleString("vi-VN")} DW Data
              </span>
            </div>
            <h1 className="mt-3 text-[26px] font-black tracking-tight text-hasfarm-900">
              Sắp xếp công việc theo ngày
            </h1>
            <p className="mt-2 max-w-[85ch] text-sm leading-relaxed text-gray-600">
              Màn hình mặc định <b>chỉ hiện đơn hôm nay</b> cho tinh gọn. Tick ô{" "}
              <b>&ldquo;Xem khoảng ngày&rdquo;</b> để tra cứu &amp; xuất kết quả các ngày trước làm tham khảo.
              Cột <b>DW Data</b> tự động đối chiếu 3 tầng (CCCD → Tên+Năm sinh → Tên+SĐT) để xác định lao động
              CŨ hay MỚI, không phụ thuộc vào lời tự khai. Dấu ⚠️ cảnh báo người khai &ldquo;đã từng làm&rdquo;
              nhưng không tìm thấy trong DW Data.
            </p>
          </div>
          <div className="rounded-2xl bg-[#0F3D23] p-4 text-white shadow">
            <p className="text-[11px] font-bold uppercase tracking-widest text-white/60">Quy tắc mới</p>
            <p className="mt-1 text-[12px] font-bold leading-relaxed text-gold-200">
              • CCCD bắt buộc 100%
              <br />• Tối đa 500 hồ sơ / lần import
              <br />• RBAC kiểm tra từng API request
            </p>
          </div>
        </div>
      </div>

      <RegistrationsGrid departments={depts} canEdit />
    </div>
  );
}
