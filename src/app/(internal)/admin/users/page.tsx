"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  Input,
  Label,
  Modal,
  toast,
} from "@/components/ui";
import { ROLE_LABEL } from "@/lib/helpers";
import { Loader2 } from "lucide-react";

type UserRow = {
  id: string;
  username: string;
  fullName: string;
  role: string;
  deptId: string | null;
  deptName: string | null;
  isActive: boolean;
};

type Dept = { id: string; name: string };

export default function UsersAdminPage() {
  const [rows, setRows] = useState<UserRow[]>([]);
  const [depts, setDepts] = useState<Dept[]>([]);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [open, setOpen] = useState(false);
  const [pwUser, setPwUser] = useState<UserRow | null>(null);
  const [newPw, setNewPw] = useState("");
  const [form, setForm] = useState({
    username: "",
    password: "",
    fullName: "",
    role: "DEPT_MANAGER",
    deptId: "",
  });

  const load = useCallback(async () => {
    setLoading(true);
    const [uRes, dRes] = await Promise.all([fetch("/api/users"), fetch("/api/departments")]);
    if (uRes.status === 403 || uRes.status === 401) {
      setDenied(true);
      setLoading(false);
      return;
    }
    const uData = await uRes.json();
    const dData = await dRes.json();
    setRows(uData.rows ?? []);
    setDepts(dData.rows ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    const res = await fetch("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    const data = await res.json();
    if (!res.ok) {
      toast({ title: data.error ?? "Lỗi tạo tài khoản", variant: "destructive" });
      return;
    }
    toast({ title: "✅ Đã tạo tài khoản" });
    setOpen(false);
    setForm({ username: "", password: "", fullName: "", role: "DEPT_MANAGER", deptId: "" });
    await load();
  };

  const patch = async (id: string, body: Record<string, unknown>) => {
    const res = await fetch("/api/users", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...body }),
    });
    if (!res.ok) {
      const d = await res.json();
      toast({ title: d.error ?? "Lưu thất bại", variant: "destructive" });
    }
    await load();
  };

  if (denied) {
    return (
      <Card>
        <CardContent className="p-10 text-center font-bold text-red-600">
          Từ chối truy cập! Chỉ Quản trị viên mới xem được trang này.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black text-hasfarm-900">Tài khoản & phân quyền (RBAC)</h1>
          <p className="text-sm text-gray-500">
            Cấp quyền cho HR tuyển dụng và quản đốc từng xưởng.
          </p>
        </div>
        <Button variant="gold" onClick={() => setOpen(true)}>
          + Tạo tài khoản
        </Button>
      </div>

      <Card className="p-0">
        <CardHeader title="Danh sách người dùng nội bộ" />
        <CardContent className="p-0">
          {loading ? (
            <div className="p-10 text-center">
              <Loader2 className="mx-auto h-6 w-6 animate-spin text-hasfarm-600" />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="grid-sheet w-full text-sm">
                <thead className="bg-hasfarm-50 text-hasfarm-800">
                  <tr>
                    <th className="px-3 py-2 text-left text-[11px] uppercase">Tài khoản</th>
                    <th className="px-3 py-2 text-left text-[11px] uppercase">Họ tên</th>
                    <th className="px-3 py-2 text-left text-[11px] uppercase">Vai trò</th>
                    <th className="px-3 py-2 text-left text-[11px] uppercase">Bộ phận</th>
                    <th className="px-3 py-2 text-left text-[11px] uppercase">Trạng thái</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((u) => (
                    <tr key={u.id} className="hover:bg-hasfarm-50/50">
                      <td className="px-3 py-2 font-mono font-bold">{u.username}</td>
                      <td className="px-3 py-2">{u.fullName}</td>
                      <td className="px-3 py-2">
                        <select
                          value={u.role}
                          onChange={(e) => void patch(u.id, { role: e.target.value })}
                          className="rounded border-2 border-gray-200 px-2 py-1 text-xs font-bold"
                        >
                          {Object.entries(ROLE_LABEL).map(([k, v]) => (
                            <option key={k} value={k}>
                              {v}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        <select
                          value={u.deptId ?? ""}
                          onChange={(e) => void patch(u.id, { deptId: e.target.value || null })}
                          className="rounded border-2 border-gray-200 px-2 py-1 text-xs"
                        >
                          <option value="">—</option>
                          {depts.map((d) => (
                            <option key={d.id} value={d.id}>
                              {d.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-2">
                        <button onClick={() => void patch(u.id, { isActive: !u.isActive })}>
                          <Badge tone={u.isActive ? "green" : "gray"}>
                            {u.isActive ? "Hoạt động" : "Đã khoá"}
                          </Badge>
                        </button>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          onClick={() => {
                            setPwUser(u);
                            setNewPw("");
                          }}
                          className="text-xs font-bold text-hasfarm-700 hover:underline"
                        >
                          Đổi mật khẩu
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Modal open={open} onClose={() => setOpen(false)} title="Tạo tài khoản nội bộ">
        <div className="space-y-3">
          <div>
            <Label>Tên đăng nhập *</Label>
            <Input
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value.toLowerCase() })}
              className="h-11 font-mono"
              placeholder="hr.tuyendung"
            />
          </div>
          <div>
            <Label>Mật khẩu * (tối thiểu 6 ký tự)</Label>
            <Input
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              className="h-11"
              type="text"
            />
          </div>
          <div>
            <Label>Họ và tên</Label>
            <Input
              value={form.fullName}
              onChange={(e) => setForm({ ...form, fullName: e.target.value })}
              className="h-11"
            />
          </div>
          <div>
            <Label>Vai trò</Label>
            <select
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
              className="h-11 w-full rounded-xl border-2 border-gray-200 px-2 font-semibold"
            >
              {Object.entries(ROLE_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>
          {form.role === "DEPT_MANAGER" && (
            <div>
              <Label>Bộ phận phụ trách</Label>
              <select
                value={form.deptId}
                onChange={(e) => setForm({ ...form, deptId: e.target.value })}
                className="h-11 w-full rounded-xl border-2 border-gray-200 px-2 font-semibold"
              >
                <option value="">— Chọn bộ phận —</option>
                {depts.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <Button variant="gold" size="lg" className="w-full" onClick={create}>
            Tạo tài khoản
          </Button>
        </div>
      </Modal>

      <Modal
        open={!!pwUser}
        onClose={() => setPwUser(null)}
        title={`Đổi mật khẩu: ${pwUser?.username ?? ""}`}
      >
        <div className="space-y-3">
          <Label>Mật khẩu mới</Label>
          <Input value={newPw} onChange={(e) => setNewPw(e.target.value)} className="h-11" />
          <Button
            variant="gold"
            size="lg"
            className="w-full"
            onClick={async () => {
              if (!pwUser) return;
              await patch(pwUser.id, { password: newPw });
              toast({ title: "🔐 Đã cập nhật mật khẩu" });
              setPwUser(null);
            }}
          >
            Cập nhật
          </Button>
        </div>
      </Modal>
    </div>
  );
}
