import { redirect } from "next/navigation";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { db } from "@/db";
import { dailyApplications, departments } from "@/db/schema";
import { getSession, getUserScope } from "@/lib/auth";
import { Badge, Card, CardContent } from "@/components/ui";
import { formatDate, todayStr } from "@/lib/helpers";

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
        <CardContent className="p-8 text-center text-sm text-gray-500">
          Tài khoản chưa được gán bộ phận nào. Vui lòng liên hệ Quản trị viên (mục Phân quyền → Data Scope).
        </CardContent>
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
      <div className="rounded-[20px] bg-white p-6 shadow-sm ring-1 ring-black/5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <span className="rounded-full bg-hasfarm-700 px-3 py-1 text-[10px] font-black uppercase tracking-widest text-white">
              Cổng bộ phận nhận lao động
            </span>
            <h1 className="mt-3 text-[26px] font-black tracking-tight text-hasfarm-900">{label}</h1>
            <p className="text-sm text-gray-600">
              {dept?.vnName} · Phụ trách: <b>{dept?.supervisor ?? "—"}</b>
              {dept?.supervisorPhone ? ` · ${dept.supervisorPhone}` : ""}
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <form className="flex flex-wrap items-end gap-2">
              {visibleDepts.length > 1 && (
                <select
                  name="dept"
                  defaultValue={deptId}
                  className="h-10 max-w-[240px] rounded-xl border-2 border-gray-200 px-2 text-sm font-bold"
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
                <p className="mb-1 text-[10px] font-black uppercase text-gray-400">Từ ngày</p>
                <input
                  type="date"
                  name="from"
                  defaultValue={from}
                  className="h-10 rounded-xl border-2 border-gray-200 px-2 text-sm font-bold"
                />
              </div>
              <div>
                <p className="mb-1 text-[10px] font-black uppercase text-gray-400">Đến ngày</p>
                <input
                  type="date"
                  name="to"
                  defaultValue={to}
                  className="h-10 rounded-xl border-2 border-gray-200 px-2 text-sm font-bold"
                />
              </div>
              <button className="h-10 rounded-xl bg-hasfarm-700 px-4 text-sm font-black text-white">Xem</button>
            </form>
            <a
              href={`/api/export?from=${from}&to=${to}&deptId=${deptId}`}
              className="inline-flex h-10 items-center rounded-xl bg-gold-500 px-4 text-sm font-black text-hasfarm-900 shadow-[0_6px_16px_rgba(217,163,39,0.35)] hover:bg-gold-400"
            >
              📊 Tải Excel gửi Zalo
            </a>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { l: "Lao động nhận", v: rows.length, c: "bg-[#0F3D23] text-white" },
          { l: "Định mức/ngày", v: dept?.dailyQuota ?? 0, c: "bg-gold-500 text-hasfarm-900" },
          { l: "Người mới", v: newCount, c: "bg-amber-500 text-amber-950" },
          {
            l: "Tỷ lệ lấp đầy",
            v: dept?.dailyQuota ? `${Math.round((rows.length / dept.dailyQuota) * 100)}%` : "—",
            c: "bg-emerald-600 text-white",
          },
        ].map((k) => (
          <div key={k.l} className={`rounded-[18px] p-4 shadow ${k.c}`}>
            <p className="text-[10px] font-black uppercase tracking-widest opacity-70">{k.l}</p>
            <p className="mt-1 text-[28px] font-black leading-none">{k.v}</p>
          </div>
        ))}
      </div>

      <Card className="overflow-hidden rounded-[18px] border border-black/5 p-0 shadow-sm">
        <div className="border-b bg-hasfarm-50 px-4 py-3">
          <p className="text-[11px] font-black uppercase tracking-widest text-hasfarm-800">
            Danh sách {formatDate(from)}
            {from !== to ? ` → ${formatDate(to)}` : ""}
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="grid-sheet w-full text-[13px]">
            <thead className="bg-[#0F3D23] text-white">
              <tr>
                {["#", "Ngày", "CCCD", "Họ và tên", "Giới tính", "Tuổi", "SĐT", "Địa chỉ", "Loại"].map((h) => (
                  <th key={h} className="px-3 py-2.5 text-left text-[10px] font-black uppercase tracking-widest">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={9} className="p-10 text-center text-gray-400">
                    Chưa có lao động nào được xếp cho bộ phận này.
                  </td>
                </tr>
              )}
              {rows.map((r, i) => (
                <tr key={r.id} className="hover:bg-hasfarm-50/60">
                  <td className="px-3 py-2">{i + 1}</td>
                  <td className="px-3 py-2 text-xs text-gray-500">{formatDate(r.regDate)}</td>
                  <td className="px-3 py-2 font-mono font-bold">{r.cccd}</td>
                  <td className="px-3 py-2 font-bold text-hasfarm-900">{r.fullName}</td>
                  <td className="px-3 py-2 text-center">{r.gender ?? "—"}</td>
                  <td className="px-3 py-2 text-center font-bold">{r.age ?? "—"}</td>
                  <td className="px-3 py-2">
                    <a href={`tel:${r.phone}`} className="font-bold text-hasfarm-700 hover:underline">
                      {r.phone}
                    </a>
                  </td>
                  <td className="max-w-[260px] truncate px-3 py-2 text-gray-600">
                    {r.residentialAddress ?? r.permanentAddress ?? "—"}
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={r.dwMatch === "NEW" ? "amber" : "green"}>
                      {r.dwMatch === "NEW" ? "Mới" : "Cũ"}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
