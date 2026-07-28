"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Card, CardContent, CardHeader, toast } from "@/components/ui";
import { Loader2 } from "lucide-react";

type UserRow = { id: string; username: string; fullName: string; role: string };
type Dept = { id: string; deptName: string; groupName: string | null };
type Scope = { userId: string; departmentId: string };

export default function DataScopesPage() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [depts, setDepts] = useState<Dept[]>([]);
  const [scopes, setScopes] = useState<Scope[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/admin/data-scopes");
    const d = await res.json();
    setUsers(d.users ?? []);
    setDepts(d.departments ?? []);
    setScopes(d.scopes ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const has = (userId: string, departmentId: string) => scopes.some((s) => s.userId === userId && s.departmentId === departmentId);

  const toggle = async (userId: string, departmentId: string) => {
    const currentlyHas = has(userId, departmentId);
    setScopes((prev) => (currentlyHas ? prev.filter((s) => !(s.userId === userId && s.departmentId === departmentId)) : [...prev, { userId, departmentId }]));
    const res = currentlyHas
      ? await fetch(`/api/admin/data-scopes?userId=${userId}&departmentId=${departmentId}`, { method: "DELETE" })
      : await fetch("/api/admin/data-scopes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId, departmentId }) });
    if (!res.ok) {
      toast({ title: "Lưu thất bại", variant: "destructive" });
      await load();
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-black text-hasfarm-900">Data Scope — Quản lý theo bộ phận</h1>
        <p className="text-sm text-gray-500">
          Chỉ áp dụng cho Role <Badge tone="gray">DEPT_MANAGER</Badge>. 1 Manager có thể quản lý NHIỀU bộ phận cùng
          lúc (vd Packing A + Packing B + Packing C) — tick chọn bên dưới. ADMIN/HR_RECRUITER luôn xem được toàn bộ,
          không cần cấu hình ở đây.
        </p>
      </div>

      <Card className="p-0">
        <CardHeader title="Ma trận User ↔ Bộ phận" />
        <CardContent className="overflow-x-auto p-0">
          {loading ? (
            <div className="p-10 text-center">
              <Loader2 className="mx-auto h-6 w-6 animate-spin text-hasfarm-600" />
            </div>
          ) : users.length === 0 ? (
            <p className="p-8 text-center text-sm text-gray-400">Chưa có tài khoản nào có Role DEPT_MANAGER.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-hasfarm-50 text-hasfarm-800">
                <tr>
                  <th className="px-3 py-2 text-left text-[11px] uppercase">Tài khoản</th>
                  {depts.map((d) => (
                    <th key={d.id} className="px-3 py-2 text-center text-[11px] uppercase">
                      {d.deptName}
                      {d.groupName ? <span className="block font-normal normal-case text-gray-400">{d.groupName}</span> : null}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="border-t">
                    <td className="px-3 py-2 font-semibold">
                      {u.fullName} <span className="text-xs text-gray-400">({u.username})</span>
                    </td>
                    {depts.map((d) => (
                      <td key={d.id} className="px-3 py-2 text-center">
                        <button
                          onClick={() => toggle(u.id, d.id)}
                          className={`h-6 w-11 rounded-full transition ${has(u.id, d.id) ? "bg-emerald-500" : "bg-gray-300"}`}
                        >
                          <span className={`block h-5 w-5 translate-x-0.5 rounded-full bg-white shadow transition ${has(u.id, d.id) ? "translate-x-[22px]" : ""}`} />
                        </button>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
