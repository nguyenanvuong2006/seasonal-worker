"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Card, CardContent, CardHeader, ConfirmDialog, FormField, Input, Modal, toast } from "@/components/ui";
import { Copy, Lock, Loader2, Pencil, Plus, Power, RotateCcw, Save, ShieldCheck } from "lucide-react";
import { BULK_ENABLE_PROTECTED_PERMISSION_KEYS } from "@/lib/rbac-catalog";
import {
  applyBulk,
  buildBatchChanges,
  computeChangedKeys,
  effectiveAllowed,
  resetToBaseline,
  shouldConfirmDiscard,
  toggleOne as toggleOnePure,
  type PermissionMap,
} from "@/lib/rbac-batch-editor";

type RoleRow = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  isActive: boolean;
  sortOrder: number;
  memberCount: number;
};

type PermRow = { key: string; name: string; group: string; description: string | null };
type GroupRow = { key: string; label: string };
type MatrixRow = { role: string; permissionKey: string; allowed: boolean };

type LoadData = {
  roles: RoleRow[];
  permissions: PermRow[];
  groups: GroupRow[];
  matrix: MatrixRow[];
};

const TABS = [
  { key: "roles", label: "Vai trò (Roles)" },
  { key: "permissions", label: "Danh mục quyền (Permissions)" },
  { key: "matrix", label: "Chỉnh sửa quyền theo vai trò" },
] as const;

