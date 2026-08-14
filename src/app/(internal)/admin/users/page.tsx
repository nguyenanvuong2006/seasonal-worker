"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  FilterBar,
  FilterSelect,
  FormField,
  Input,
  Modal,
  PageHeader,
  RowMenu,
  SearchBar,
  toast,
} from "@/components/ui";
import { ROLE_LABEL } from "@/lib/helpers";
import { PROTECTION_ERRORS } from "@/lib/user-management";
import {
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  UserCheck,
  Users,
  UserX,
} from "lucide-react";

type UserRow = {
  id: string;
  username: string;
  fullName: string;
  role: string;
  deptId: string | null;
  deptName: string | null;
  groupName: string | null;
  isActive: boolean;
};

type Dept = { id: string; deptName: string; groupName: string };

function deptLabel(d?: { deptName: string; groupName: string } | null): string {
  if (!d) return "—";
  return d.groupName ? `${d.deptName} · ${d.groupName}` : d.deptName;
}

export default function UsersAdminPage() {
  const [rows, setRows] = useState<UserRow[]>([]);
  const [depts, setDepts] = useState<Dept[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);

  // Tìm kiếm + lọc
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("ALL");
  const [statusFilter, setStatusFilter] = useState("ALL");

  // Modal "Tạo tài khoản"
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({ username: "", password: "", fullName: "", role: "DEPT_MANAGER", deptId: "" });
  const [showCreatePw, setShowCreatePw] = useState(false);
  const [savingCreate, setSavingCreate] = useState(false);

  // Modal "Sửa thông tin"
  const [editUser, setEditUser] = useState<UserRow | null>(null);
  const [editForm, setEditForm] = useState({ fullName: "", role: "", deptId: "" });
  const [savingEdit, setSavingEdit] = useState(false);

  // Modal "Đổi mật khẩu"
  const [pwUser, setPwUser] = useState<UserRow | null>(null);
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [showResetPw, setShowResetPw] = useState(false);
  const [savingPw, setSavingPw] = useState(false);

  // Confirm "Khóa tài khoản" / "Kích hoạt lại"
  const [lockUser, setLockUser] = useState<UserRow | null>(null);
  const [activateUser, setActivateUser] = useState<UserRow | null>(null);
  const [savingToggle, setSavingToggle] = useState(false);

  // Confirm "Xóa thành viên" (soft delete, yêu cầu gõ username)
  const [deleteUser, setDeleteUser] = useState<UserRow | null>(null);
  const [deleteText, setDeleteText] = useState("");
  const [savingDelete, setSavingDelete] = useState(false);

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
    setCurrentUserId(uData.currentUserId ?? null);
    setDepts(dData.rows ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const activeAdminCount = useMemo(
    () => rows.filter((r) => r.role === "ADMIN" && r.isActive).length,
    [rows],
  );
  const isSelf = (u: UserRow | null) => u != null && u.id === currentUserId;
  const isLastActiveAdmin = (u: UserRow | null) =>
    u != null && u.role === "ADMIN" && u.isActive && activeAdminCount <= 1;

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((u) => {
      if (roleFilter !== "ALL" && u.role !== roleFilter) return false;
      if (statusFilter === "active" && !u.isActive) return false;
      if (statusFilter === "locked" && u.isActive) return false;
      if (q && !u.username.toLowerCase().includes(q) && !u.fullName.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rows, search, roleFilter, statusFilter]);

  async function callPatch(id: string, body: Record<string, unknown>): Promise<boolean> {
    const res = await fetch("/api/users", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, ...body }),
    });
    if (!res.ok) {
      let msg = "Thao tác thất bại.";
      try {
        msg = (await res.json()).error ?? msg;
      } catch {
        /* ignore */
      }
      toast({ title: msg, variant: "destructive" });
      return false;
    }
    return true;
  }

  async function callDelete(id: string): Promise<boolean> {
    const res = await fetch(`/api/users?id=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!res.ok) {
      let msg = "Thao tác thất bại.";
      try {
        msg = (await res.json()).error ?? msg;
      } catch {
        /* ignore */
      }
      toast({ title: msg, variant: "destructive" });
      return false;
    }
    return true;
  }

  const create = async () => {
    if (!createForm.username.trim() || !createForm.password) {
      toast({ title: "Vui lòng nhập đủ tên đăng nhập và mật khẩu.", variant: "destructive" });
      return;
    }
    setSavingCreate(true);
    const res = await fetch("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createForm),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast({ title: data.error ?? "Lỗi tạo tài khoản", variant: "destructive" });
      setSavingCreate(false);
      return;
    }
    toast({ title: "Đã tạo tài khoản" });
    setCreateOpen(false);
    setCreateForm({ username: "", password: "", fullName: "", role: "DEPT_MANAGER", deptId: "" });
    setSavingCreate(false);
    await load();
  };

  const openEdit = (u: UserRow) => {
    setEditUser(u);
    setEditForm({ fullName: u.fullName, role: u.role, deptId: u.deptId ?? "" });
  };

  const saveEdit = async () => {
    if (!editUser) return;
    if (!editForm.fullName.trim()) {
      toast({ title: "Họ và tên không được để trống.", variant: "destructive" });
      return;
    }
    setSavingEdit(true);
    const ok = await callPatch(editUser.id, {
      fullName: editForm.fullName,
      role: editForm.role,
      deptId: editForm.role === "DEPT_MANAGER" ? editForm.deptId : "",
    });
    setSavingEdit(false);
    if (!ok) return;
    toast({ title: "Đã lưu thay đổi" });
    setEditUser(null);
    await load();
  };

  const savePassword = async () => {
    if (!pwUser) return;
    if (newPw.length < 8) {
      toast({ title: "Mật khẩu tối thiểu 8 ký tự.", variant: "destructive" });
      return;
    }
    if (newPw !== confirmPw) {
      toast({ title: "Mật khẩu xác nhận không khớp.", variant: "destructive" });
      return;
    }
    setSavingPw(true);
    const ok = await callPatch(pwUser.id, { password: newPw });
    setSavingPw(false);
    if (!ok) return;
    toast({ title: "Đã cập nhật mật khẩu" });
    setPwUser(null);
    setNewPw("");
    setConfirmPw("");
  };

  const toggleActive = async (u: UserRow, nextActive: boolean) => {
    setSavingToggle(true);
    const ok = await callPatch(u.id, { isActive: nextActive });
    setSavingToggle(false);
    if (!ok) return;
    setLockUser(null);
    setActivateUser(null);
    await load();
  };

  const confirmDelete = async () => {
    if (!deleteUser) return;
    setSavingDelete(true);
    const ok = await callDelete(deleteUser.id);
    setSavingDelete(false);
    if (!ok) return;
    toast({ title: "Đã xóa thành viên (vô hiệu hóa an toàn)" });
    setDeleteUser(null);
    setDeleteText("");
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
      <PageHeader
        title="Quản lý thành viên"
        description="Quản lý tài khoản nội bộ, vai trò và bộ phận phụ trách. Mọi thay đổi đều được ghi vào nhật ký hệ thống."
        actions={
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden />
            Tạo tài khoản
          </Button>
        }
      />

      <Card className="p-0">
        <CardHeader title="Danh sách người dùng nội bộ" />
        <CardContent className="space-y-4">
          <FilterBar>
            <SearchBar value={search} onChange={setSearch} placeholder="Tìm theo tên đăng nhập / họ tên..." className="w-full max-w-xs" />
            <FilterSelect
              value={roleFilter}
              onChange={setRoleFilter}
              options={[
                { value: "ALL", label: "Tất cả vai trò" },
                ...Object.entries(ROLE_LABEL).map(([value, label]) => ({ value, label })),
              ]}
            />
            <FilterSelect
              value={statusFilter}
              onChange={setStatusFilter}
              options={[
                { value: "ALL", label: "Tất cả trạng thái" },
                { value: "active", label: "Hoạt động" },
                { value: "locked", label: "Đã khóa" },
              ]}
            />
          </FilterBar>

          {loading ? (
            <div className="p-10 text-center">
              <Loader2 className="mx-auto h-6 w-6 animate-spin text-primary" />
            </div>
          ) : filteredRows.length === 0 ? (
            <EmptyState
              icon={<Users className="h-5 w-5" aria-hidden />}
              title="Không tìm thấy người dùng nào"
              description="Thử thay đổi từ khóa tìm kiếm hoặc bộ lọc."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="grid-sheet w-full text-sm">
                <thead className="bg-primary-tint text-primary">
                  <tr>
                    <th className="px-3 py-2 text-left text-[11px] uppercase">Tên tài khoản</th>
                    <th className="px-3 py-2 text-left text-[11px] uppercase">Họ tên</th>
                    <th className="px-3 py-2 text-left text-[11px] uppercase">Vai trò</th>
                    <th className="px-3 py-2 text-left text-[11px] uppercase">Bộ phận</th>
                    <th className="px-3 py-2 text-left text-[11px] uppercase">Trạng thái</th>
                    <th className="px-3 py-2 text-right text-[11px] uppercase">Thao tác</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.map((u) => (
                    <tr key={u.id} className="hover:bg-primary-tint/50">
                      <td className="px-3 py-2 font-mono font-bold">
                        {u.username}
                        {isSelf(u) && (
                          <span className="ml-2 rounded bg-accent-tint px-1.5 py-0.5 text-[10px] font-bold uppercase text-accent">
                            Bạn
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">{u.fullName}</td>
                      <td className="px-3 py-2 font-semibold">{ROLE_LABEL[u.role] ?? u.role}</td>
                      <td className="px-3 py-2 text-fg-secondary">
                        {u.role === "DEPT_MANAGER" ? deptLabel(u.deptName ? { deptName: u.deptName, groupName: u.groupName ?? "" } : null) : "—"}
                      </td>
                      <td className="px-3 py-2">
                        {/* Badge chỉ hiển thị — tuyệt đối không clickable */}
                        <Badge tone={u.isActive ? "green" : "gray"}>
                          {u.isActive ? "Hoạt động" : "Đã khóa"}
                        </Badge>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <RowMenu
                          items={[
                            {
                              label: "Sửa thông tin",
                              icon: <Pencil className="h-4 w-4" aria-hidden />,
                              onClick: () => openEdit(u),
                            },
                            {
                              label: "Đổi mật khẩu",
                              icon: <KeyRound className="h-4 w-4" aria-hidden />,
                              onClick: () => {
                                setPwUser(u);
                                setNewPw("");
                                setConfirmPw("");
                              },
                            },
                            u.isActive
                              ? {
                                  label: "Khóa tài khoản",
                                  icon: <UserX className="h-4 w-4" aria-hidden />,
                                  disabled: isSelf(u) || isLastActiveAdmin(u),
                                  onClick: () => setLockUser(u),
                                }
                              : {
                                  label: "Kích hoạt lại",
                                  icon: <UserCheck className="h-4 w-4" aria-hidden />,
                                  disabled: isSelf(u),
                                  onClick: () => setActivateUser(u),
                                },
                            {
                              label: "Xóa thành viên",
                              icon: <Trash2 className="h-4 w-4" aria-hidden />,
                              danger: true,
                              separated: true,
                              disabled: isSelf(u) || isLastActiveAdmin(u),
                              onClick: () => {
                                setDeleteUser(u);
                                setDeleteText("");
                              },
                            },
                          ]}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ============ Tạo tài khoản ============ */}
      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Tạo tài khoản nội bộ">
        <div className="space-y-3">
          <FormField label="Tên đăng nhập" required>
            <Input
              value={createForm.username}
              onChange={(e) => setCreateForm({ ...createForm, username: e.target.value.toLowerCase() })}
              className="h-11 font-mono"
              placeholder="hr.tuyendung"
            />
          </FormField>
          <FormField label="Mật khẩu (tối thiểu 8 ký tự)" required>
            <div className="relative">
              <Input
                value={createForm.password}
                onChange={(e) => setCreateForm({ ...createForm, password: e.target.value })}
                className="h-11 pr-11"
                type={showCreatePw ? "text" : "password"}
                autoComplete="new-password"
              />
              <button
                type="button"
                onClick={() => setShowCreatePw((v) => !v)}
                className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-fg-muted hover:text-fg"
                aria-label={showCreatePw ? "Ẩn mật khẩu" : "Hiện mật khẩu"}
              >
                {showCreatePw ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
              </button>
            </div>
          </FormField>
          <FormField label="Họ và tên">
            <Input
              value={createForm.fullName}
              onChange={(e) => setCreateForm({ ...createForm, fullName: e.target.value })}
              className="h-11"
            />
          </FormField>
          <FormField label="Vai trò">
            <select
              value={createForm.role}
              onChange={(e) => setCreateForm({ ...createForm, role: e.target.value })}
              className="h-11 w-full rounded-xl border-2 border-border-strong px-2 font-semibold"
            >
              {Object.entries(ROLE_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </FormField>
          {createForm.role === "DEPT_MANAGER" && (
            <FormField label="Bộ phận phụ trách">
              <select
                value={createForm.deptId}
                onChange={(e) => setCreateForm({ ...createForm, deptId: e.target.value })}
                className="h-11 w-full rounded-xl border-2 border-border-strong px-2 font-semibold"
              >
                <option value="">— Chọn bộ phận —</option>
                {depts.map((d) => (
                  <option key={d.id} value={d.id}>
                    {deptLabel(d)}
                  </option>
                ))}
              </select>
            </FormField>
          )}
          <Button variant="primary" size="lg" className="w-full" onClick={create} loading={savingCreate}>
            Tạo tài khoản
          </Button>
        </div>
      </Modal>

      {/* ============ Sửa thông tin ============ */}
      <Modal
        open={!!editUser}
        onClose={() => setEditUser(null)}
        title="Sửa thông tin thành viên"
        description="Username được giữ cố định để bảo toàn liên kết lịch sử/audit."
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditUser(null)} disabled={savingEdit}>
              Hủy
            </Button>
            <Button variant="primary" onClick={saveEdit} loading={savingEdit}>
              Lưu thay đổi
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <FormField label="Tên đăng nhập (read-only)">
            <Input value={editUser?.username ?? ""} className="h-11 font-mono" disabled readOnly />
          </FormField>
          <FormField label="Họ và tên" required>
            <Input
              value={editForm.fullName}
              onChange={(e) => setEditForm({ ...editForm, fullName: e.target.value })}
              className="h-11"
            />
          </FormField>
          <FormField
            label="Vai trò"
            helper={isSelf(editUser) ? PROTECTION_ERRORS.SELF_DEMOTE : undefined}
          >
            <select
              value={editForm.role}
              onChange={(e) => setEditForm({ ...editForm, role: e.target.value })}
              disabled={isSelf(editUser) || isLastActiveAdmin(editUser)}
              className="h-11 w-full rounded-xl border-2 border-border-strong px-2 font-semibold disabled:cursor-not-allowed disabled:opacity-50"
            >
              {Object.entries(ROLE_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </FormField>
          {editForm.role === "DEPT_MANAGER" && (
            <FormField
              label="Bộ phận phụ trách"
              helper="Phân nhiều bộ phận cho Quản lý bộ phận: quản lý tại Quản lý Data Scope."
            >
              <select
                value={editForm.deptId}
                onChange={(e) => setEditForm({ ...editForm, deptId: e.target.value })}
                className="h-11 w-full rounded-xl border-2 border-border-strong px-2 font-semibold"
              >
                <option value="">— Chọn bộ phận —</option>
                {depts.map((d) => (
                  <option key={d.id} value={d.id}>
                    {deptLabel(d)}
                  </option>
                ))}
              </select>
            </FormField>
          )}
        </div>
      </Modal>

      {/* ============ Đổi mật khẩu ============ */}
      <Modal
        open={!!pwUser}
        onClose={() => setPwUser(null)}
        title={`Đổi mật khẩu: ${pwUser?.username ?? ""}`}
        description="Sau khi đổi, mọi phiên đăng nhập cũ của tài khoản này sẽ bị đăng xuất."
        footer={
          <>
            <Button variant="ghost" onClick={() => setPwUser(null)} disabled={savingPw}>
              Hủy
            </Button>
            <Button variant="primary" onClick={savePassword} loading={savingPw}>
              Cập nhật mật khẩu
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <FormField label="Mật khẩu mới (tối thiểu 8 ký tự)" required>
            <div className="relative">
              <Input
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
                className="h-11 pr-11"
                type={showResetPw ? "text" : "password"}
                autoComplete="new-password"
              />
              <button
                type="button"
                onClick={() => setShowResetPw((v) => !v)}
                className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-fg-muted hover:text-fg"
                aria-label={showResetPw ? "Ẩn mật khẩu" : "Hiện mật khẩu"}
              >
                {showResetPw ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
              </button>
            </div>
          </FormField>
          <FormField label="Xác nhận mật khẩu mới" required>
            <Input
              value={confirmPw}
              onChange={(e) => setConfirmPw(e.target.value)}
              className="h-11"
              type="password"
              autoComplete="new-password"
            />
          </FormField>
        </div>
      </Modal>

      {/* ============ Khóa tài khoản ============ */}
      <ConfirmDialog
        open={!!lockUser}
        onClose={() => setLockUser(null)}
        onConfirm={() => {
          if (lockUser) void toggleActive(lockUser, false);
        }}
        title="Khóa tài khoản"
        description={
          <>
            Bạn có chắc muốn khóa tài khoản <span className="font-mono font-bold">{lockUser?.username}</span>?
            Người dùng sẽ bị đăng xuất và không thể đăng nhập lại cho đến khi được kích hoạt.
          </>
        }
        confirmLabel="Khóa tài khoản"
        cancelLabel="Hủy"
        danger
        loading={savingToggle}
      />

      {/* ============ Kích hoạt lại ============ */}
      <ConfirmDialog
        open={!!activateUser}
        onClose={() => setActivateUser(null)}
        onConfirm={() => {
          if (activateUser) void toggleActive(activateUser, true);
        }}
        title="Kích hoạt lại tài khoản"
        description={
          <>
            Bạn có chắc muốn kích hoạt lại tài khoản <span className="font-mono font-bold">{activateUser?.username}</span>?
            Người dùng sẽ có thể đăng nhập trở lại.
          </>
        }
        confirmLabel="Kích hoạt lại"
        cancelLabel="Hủy"
        loading={savingToggle}
      />

      {/* ============ Xóa thành viên (soft delete) ============ */}
      <Modal
        open={!!deleteUser}
        onClose={() => setDeleteUser(null)}
        title="Xóa thành viên"
        width="max-w-md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteUser(null)} disabled={savingDelete}>
              Hủy
            </Button>
            <Button
              variant="danger"
              onClick={confirmDelete}
              loading={savingDelete}
              disabled={deleteText.trim() !== deleteUser?.username}
            >
              Xóa thành viên
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="flex gap-3 rounded-[10px] border border-danger/30 bg-danger-tint/60 p-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-danger-tint text-danger">
              <Trash2 className="h-[18px] w-[18px]" aria-hidden />
            </div>
            <div className="text-[13.5px] leading-relaxed text-fg-secondary">
              <p>
                Bạn sắp xóa thành viên{" "}
                <span className="font-mono font-bold text-fg">{deleteUser?.username}</span>
                {deleteUser?.fullName ? (
                  <>
                    {" "}(<span className="font-semibold text-fg">{deleteUser?.fullName}</span>)
                  </>
                ) : null}
                .
              </p>
              <p className="mt-1.5">
                Tài khoản sẽ bị vô hiệu hóa (khóa) và đăng xuất khỏi mọi phiên. Lịch sử thao tác
                (audit log) và dữ liệu tham chiếu được giữ nguyên để bảo toàn truy vết; có thể kích
                hoạt lại nếu cần.
              </p>
            </div>
          </div>
          <FormField label={`Nhập "${deleteUser?.username ?? ""}" để xác nhận`} required>
            <Input
              value={deleteText}
              onChange={(e) => setDeleteText(e.target.value)}
              className="h-11 font-mono"
              placeholder={deleteUser?.username}
              autoComplete="off"
            />
          </FormField>
        </div>
      </Modal>
    </div>
  );
}
