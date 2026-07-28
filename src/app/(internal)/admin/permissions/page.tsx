"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui";
import { Loader2 } from "lucide-react";

type Perm = { role: string; permissionKey: string; allowed: boolean };
type PermKey = { key: string; label: string };

export default function PermissionsPage() {
  const [perms, setPerms] = useState<Perm[]>([]);
  const [keys, setKeys] = useState<PermKey[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/admin/permissions");
    const data = await res.json();
    setPerms(data.rows ?? []);
    setKeys(data.keys ?? []);
    setRoles(data.roles ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const isAllowed = (role: string, key: string) => {
    const p = perms.find((x) => x.role === role && x.permissionKey === key);
    return p ? p.allowed : true; // chưa cấu hình = mặc định cho phép
  };

  const toggle = async (role: string, key: string) => {
    const next = !isAllowed(role, key);
    setPerms((prev) => {
      const others = prev.filter((p) => !(p.role === role && p.permissionKey === key));
      return [...others, { role, permissionKey: key, allowed: next }];
    });
    await fetch("/api/admin/permissions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role, permissionKey: key, allowed: next }),
    });
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-black text-hasfarm-900">Phân quyền chi tiết (RBAC nâng cao)</h1>
        <p className="text-sm text-gray-500">
          Lớp phân quyền BỔ SUNG, hoạt động song song với 3 Role gốc (không thay thế) — tắt 1 ô ở đây sẽ chặn thêm
          chức năng đó cho Role tương ứng ở những màn hình đã kiểm tra quyền chi tiết. Chưa cấu hình = mặc định vẫn
          theo đúng quyền Role gốc như trước.
        </p>
      </div>

      <Card className="p-0">
        <CardHeader title="Ma trận quyền" />
        <CardContent className="overflow-x-auto p-0">
          {loading ? (
            <div className="p-10 text-center">
              <Loader2 className="mx-auto h-6 w-6 animate-spin text-hasfarm-600" />
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-hasfarm-50 text-hasfarm-800">
                <tr>
                  <th className="px-3 py-2 text-left text-[11px] uppercase">Chức năng</th>
                  {roles.map((r) => (
                    <th key={r} className="px-3 py-2 text-center text-[11px] uppercase">
                      {r}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.key} className="border-t">
                    <td className="px-3 py-2 font-semibold">{k.label}</td>
                    {roles.map((r) => (
                      <td key={r} className="px-3 py-2 text-center">
                        <button
                          onClick={() => toggle(r, k.key)}
                          className={`h-6 w-11 rounded-full transition ${isAllowed(r, k.key) ? "bg-emerald-500" : "bg-gray-300"}`}
                        >
                          <span
                            className={`block h-5 w-5 translate-x-0.5 rounded-full bg-white shadow transition ${
                              isAllowed(r, k.key) ? "translate-x-[22px]" : ""
                            }`}
                          />
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
