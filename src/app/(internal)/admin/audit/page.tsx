import { redirect } from "next/navigation";
import { desc } from "drizzle-orm";
import { db } from "@/db";
import { auditLogs } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { Card, CardContent, CardHeader } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function AuditPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "ADMIN") redirect("/hr/registrations");

  const rows = await db
    .select()
    .from(auditLogs)
    .orderBy(desc(auditLogs.createdAt))
    .limit(200);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-black text-hasfarm-900">Nhật ký hệ thống (Audit Log)</h1>
        <p className="text-sm text-gray-500">
          Ghi nhận mọi thao tác duyệt, sửa và gộp hồ sơ của nhân sự nội bộ.
        </p>
      </div>

      <Card className="p-0">
        <CardHeader title="200 hoạt động gần nhất" />
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="grid-sheet w-full text-sm">
              <thead className="bg-hasfarm-50 text-hasfarm-800">
                <tr>
                  <th className="px-3 py-2 text-left text-[11px] uppercase">Thời gian</th>
                  <th className="px-3 py-2 text-left text-[11px] uppercase">Người thực hiện</th>
                  <th className="px-3 py-2 text-left text-[11px] uppercase">Hành động</th>
                  <th className="px-3 py-2 text-left text-[11px] uppercase">Đối tượng</th>
                  <th className="px-3 py-2 text-left text-[11px] uppercase">Chi tiết</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={5} className="p-10 text-center text-gray-400">
                      Chưa có hoạt động nào được ghi nhận.
                    </td>
                  </tr>
                )}
                {rows.map((r) => (
                  <tr key={r.id} className="hover:bg-hasfarm-50/50">
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-gray-500">
                      {new Date(r.createdAt).toLocaleString("vi-VN")}
                    </td>
                    <td className="px-3 py-2 font-bold">{r.username ?? "—"}</td>
                    <td className="px-3 py-2 font-mono text-xs text-hasfarm-800">{r.action}</td>
                    <td className="px-3 py-2 text-xs">{r.targetType}</td>
                    <td className="max-w-[380px] truncate px-3 py-2 text-xs text-gray-500">
                      {JSON.stringify(r.details)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