export default function PermissionsPage() {
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>("roles");
  const [data, setData] = useState<LoadData | null>(null);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);

  // Modals: tạo vai trò
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({ key: "", name: "", description: "", cloneFrom: "" });
  const [savingCreate, setSavingCreate] = useState(false);

  // Modals: sửa vai trò
  const [editRole, setEditRole] = useState<RoleRow | null>(null);
  const [editForm, setEditForm] = useState({ name: "", description: "" });
  const [savingEdit, setSavingEdit] = useState(false);

  // Modal: tạo quyền mới
  const [permOpen, setPermOpen] = useState(false);
  const [permForm, setPermForm] = useState({ key: "", name: "", group: "" });
  const [savingPerm, setSavingPerm] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/admin/permissions");
    if (res.status === 401 || res.status === 403) {
      setDenied(true);
      setLoading(false);
      return;
    }
    const json = await res.json();
    setData({
      roles: json.roles ?? [],
      permissions: json.permissions ?? [],
      groups: json.groups ?? [],
      matrix: json.matrix ?? [],
    });
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /* ================================================================
   * BATCH PERMISSION EDITOR (tab "matrix") — local dirty-state model.
   * Toggling a permission ONLY updates `draft` (client state). Nothing is
   * sent to the server, and the page never refetches, until the admin
   * explicitly clicks "Lưu thay đổi". `baseline` is the last-known-persisted
   * state for the SELECTED role, used both to compute what's dirty and to
   * restore on "Hủy thay đổi".
   * ================================================================ */
  const editableRoles = useMemo(() => (data?.roles ?? []).filter((r) => r.key !== "ADMIN"), [data]);

  const [selectedRole, setSelectedRole] = useState<string>("");
  const [baseline, setBaseline] = useState<PermissionMap>(new Map());
  const [draft, setDraft] = useState<PermissionMap>(new Map());
  const [savingBatch, setSavingBatch] = useState(false);
  // Discard-confirmation targets: set when the admin tries to switch role/tab
  // while dirty; the actual switch only happens if they confirm.
  const [pendingRoleKey, setPendingRoleKey] = useState<string | null>(null);
  const [pendingTabKey, setPendingTabKey] = useState<(typeof TABS)[number]["key"] | null>(null);

  // Default to the first editable, active role once data loads.
  useEffect(() => {
    if (!data || selectedRole) return;
    const first = editableRoles.find((r) => r.isActive) ?? editableRoles[0];
    if (first) setSelectedRole(first.key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // Re-derive baseline/draft from the (possibly just-saved) matrix whenever the
  // selected role actually changes — never while the admin is mid-edit.
  useEffect(() => {
    if (!selectedRole || !data) return;
    const map = new Map<string, boolean>();
    for (const m of data.matrix) if (m.role === selectedRole) map.set(m.permissionKey, m.allowed);
    setBaseline(map);
    setDraft(new Map(map));
  }, [selectedRole, data]);

  const changedKeys = useMemo(() => computeChangedKeys(baseline, draft), [baseline, draft]);
  const isDirty = changedKeys.length > 0;

  const selectedRoleRow = editableRoles.find((r) => r.key === selectedRole) ?? null;
  const roleEditingDisabled = !selectedRoleRow || !selectedRoleRow.isActive;

  // Hard navigation / refresh / tab close while dirty — native browser prompt.
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  /** In-app "leave the editor" guard shared by role switch and tab switch. */
  const requestRoleChange = (roleKey: string) => {
    if (shouldConfirmDiscard(selectedRole, roleKey, isDirty)) {
      setPendingRoleKey(roleKey);
      return;
    }
    if (roleKey !== selectedRole) setSelectedRole(roleKey);
  };

  const requestTabChange = (nextTab: (typeof TABS)[number]["key"]) => {
    const dirtyHere = tab === "matrix" && isDirty;
    if (shouldConfirmDiscard(tab, nextTab, dirtyHere)) {
      setPendingTabKey(nextTab);
      return;
    }
    if (nextTab !== tab) setTab(nextTab);
  };

  const toggleOne = (key: string) => {
    if (roleEditingDisabled) return;
    setDraft((prev) => toggleOnePure(prev, key));
  };

  /** "Bật cả nhóm"/"Tắt cả nhóm" and "Bật tất cả"/"Tắt tất cả" share this. */
  const setBulk = (keys: string[], allowed: boolean) => {
    if (roleEditingDisabled) return;
    let excludedCount = 0;
    let excludedList: string[] = [];
    setDraft((prev) => {
      const { next, excluded } = applyBulk(prev, keys, allowed, BULK_ENABLE_PROTECTED_PERMISSION_KEYS);
      excludedCount = excluded.length;
      excludedList = excluded;
      return next;
    });
    if (excludedCount > 0) {
      toast({
        title: `Đã bỏ qua ${excludedCount} quyền quản trị hệ thống (${excludedList.join(", ")}) — bật thủ công nếu chắc chắn cần cấp.`,
      });
    }
  };

  const cancelBatch = () => {
    setDraft(resetToBaseline(baseline));
  };

  const saveBatch = async () => {
    if (!selectedRole || !isDirty) return;
    setSavingBatch(true);
    const changes = buildBatchChanges(baseline, draft);
    try {
      const res = await fetch("/api/admin/permissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "batch_update_permissions", role: selectedRole, changes }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast({ title: json.error ?? "Lưu thay đổi thất bại.", variant: "destructive" });
        return;
      }
      // Merge the confirmed changes into local state — no full reload.
      setData((prev) => {
        if (!prev) return prev;
        const matrixMap = new Map(prev.matrix.map((m) => [`${m.role}:${m.permissionKey}`, m] as const));
        for (const c of changes) {
          matrixMap.set(`${selectedRole}:${c.permissionKey}`, { role: selectedRole, permissionKey: c.permissionKey, allowed: c.allowed });
        }
        return { ...prev, matrix: [...matrixMap.values()] };
      });
      setBaseline(new Map(draft));
      toast({ title: `Đã lưu ${changes.length} thay đổi cho vai trò ${selectedRole}.` });
    } finally {
      setSavingBatch(false);
    }
  };

  const createRole = async () => {
    if (!createForm.key.trim() || !createForm.name.trim()) {
      toast({ title: "Vui lòng nhập đủ key và tên vai trò.", variant: "destructive" });
      return;
    }
    setSavingCreate(true);
    const res = await fetch("/api/admin/permissions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "create_role", ...createForm, cloneFrom: createForm.cloneFrom || undefined }),
    });
    const json = await res.json().catch(() => ({}));
    setSavingCreate(false);
    if (!res.ok) {
      toast({ title: json.error ?? "Tạo vai trò thất bại.", variant: "destructive" });
      return;
    }
    toast({ title: `Đã tạo vai trò ${createForm.key}` });
    setCreateOpen(false);
    setCreateForm({ key: "", name: "", description: "", cloneFrom: "" });
    await load();
  };

  const saveEdit = async () => {
    if (!editRole) return;
    setSavingEdit(true);
    const res = await fetch("/api/admin/permissions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "update_role", id: editRole.id, ...editForm }),
    });
    const json = await res.json().catch(() => ({}));
    setSavingEdit(false);
    if (!res.ok) {
      toast({ title: json.error ?? "Lưu thất bại.", variant: "destructive" });
      return;
    }
    toast({ title: "Đã lưu vai trò" });
    setEditRole(null);
    await load();
  };

  const toggleRoleActive = async (r: RoleRow) => {
    const res = await fetch("/api/admin/permissions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "update_role", id: r.id, isActive: !r.isActive }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast({ title: json.error ?? "Thao tác thất bại.", variant: "destructive" });
      return;
    }
    toast({
      title: r.isActive ? `Đã tắt vai trò ${r.key} (mọi phiên của ${r.memberCount} thành viên bị đăng xuất)` : `Đã bật vai trò ${r.key}`,
    });
    await load();
  };

  const createPermission = async () => {
    if (!permForm.key.trim() || !permForm.name.trim() || !permForm.group.trim()) {
      toast({ title: "Vui lòng nhập đủ key, tên và nhóm quyền.", variant: "destructive" });
      return;
    }
    setSavingPerm(true);
    const res = await fetch("/api/admin/permissions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "create_permission", ...permForm }),
    });
    const json = await res.json().catch(() => ({}));
    setSavingPerm(false);
    if (!res.ok) {
      toast({ title: json.error ?? "Tạo quyền thất bại.", variant: "destructive" });
      return;
    }
    toast({ title: `Đã tạo quyền ${permForm.key}` });
    setPermOpen(false);
    setPermForm({ key: "", name: "", group: "" });
    await load();
  };

  const cloneRole = (r: RoleRow) => {
    setCreateForm({ key: "", name: `${r.name} (bản sao)`, description: `Sao chép từ ${r.key}`, cloneFrom: r.key });
    setCreateOpen(true);
  };

  const permissionsByGroup = useMemo(() => {
    const groups = (data?.groups ?? []).map((g) => ({ ...g, perms: [] as PermRow[] }));
    for (const p of data?.permissions ?? []) {
      const g = groups.find((x) => x.key === p.group);
      if (g) g.perms.push(p);
    }
    return groups.filter((g) => g.perms.length > 0);
  }, [data]);

  if (denied) {
    return (
      <Card>
        <CardContent className="p-10 text-center font-bold text-red-600">Từ chối truy cập! Chỉ Quản trị viên mới xem được trang này.</CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-black text-fg">Phân quyền động (Dynamic RBAC V2)</h1>
        <p className="text-sm text-fg-secondary">
          Vai trò & quyền quản lý qua catalog động: tạo vai trò tuỳ chỉnh, gán quyền chi tiết (fail-closed), Data Scope độc lập vai trò.
          Mọi thay đổi có hiệu lực ngay ở request kế tiếp (session bị đăng xuất khi tắt vai trò).
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => requestTabChange(t.key)}
            className={`rounded-full px-4 py-1.5 text-[12.5px] font-bold transition ${
              tab === t.key ? "bg-primary text-white" : "bg-primary-tint text-primary hover:bg-primary/15"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <Card>
          <CardContent className="p-10 text-center">
            <Loader2 className="mx-auto h-6 w-6 animate-spin text-primary" />
          </CardContent>
        </Card>
      ) : (
        <>
          {/* ================= TAB 1: VAI TRÒ ================= */}
          {tab === "roles" && (
            <Card className="p-0">
              <CardHeader
                title="Danh sách vai trò"
                right={
                  <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
                    <Plus className="h-4 w-4" aria-hidden /> Tạo vai trò
                  </Button>
                }
              />
              <CardContent className="overflow-x-auto p-0">
                <table className="grid-sheet w-full text-sm">
                  <thead className="bg-primary-tint text-primary">
                    <tr>
                      <th className="px-3 py-2 text-left text-[11px] uppercase">Key</th>
                      <th className="px-3 py-2 text-left text-[11px] uppercase">Tên</th>
                      <th className="px-3 py-2 text-left text-[11px] uppercase">Mô tả</th>
                      <th className="px-3 py-2 text-center text-[11px] uppercase">Loại</th>
                      <th className="px-3 py-2 text-center text-[11px] uppercase">Thành viên</th>
                      <th className="px-3 py-2 text-center text-[11px] uppercase">Trạng thái</th>
                      <th className="px-3 py-2 text-right text-[11px] uppercase">Thao tác</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data?.roles ?? []).map((r) => (
                      <tr key={r.id} className="hover:bg-primary-tint/50">
                        <td className="px-3 py-2 font-mono font-bold">{r.key}</td>
                        <td className="px-3 py-2 font-semibold">{r.name}</td>
                        <td className="max-w-[320px] truncate px-3 py-2 text-xs text-fg-secondary">{r.description ?? "—"}</td>
                        <td className="px-3 py-2 text-center">
                          <Badge tone={r.isSystem ? "blue" : "gray"}>{r.isSystem ? "Hệ thống" : "Tuỳ chỉnh"}</Badge>
                        </td>
                        <td className="px-3 py-2 text-center font-semibold">{r.memberCount}</td>
                        <td className="px-3 py-2 text-center">
                          <Badge tone={r.isActive ? "green" : "red"}>{r.isActive ? "Đang bật" : "Đã tắt"}</Badge>
                        </td>
                        <td className="px-3 py-2 text-right">
                          <div className="inline-flex items-center gap-1">
                            <button
                              className="rounded-lg p-1.5 text-fg-muted hover:bg-primary-tint hover:text-primary"
                              title="Chỉnh sửa"
                              onClick={() => {
                                setEditRole(r);
                                setEditForm({ name: r.name, description: r.description ?? "" });
                              }}
                            >
                              <Pencil className="h-4 w-4" aria-hidden />
                            </button>
                            <button
                              className="rounded-lg p-1.5 text-fg-muted hover:bg-primary-tint hover:text-primary"
                              title="Nhân bản vai trò"
                              onClick={() => cloneRole(r)}
                            >
                              <Copy className="h-4 w-4" aria-hidden />
                            </button>
                            <button
                              className="rounded-lg p-1.5 text-fg-muted hover:bg-danger-tint hover:text-danger disabled:cursor-not-allowed disabled:opacity-40"
                              title={r.isActive ? "Tắt vai trò (đăng xuất mọi thành viên)" : "Bật lại vai trò"}
                              disabled={r.isSystem}
                              onClick={() => toggleRoleActive(r)}
                            >
                              <Power className="h-4 w-4" aria-hidden />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}

          {/* ================= TAB 2: DANH MỤC QUYỀN ================= */}
          {tab === "permissions" && (
            <div className="space-y-4">
              <div className="flex justify-end">
                <Button variant="primary" size="sm" onClick={() => setPermOpen(true)}>
                  <Plus className="h-4 w-4" aria-hidden /> Tạo quyền mới
                </Button>
              </div>
              {permissionsByGroup.map((g) => (
                <Card key={g.key} className="p-0">
                  <CardHeader title={g.label} />
                  <CardContent className="p-0">
                    <div className="divide-y divide-border">
                      {g.perms.map((p) => (
                        <div key={p.key} className="flex items-center justify-between gap-3 px-4 py-2.5">
                          <div>
                            <p className="font-mono text-[12.5px] font-bold text-primary">{p.key}</p>
                            <p className="text-[13px] font-medium text-fg">{p.name}</p>
                          </div>
                          <Badge tone="green">Enforced</Badge>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {/* ================= TAB 3: CHỈNH SỬA QUYỀN THEO VAI TRÒ (Batch Edit) ================= */}
          {tab === "matrix" && (
            <div className="space-y-4">
              <Card className="p-4">
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <FormField label="Vai trò đang chỉnh sửa" className="min-w-[280px]">
                    <select
                      value={selectedRole}
                      onChange={(e) => requestRoleChange(e.target.value)}
                      className="h-11 w-full rounded-xl border-2 border-border-strong px-2 font-semibold"
                    >
                      {editableRoles.map((r) => (
                        <option key={r.id} value={r.key}>
                          {r.key} — {r.name}
                          {!r.isActive ? " (đã tắt)" : ""}
                        </option>
                      ))}
                    </select>
                  </FormField>

                  {isDirty ? (
                    <Badge tone="amber" className="h-fit">
                      Bạn có {changedKeys.length} thay đổi chưa lưu
                    </Badge>
                  ) : (
                    <Badge tone="gray" className="h-fit">
                      Không có thay đổi
                    </Badge>
                  )}

                  <div className="flex items-center gap-2">
                    <Button variant="ghost" onClick={cancelBatch} disabled={!isDirty || savingBatch}>
                      <RotateCcw className="h-4 w-4" aria-hidden /> Hủy thay đổi
                    </Button>
                    <Button variant="primary" onClick={saveBatch} disabled={!isDirty} loading={savingBatch}>
                      <Save className="h-4 w-4" aria-hidden /> Lưu thay đổi
                    </Button>
                  </div>
                </div>

                {roleEditingDisabled && selectedRoleRow && !selectedRoleRow.isActive ? (
                  <p className="mt-3 rounded-lg bg-danger-tint px-3 py-2 text-[12.5px] font-semibold text-danger">
                    Vai trò {selectedRoleRow.key} đang bị TẮT — bật lại ở tab “Vai trò (Roles)” trước khi chỉnh quyền.
                  </p>
                ) : (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" onClick={() => setBulk((data?.permissions ?? []).map((p) => p.key), true)} disabled={roleEditingDisabled}>
                      Bật tất cả
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setBulk((data?.permissions ?? []).map((p) => p.key), false)} disabled={roleEditingDisabled}>
                      Tắt tất cả
                    </Button>
                  </div>
                )}
              </Card>

              {permissionsByGroup.map((g) => {
                const groupKeys = g.perms.map((p) => p.key);
                return (
                  <Card key={g.key} className="p-0">
                    <CardHeader
                      title={g.label}
                      right={
                        <div className="flex items-center gap-2">
                          <Button variant="ghost" size="sm" onClick={() => setBulk(groupKeys, true)} disabled={roleEditingDisabled}>
                            Bật cả nhóm
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => setBulk(groupKeys, false)} disabled={roleEditingDisabled}>
                            Tắt cả nhóm
                          </Button>
                        </div>
                      }
                    />
                    <CardContent className="p-0">
                      <div className="divide-y divide-border">
                        {g.perms.map((p) => {
                          const allowed = effectiveAllowed(draft, p.key);
                          const changed = effectiveAllowed(draft, p.key) !== effectiveAllowed(baseline, p.key);
                          const protectedKey = BULK_ENABLE_PROTECTED_PERMISSION_KEYS.has(p.key);
                          return (
                            <div
                              key={p.key}
                              className={`flex items-center justify-between gap-3 px-4 py-2.5 ${changed ? "bg-amber-50" : ""}`}
                            >
                              <div className="min-w-0">
                                <p className="flex items-center gap-1.5 font-mono text-[12.5px] font-bold text-primary">
                                  {p.key}
                                  {protectedKey && <Lock className="h-3 w-3 text-fg-muted" aria-label="Quyền quản trị hệ thống — không nằm trong Bật tất cả/Bật cả nhóm" />}
                                  {changed && <Badge tone="amber">Đã sửa</Badge>}
                                </p>
                                <p className="text-[13px] font-medium text-fg">{p.name}</p>
                              </div>
                              <button
                                onClick={() => toggleOne(p.key)}
                                disabled={roleEditingDisabled}
                                className={`h-6 w-11 shrink-0 rounded-full transition disabled:cursor-not-allowed disabled:opacity-40 ${
                                  allowed ? "bg-emerald-500" : "bg-border-strong"
                                }`}
                              >
                                <span
                                  className={`block h-5 w-5 translate-x-0.5 rounded-full bg-surface shadow transition ${
                                    allowed ? "translate-x-[22px]" : ""
                                  }`}
                                />
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* ============ Confirm: chuyển vai trò khi còn thay đổi chưa lưu ============ */}
      <ConfirmDialog
        open={pendingRoleKey !== null}
        onClose={() => setPendingRoleKey(null)}
        onConfirm={() => {
          if (pendingRoleKey) setSelectedRole(pendingRoleKey);
          setPendingRoleKey(null);
        }}
        title="Bỏ thay đổi chưa lưu?"
        description={`Bạn có ${changedKeys.length} thay đổi chưa lưu cho vai trò ${selectedRole}. Chuyển vai trò khác sẽ làm mất các thay đổi này.`}
        confirmLabel="Bỏ thay đổi, chuyển vai trò"
        cancelLabel="Ở lại"
        danger
      />

      {/* ============ Confirm: chuyển tab khi còn thay đổi chưa lưu ============ */}
      <ConfirmDialog
        open={pendingTabKey !== null}
        onClose={() => setPendingTabKey(null)}
        onConfirm={() => {
          if (pendingTabKey) setTab(pendingTabKey);
          setPendingTabKey(null);
        }}
        title="Bỏ thay đổi chưa lưu?"
        description={`Bạn có ${changedKeys.length} thay đổi chưa lưu cho vai trò ${selectedRole}. Rời khỏi tab này sẽ làm mất các thay đổi này.`}
        confirmLabel="Bỏ thay đổi, rời khỏi tab"
        cancelLabel="Ở lại"
        danger
      />

      {/* ============ Modal: Tạo vai trò ============ */}
      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Tạo vai trò mới" description="Vai trò tuỳ chỉnh bắt đầu với 0 quyền (fail-closed) — gán quyền ở tab Ma trận, hoặc nhân bản từ vai trò có sẵn.">
        <div className="space-y-3">
          <FormField label="Key (viết hoa, ví dụ: HR_SPECIALIST)" required>
            <Input value={createForm.key} onChange={(e) => setCreateForm({ ...createForm, key: e.target.value.toUpperCase() })} className="h-11 font-mono" placeholder="HR_SPECIALIST" />
          </FormField>
          <FormField label="Tên hiển thị" required>
            <Input value={createForm.name} onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })} className="h-11" />
          </FormField>
          <FormField label="Mô tả">
            <Input value={createForm.description} onChange={(e) => setCreateForm({ ...createForm, description: e.target.value })} className="h-11" />
          </FormField>
          <FormField label="Nhân bản quyền từ vai trò (tuỳ chọn)">
            <select
              value={createForm.cloneFrom}
              onChange={(e) => setCreateForm({ ...createForm, cloneFrom: e.target.value })}
              className="h-11 w-full rounded-xl border-2 border-border-strong px-2 font-semibold"
            >
              <option value="">— Không nhân bản —</option>
              {(data?.roles ?? []).map((r) => (
                <option key={r.id} value={r.key}>
                  {r.key} — {r.name}
                </option>
              ))}
            </select>
          </FormField>
          <Button variant="primary" size="lg" className="w-full" onClick={createRole} loading={savingCreate}>
            <ShieldCheck className="h-4 w-4" aria-hidden /> Tạo vai trò
          </Button>
        </div>
      </Modal>

      {/* ============ Modal: Sửa vai trò ============ */}
      <Modal
        open={!!editRole}
        onClose={() => setEditRole(null)}
        title={`Sửa vai trò: ${editRole?.key ?? ""}`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditRole(null)} disabled={savingEdit}>
              Hủy
            </Button>
            <Button variant="primary" onClick={saveEdit} loading={savingEdit}>
              Lưu
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <FormField label="Tên hiển thị" required>
            <Input value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} className="h-11" />
          </FormField>
          <FormField label="Mô tả">
            <Input value={editForm.description} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })} className="h-11" />
          </FormField>
        </div>
      </Modal>

      {/* ============ Modal: Tạo quyền mới ============ */}
      <Modal open={permOpen} onClose={() => setPermOpen(false)} title="Tạo quyền mới">
        <div className="space-y-3">
          <FormField label="Key (ví dụ: reports.view)" required>
            <Input value={permForm.key} onChange={(e) => setPermForm({ ...permForm, key: e.target.value })} className="h-11 font-mono" placeholder="reports.view" />
          </FormField>
          <FormField label="Tên hiển thị" required>
            <Input value={permForm.name} onChange={(e) => setPermForm({ ...permForm, name: e.target.value })} className="h-11" />
          </FormField>
          <FormField label="Nhóm" required>
            <select value={permForm.group} onChange={(e) => setPermForm({ ...permForm, group: e.target.value })} className="h-11 w-full rounded-xl border-2 border-border-strong px-2 font-semibold">
              <option value="">— Chọn nhóm —</option>
              {(data?.groups ?? []).map((g) => (
                <option key={g.key} value={g.key}>
                  {g.label}
                </option>
              ))}
            </select>
          </FormField>
          <p className="text-[12px] text-fg-secondary">
            Quyền tự tạo chỉ có hiệu lực sau khi được gán cho ít nhất 1 vai trò ở tab Ma trận (fail-closed).
          </p>
          <Button variant="primary" size="lg" className="w-full" onClick={createPermission} loading={savingPerm}>
            <Plus className="h-4 w-4" aria-hidden /> Tạo quyền
          </Button>
        </div>
      </Modal>
    </div>
  );
}
