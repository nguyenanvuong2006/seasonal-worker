import { redirect } from "next/navigation";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { db } from "@/db";
import { dailyApplications, departments } from "@/db/schema";
import { getSession, getUserScope } from "@/lib/auth";
import { Badge, Card, CardContent, EmptyState, KpiCard } from "@/components/ui";
import { formatDate, todayStr } from "@/lib/helpers";
import { Download, Percent, Target, UserPlus2, Users } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function DepartmentPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; dept?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  const params = await searchParams;
  const from = params.from ?? todayStr();
  const to = params.to ?? from;

  const allDepts = await db
    .select()
    .from(departments)
    .where(eq(departments.isActive, true))
    .orderBy(asc(departments.deptName), asc(departments.groupName));

  // RBAC + DATA SCOPE (Phase 2, Step 1) — scope=null nghĩa là không giới hạn (ADMIN/HR_RECRUITER);
  // DEPT_MANAGER chỉ thấy các bộ phận được gán ở /admin/data-scopes (nhiều bộ phận cùng lúc).
  const scope = await getUserScope(session);
  const visibleDepts = scope ? allDepts.filter((d) => scope.includes(d.id)) : allDepts;

  let deptId = params.dept && visibleDepts.some((d) => d.id === params.dept) ? params.dept : visibleDepts[0]?.id ?? null;

  if (!deptId) {
    return (
      <Card>
        <EmptyState
          icon={<Users className="h-5 w-5" aria-hidden />}
          title="Chưa được gán bộ phận nào"
          description="Vui lòng liên hệ Quản trị viên (mục Phân quyền → Data Scope) để được gán bộ phận."
        />
      </Card>
    );
  }

  const dept = allDepts.find((d) => d.id === deptId);
  const label = dept ? `${dept.deptName}${dept.groupName ? " — " + dept.groupName : ""}` : "Bộ phận";

  const rows = await db
    .select()
    .from(dailyApplications)
    .where(
      and(
        eq(dailyApplications.deptId, deptId),
        gte(dailyApplications.regDate, from),
        lte(dailyApplications.regDate, to),
        eq(dailyApplications.status, "APPROVED"),
      ),
    )
    .orderBy(asc(dailyApplications.fullName));

  const newCount = rows.filter((r) => r.dwMatch === "NEW").length;

  return (
    <div className="space-y-5">
      <Card className="p-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <Badge tone="gray">Cổng bộ phận nhận lao động</Badge>
            <h1 className="mt-3 text-[24px] font-bold tracking-tight text-fg">{label}</h1>
            <p className="text-sm text-fg-secondary">
              {dept?.vnName} · Phụ trách: <b className="text-fg">{dept?.supervisor ?? "—"}</b>
              {dept?.supervisorPhone ? ` · ${dept.supervisorPhone}` : ""}
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <form className="flex flex-wrap items-end gap-2">
              {visibleDepts.length > 1 && (
                <select
                  name="dept"
                  defaultValue={deptId}
                  className="h-10 max-w-[240px] rounded-[10px] border border-border-strong bg-surface px-3 text-sm font-medium text-fg outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
                >
                  {visibleDepts.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.deptName}
                      {d.groupName ? ` — ${d.groupName}` : ""}
                    </option>
                  ))}
                </select>
              )}
              <div>
                <p className="mb-1 text-[11px] font-semibold text-fg-muted">Từ ngày</p>
                <input
                  type="date"
                  name="from"
                  defaultValue={from}
                  className="h-10 rounded-[10px] border border-border-strong bg-surface px-3 text-sm font-medium text-fg outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
                />
              </div>
              <div>
                <p className="mb-1 text-[11px] font-semibold text-fg-muted">Đến ngày</p>
                <input
                  type="date"
                  name="to"
                  defaultValue={to}
                  className="h-10 rounded-[10px] border border-border-strong bg-surface px-3 text-sm font-medium text-fg outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
                />
              </div>
              <button className="h-10 rounded-[10px] bg-primary px-4 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-primary-hover">
                Xem
              </button>
            </form>
            <a
              href={`/api/export?from=${from}&to=${to}&deptId=${deptId}`}
              className="inline-flex h-10 items-center gap-1.5 rounded-[10px] bg-primary px-4 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-primary-hover"
            >
              <Download className="h-4 w-4" /> Tải Excel gửi Zalo
            </a>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard icon={<Users className="h-4 w-4" />} label="Lao động nhận" value={rows.length} tone="primary" />
        <KpiCard icon={<Target className="h-4 w-4" />} label="Định mức/ngày" value={dept?.dailyQuota ?? 0} tone="warning" />
        <KpiCard icon={<UserPlus2 className="h-4 w-4" />} label="Người mới" value={newCount} tone="info" />
        <KpiCard
          icon={<Percent className="h-4 w-4" />}
          label="Tỷ lệ lấp đầy"
          value={dept?.dailyQuota ? `${Math.round((rows.length / dept.dailyQuota) * 100)}%` : "—"}
          tone="success"
        />
      </div>

      <Card className="overflow-hidden p-0">
        <div className="border-b border-border px-4 py-3">
          <p className="text-[13px] font-semibold text-fg">
            Danh sách {formatDate(from)}
            {from !== to ? ` → ${formatDate(to)}` : ""}
          </p>
        </div>
        {rows.length === 0 ? (
          <EmptyState
            icon={<Users className="h-5 w-5" aria-hidden />}
            title="Chưa có lao động nào"
            description="Chưa có lao động nào được xếp cho bộ phận này trong khoảng thời gian đã chọn."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="grid-sheet w-full text-[13px]">
              <thead className="bg-primary text-white">
                <tr>
                  {["#", "Ngày", "CCCD", "Họ và tên", "Giới tính", "Tuổi", "SĐT", "Địa chỉ", "Loại"].map((h) => (
                    <th key={h} className="px-3 py-2.5 text-left text-[10.5px] font-semibold uppercase tracking-wide">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.id} className="border-b border-border transition-colors hover:bg-surface-hover">
                    <td className="px-3 py-2 text-fg-muted">{i + 1}</td>
                    <td className="px-3 py-2 text-xs text-fg-muted">{formatDate(r.regDate)}</td>
                    <td className="px-3 py-2 font-mono font-semibold text-fg">{r.cccd}</td>
                    <td className="px-3 py-2 font-semibold text-fg">{r.fullName}</td>
                    <td className="px-3 py-2 text-center text-fg-secondary">{r.gender ?? "—"}</td>
                    <td className="px-3 py-2 text-center font-semibold text-fg-secondary">{r.age ?? "—"}</td>
                    <td className="px-3 py-2">
                      <a href={`tel:${r.phone}`} className="font-semibold text-primary hover:underline">
                        {r.phone}
                      </a>
                    </td>
                    <td className="max-w-[260px] truncate px-3 py-2 text-fg-secondary">
                      {r.residentialAddress ?? r.permanentAddress ?? "—"}
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={r.dwMatch === "NEW" ? "amber" : "green"} dot>
                        {r.dwMatch === "NEW" ? "Mới" : "Cũ"}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
