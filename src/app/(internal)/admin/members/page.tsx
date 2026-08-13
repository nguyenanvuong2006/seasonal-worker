"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, CardContent, CardHeader, Input, Label, Modal, toast } from "@/components/ui";
import { ROLE_LABEL } from "@/lib/helpers";
import { Loader2, Pencil, ShieldAlert, Trash2, UserCog } from "lucide-react";

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
type EditForm = { fullName: string; role: string; deptId: string; isActive: boolean };

export default function MembersAdminPage() {
  const [rows, setRows] = useState<UserRow[]>([]);
  const [depts, setDepts] = useState<Dept[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editUser, setEditUser] = useState<UserRow | null>(null);
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [deleteUser, setDeleteUser] = useState<UserRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [uRes, dRes, pRes] = await Promise.all([
      fetch("/api/users"),
      fetch("/api/departments"),
      fetch("/api/profile"),
    ]);
    if (uRes.status === 401 || uRes.status === 403) {
      setDenied(true);
      setLoading(false);
      return;
    }
    const [uData, dData, pData] = await Promise.all([uRes.json(), dRes.json(), pRes.json()]);
    setRows(uData.rows ?? []);
    setDepts(dData.rows ?? []);
    setCurrentUserId(pData.profile?.id ?? null);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openEdit = (user: UserRow) => {
    setEditUser(user);
    setEditForm({
      fullName: user.fullName,
      role: user.role,
      deptId: user.deptId ?? "",
      isActive: user.isActive,
    });
  };

  const saveEdit = async () => {
    if (!editUser || !editForm) return;
    if (editUser.id === currentUserId && (!editForm.isActive || editForm.role !== "ADMIN")) {
      toast({
        title: "Không thể tự khóa hoặc tự hạ quyền tài khoản Admin đang đăng nhập.",
        variant: "destructive",
      });
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: editUser.id,
          fullName: editForm.fullName,
          role: editForm.role,
          deptId: editForm.role === "DEPT_MANAGER" ? editForm.deptId || null : null,
          isActive: editForm.isActive,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast({ title: data.error ?? "Lưu thất bại", variant: "destructive" });
        return;
      }
      toast({ title: "Đã cập nhật thông tin thành viên" });
      setEditUser(null);
      setEditForm(null);
      await load();
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!deleteUser) return;
    if (deleteUser.id === currentUserId) {
      toast({ title: "Không thể tự xóa tài khoản đang đăng nhập.", variant: "destructive" });
      setDeleteUser(null);
      return;
    }

    setSaving(true);
    try {
      const res = await fetch(`/api/users?id=${encodeURIComponent(deleteUser.id)}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        toast({ title: data.error ?? "Xóa tài khoản thất bại", variant: "destructive" });
        return;
      }
      toast({ title: `Đã xóa tài khoản ${deleteUser.username}` });
      setDeleteUser(null);
      await load();
    } finally {
      setSaving(false);
    }
  };

  if (denied) {
    return (
      <Card>
        <CardContent className="p-10 text-center font-bold text-danger">
          Từ chối truy cập! Chỉ Quản trị viên mới xem được trang này.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-black uppercase tracking-[0.16em] text-accent">Quản trị hệ thống</p>
          <h1 className="mt-1 text-2xl font-black text-fg">Quản lý thành viên</h1>
          <p className="mt-1 text-sm text-fg-secondary">Sửa thông tin, quyền, trạng thái hoặc xóa tài khoản nội bộ.</p>
        </div>
        <Button variant="outline" onClick={() => window.location.assign("/admin/users")}>Tạo tài khoản / Đổi mật khẩu</Button>
      </div>

      <div className="flex items-start gap-3 rounded-2xl border border-warning/20 bg-warning-tint/60 p-4 text-sm text-fg-secondary">
        <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
        <div>
          <p className="font-bold text-fg">Đã loại bỏ thao tác khóa tài khoản bằng một cú nhấn.</p>
          <p className="mt-1 text-xs leading-5">Trạng thái chỉ thay đổi bên trong cửa sổ <b>Sửa thành viên</b> và phải bấm <b>Lưu thay đổi</b>. Tài khoản đang đăng nhập cũng không thể tự khóa hoặc tự xóa tại màn hình này.</p>
        </div>
      </div>

      <Card className="p-0">
        <CardHeader title="Danh sách thành viên được phân quyền" />
        <CardContent className="p-0">
          {loading ? (
            <div className="p-10 text-center"><Loader2 className="mx-auto h-6 w-6 animate-spin text-primary" /></div>
          ) : (
            <div className="overflow-x-auto">
              <table className="grid-sheet w-full text-sm">
                <thead className="bg-primary-tint text-primary">
                  <tr>
                    <th className="px-3 py-2 text-left text-[11px] uppercase">Tài khoản</th>
                    <th className="px-3 py-2 text-left text-[11px] uppercase">Họ tên</th>
                    <th className="px-3 py-2 text-left text-[11px] uppercase">Vai trò</th>
                    <th className="px-3 py-2 text-left text-[11px] uppercase">Bộ phận</th>
                    <th className="px-3 py-2 text-left text-[11px] uppercase">Trạng thái</th>
                    <th className="px-3 py-2 text-right text-[11px] uppercase">Thao tác</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((user) => {
                    const isSelf = user.id === currentUserId;
                    return (
                      <tr key={user.id} className="hover:bg-primary-tint/50">
                        <td className="px-3 py-2 font-mono font-bold">
                          {user.username}
                          {isSelf ? <span className="ml-2 rounded-full bg-accent-tint px-2 py-0.5 text-[9px] font-bold text-accent">Bạn</span> : null}
                        </td>
                        <td className="px-3 py-2">{user.fullName}</td>
                        <td className="px-3 py-2"><Badge tone={user.role === "ADMIN" ? "amber" : user.role === "HR_RECRUITER" ? "green" : "gray"}>{ROLE_LABEL[user.role as keyof typeof ROLE_LABEL] ?? user.role}</Badge></td>
                        <td className="px-3 py-2 text-fg-secondary">{user.deptName || "—"}</td>
                        <td className="px-3 py-2"><Badge tone={user.isActive ? "green" : "gray"}>{user.isActive ? "Hoạt động" : "Đã khóa"}</Badge></td>
                        <td className="px-3 py-2">
                          <div className="flex justify-end gap-3 whitespace-nowrap">
                            <button onClick={() => openEdit(user)} className="inline-flex items-center gap-1 text-xs font-bold text-primary hover:underline"><Pencil className="h-3.5 w-3.5" /> Sửa</button>
                            <button disabled={isSelf} onClick={() => setDeleteUser(user)} className="inline-flex items-center gap-1 text-xs font-bold text-danger hover:underline disabled:cursor-not-allowed disabled:opacity-30"><Trash2 className="h-3.5 w-3.5" /> Xóa</button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Modal open={!!editUser && !!editForm} onClose={() => { setEditUser(null); setEditForm(null); }} title={`Sửa thành viên: ${editUser?.username ?? ""}`}>
        {editForm ? (
          <div className="space-y-4">
            <div>
              <Label>Tên đăng nhập</Label>
              <Input value={editUser?.username ?? ""} disabled className="h-11 font-mono" />
              <p className="mt-1 text-[11px] text-fg-muted">Tên đăng nhập không thay đổi tại đây để giữ ổn định lịch sử Audit.</p>
            </div>
            <div>
              <Label>Họ và tên</Label>
              <Input value={editForm.fullName} onChange={(e) => setEditForm({ ...editForm, fullName: e.target.value })} className="h-11" />
            </div>
            <div>
              <Label>Vai trò</Label>
              <select
                value={editForm.role}
                disabled={editUser?.id === currentUserId}
                onChange={(e) => setEditForm({ ...editForm, role: e.target.value, deptId: e.target.value === "DEPT_MANAGER" ? editForm.deptId : "" })}
                className="h-11 w-full rounded-xl border-2 border-border-strong px-3 font-semibold disabled:bg-surface-hover disabled:opacity-70"
              >
                {Object.entries(ROLE_LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select>
              {editUser?.id === currentUserId ? <p className="mt-1 text-[11px] text-warning">Không thể tự đổi vai trò của tài khoản đang đăng nhập.</p> : null}
            </div>
            {editForm.role === "DEPT_MANAGER" ? (
              <div>
                <Label>Bộ phận phụ trách</Label>
                <select value={editForm.deptId} onChange={(e) => setEditForm({ ...editForm, deptId: e.target.value })} className="h-11 w-full rounded-xl border-2 border-border-strong px-3 font-semibold">
                  <option value="">— Chọn bộ phận —</option>
                  {depts.map((dept) => <option key={dept.id} value={dept.id}>{dept.name}</option>)}
                </select>
              </div>
            ) : null}
            <div>
              <Label>Trạng thái tài khoản</Label>
              <select
                value={editForm.isActive ? "active" : "inactive"}
                disabled={editUser?.id === currentUserId}
                onChange={(e) => setEditForm({ ...editForm, isActive: e.target.value === "active" })}
                className="h-11 w-full rounded-xl border-2 border-border-strong px-3 font-semibold disabled:bg-surface-hover disabled:opacity-70"
              >
                <option value="active">Hoạt động</option>
                <option value="inactive">Khóa tài khoản</option>
              </select>
              {editUser?.id === currentUserId ? <p className="mt-1 text-[11px] text-warning">Tài khoản đang đăng nhập không thể tự khóa.</p> : null}
              {!editForm.isActive ? <p className="mt-2 rounded-xl bg-warning-tint px-3 py-2 text-xs font-semibold text-warning">Sau khi lưu, thành viên này sẽ không thể đăng nhập cho đến khi được mở lại.</p> : null}
            </div>
            <Button variant="gold" size="lg" className="w-full" onClick={saveEdit} loading={saving}><UserCog className="h-4 w-4" /> Lưu thay đổi</Button>
          </div>
        ) : null}
      </Modal>

      <Modal open={!!deleteUser} onClose={() => setDeleteUser(null)} title="Xác nhận xóa thành viên">
        <div className="space-y-4">
          <div className="rounded-2xl border border-danger/20 bg-danger-tint p-4 text-sm leading-6 text-fg-secondary">
            Bạn đang chuẩn bị xóa <b className="text-fg">{deleteUser?.username}</b> — {deleteUser?.fullName}.
            <br />Nếu cần giữ lịch sử, nên chọn <b>Khóa tài khoản</b> thay vì xóa.
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDeleteUser(null)}>Hủy</Button>
            <Button variant="destructive" onClick={remove} loading={saving}><Trash2 className="h-4 w-4" /> Xóa tài khoản</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
