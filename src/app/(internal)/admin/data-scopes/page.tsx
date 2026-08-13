"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  EmptyState,
  Input,
  PageHeader,
  cn,
  toast,
} from "@/components/ui";
import {
  Building2,
  CheckSquare,
  Filter,
  Loader2,
  MapPin,
  Search,
  ShieldCheck,
  Square,
  Users,
  X,
} from "lucide-react";

type UserRow = { id: string; username: string; fullName: string; role: string };
type Dept = {
  id: string;
  stt?: number | null;
  location?: string | null;
  division?: string | null;
  deptName: string;
  section?: string | null;
  groupName: string | null;
  vnName?: string | null;
  supervisor?: string | null;
  supervisorPhone?: string | null;
};
type Scope = { userId: string; departmentId: string };

export default function DataScopesPage() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [depts, setDepts] = useState<Dept[]>([]);
  const [scopes, setScopes] = useState<Scope[]>([]);
  const [loading, setLoading] = useState(true);
  const [userSearch, setUserSearch] = useState("");

  // Drawer / Modal state for editing a user's scopes
  const [editingUser, setEditingUser] = useState<UserRow | null>(null);
  const [selectedDeptIds, setSelectedDeptIds] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  // Filter states inside the assignment panel
  const [drawerSearch, setDrawerSearch] = useState("");
  const [filterLocation, setFilterLocation] = useState("ALL");
  const [filterDivision, setFilterDivision] = useState("ALL");
  const [filterDept, setFilterDept] = useState("ALL");
  const [filterSection, setFilterSection] = useState("ALL");
  const [filterGroup, setFilterGroup] = useState("ALL");

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

  // Open drawer for a user
  const openScopeEditor = (u: UserRow) => {
    const userDeptIds = new Set(
      scopes.filter((s) => s.userId === u.id).map((s) => s.departmentId),
    );
    setEditingUser(u);
    setSelectedDeptIds(userDeptIds);
    setDrawerSearch("");
    setFilterLocation("ALL");
    setFilterDivision("ALL");
    setFilterDept("ALL");
    setFilterSection("ALL");
    setFilterGroup("ALL");
  };

  const closeScopeEditor = () => {
    if (saving) return;
    setEditingUser(null);
  };

  // Toggle single department
  const toggleDept = (deptId: string) => {
    setSelectedDeptIds((prev) => {
      const next = new Set(prev);
      if (next.has(deptId)) next.delete(deptId);
      else next.add(deptId);
      return next;
    });
  };

  // Hierarchy filter options
  const uniqueLocations = useMemo(() => {
    const set = new Set<string>();
    depts.forEach((d) => d.location && set.add(d.location));
    return Array.from(set).sort();
  }, [depts]);

  const uniqueDivisions = useMemo(() => {
    const set = new Set<string>();
    depts.forEach((d) => d.division && set.add(d.division));
    return Array.from(set).sort();
  }, [depts]);

  const uniqueDeptNames = useMemo(() => {
    const set = new Set<string>();
    depts.forEach((d) => d.deptName && set.add(d.deptName));
    return Array.from(set).sort();
  }, [depts]);

  const uniqueSections = useMemo(() => {
    const set = new Set<string>();
    depts.forEach((d) => (d.section || d.groupName) && set.add(d.section || d.groupName || ""));
    return Array.from(set).sort();
  }, [depts]);

  const uniqueGroups = useMemo(() => {
    const set = new Set<string>();
    depts.forEach((d) => d.groupName && set.add(d.groupName));
    return Array.from(set).sort();
  }, [depts]);

  // Filtered departments in drawer
  const filteredDepts = useMemo(() => {
    return depts.filter((d) => {
      if (filterLocation !== "ALL" && (d.location || "") !== filterLocation) return false;
      if (filterDivision !== "ALL" && (d.division || "") !== filterDivision) return false;
      if (filterDept !== "ALL" && d.deptName !== filterDept) return false;
      if (filterSection !== "ALL" && (d.section || d.groupName || "") !== filterSection) return false;
      if (filterGroup !== "ALL" && (d.groupName || "") !== filterGroup) return false;

      if (drawerSearch.trim()) {
        const q = drawerSearch.toLowerCase().trim();
        const loc = (d.location || "").toLowerCase();
        const div = (d.division || "").toLowerCase();
        const name = (d.deptName || "").toLowerCase();
        const sec = (d.section || "").toLowerCase();
        const grp = (d.groupName || "").toLowerCase();
        const vn = (d.vnName || "").toLowerCase();
        const sup = (d.supervisor || "").toLowerCase();
        if (
          !loc.includes(q) &&
          !div.includes(q) &&
          !name.includes(q) &&
          !sec.includes(q) &&
          !grp.includes(q) &&
          !vn.includes(q) &&
          !sup.includes(q)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [depts, filterLocation, filterDivision, filterDept, filterSection, filterGroup, drawerSearch]);

  // Select all filtered
  const selectAllFiltered = () => {
    setSelectedDeptIds((prev) => {
      const next = new Set(prev);
      filteredDepts.forEach((d) => next.add(d.id));
      return next;
    });
  };

  // Deselect all filtered
  const deselectAllFiltered = () => {
    setSelectedDeptIds((prev) => {
      const next = new Set(prev);
      filteredDepts.forEach((d) => next.delete(d.id));
      return next;
    });
  };

  // Clear all
  const clearAll = () => {
    setSelectedDeptIds(new Set());
  };

  // Save scopes batch
  const saveScopes = async () => {
    if (!editingUser) return;
    setSaving(true);
    try {
      const departmentIds = Array.from(selectedDeptIds);
      const res = await fetch("/api/admin/data-scopes", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: editingUser.id, departmentIds }),
      });
      const d = await res.json();
      if (!res.ok) {
        toast({ title: d.error ?? "Lỗi lưu phân quyền", variant: "destructive" });
        return;
      }
      toast({ title: `Đã lưu phân quyền ${departmentIds.length} bộ phận cho ${editingUser.fullName}` });
      setEditingUser(null);
      await load();
    } finally {
      setSaving(false);
    }
  };

  // Filtered users for main list
  const filteredUsers = useMemo(() => {
    if (!userSearch.trim()) return users;
    const q = userSearch.toLowerCase().trim();
    return users.filter(
      (u) => u.fullName.toLowerCase().includes(q) || u.username.toLowerCase().includes(q),
    );
  }, [users, userSearch]);

  const userScopeCounts = useMemo(() => {
    const map = new Map<string, number>();
    scopes.forEach((s) => {
      map.set(s.userId, (map.get(s.userId) ?? 0) + 1);
    });
    return map;
  }, [scopes]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Data Scope — Phân quyền phạm vi dữ liệu theo bộ phận"
        description="Áp dụng cho vai trò Quản lý bộ phận (DEPT_MANAGER). Cho phép phân quyền truy cập một hoặc nhiều bộ phận thuộc cơ cấu tổ chức Location → Division → Department → Section → Group."
      />

      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="relative min-w-[240px] flex-1 max-w-sm">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted" />
            <input
              type="text"
              placeholder="Tìm tài khoản Quản lý bộ phận..."
              value={userSearch}
              onChange={(e) => setUserSearch(e.target.value)}
              className="h-9 w-full rounded-[8px] border border-border bg-surface pl-8 pr-3 text-xs text-fg placeholder:text-fg-muted outline-none focus:border-primary"
            />
          </div>
          <p className="text-xs text-fg-muted">
            Tổng cộng: <b>{users.length}</b> tài khoản Quản lý · <b>{depts.length}</b> bộ phận trong hệ thống
          </p>
        </div>
      </Card>

      <Card className="overflow-hidden p-0">
        <CardContent className="p-0">
          {loading ? (
            <div className="p-10 text-center">
              <Loader2 className="mx-auto h-6 w-6 animate-spin text-primary" />
              <p className="mt-2 text-xs text-fg-muted">Đang tải danh sách phân quyền...</p>
            </div>
          ) : users.length === 0 ? (
            <EmptyState
              icon={<Users className="h-5 w-5" aria-hidden />}
              title="Chưa có tài khoản nào có Role DEPT_MANAGER"
              description="Vào mục Quản trị → Phân quyền RBAC để gán Role DEPT_MANAGER cho người dùng trước khi phân quyền Data Scope."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="grid-sheet w-full text-[13px]">
                <thead className="bg-primary text-white">
                  <tr>
                    <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider">Họ và tên</th>
                    <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider">Tên đăng nhập</th>
                    <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider">Vai trò</th>
                    <th className="px-4 py-3 text-center text-[11px] font-semibold uppercase tracking-wider">Số bộ phận được gán</th>
                    <th className="px-4 py-3 text-right text-[11px] font-semibold uppercase tracking-wider">Thao tác</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filteredUsers.map((u) => {
                    const count = userScopeCounts.get(u.id) ?? 0;
                    return (
                      <tr key={u.id} className="transition-colors hover:bg-surface-hover">
                        <td className="px-4 py-3 font-semibold text-fg">{u.fullName}</td>
                        <td className="px-4 py-3 font-mono text-xs text-fg-muted">{u.username}</td>
                        <td className="px-4 py-3">
                          <Badge tone="purple">
                            Quản lý bộ phận
                          </Badge>
                        </td>
                        <td className="px-4 py-3 text-center">
                          <span
                            className={cn(
                              "inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold",
                              count > 0 ? "bg-primary-tint text-primary font-bold" : "bg-surface-hover text-fg-muted",
                            )}
                          >
                            {count > 0 ? `${count} bộ phận` : "Chưa gán"}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => openScopeEditor(u)}
                            className="gap-1.5"
                          >
                            <ShieldCheck className="h-3.5 w-3.5" /> Phân quyền bộ phận
                          </Button>
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

      {/* Large Drawer / Modal for Scope Assignment */}
      {editingUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-2 sm:p-4 backdrop-blur-xs">
          <div className="flex h-[92vh] w-full max-w-[1180px] flex-col rounded-[16px] bg-surface shadow-2xl ring-1 ring-border overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-border bg-surface px-6 py-4">
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-bold text-fg">Phân quyền bộ phận cho: {editingUser.fullName}</h2>
                  <Badge tone="purple">
                    {editingUser.username}
                  </Badge>
                </div>
                <p className="text-xs text-fg-muted">
                  Chọn các bộ phận thuộc cơ cấu mà người này có quyền xem và quản lý trong màn &ldquo;Bộ phận của tôi&rdquo;.
                </p>
              </div>
              <button
                onClick={closeScopeEditor}
                disabled={saving}
                className="rounded-full p-1.5 text-fg-muted hover:bg-surface-hover hover:text-fg transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Filter Toolbar inside Drawer */}
            <div className="border-b border-border bg-surface-hover/40 px-6 py-3 space-y-2.5">
              <div className="flex flex-wrap items-center gap-2">
                {/* Search */}
                <div className="relative min-w-[200px] flex-1 max-w-xs">
                  <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-muted" />
                  <input
                    type="text"
                    placeholder="Tìm theo mã, tên, người phụ trách..."
                    value={drawerSearch}
                    onChange={(e) => setDrawerSearch(e.target.value)}
                    className="h-8 w-full rounded-[6px] border border-border bg-surface pl-8 pr-3 text-xs text-fg placeholder:text-fg-muted outline-none focus:border-primary"
                  />
                </div>

                {/* Location Filter */}
                {uniqueLocations.length > 0 && (
                  <select
                    value={filterLocation}
                    onChange={(e) => setFilterLocation(e.target.value)}
                    className="h-8 rounded-[6px] border border-border bg-surface px-2 text-xs font-medium text-fg outline-none focus:border-primary"
                  >
                    <option value="ALL">Vùng / Location: Tất cả</option>
                    {uniqueLocations.map((loc) => (
                      <option key={loc} value={loc}>
                        {loc}
                      </option>
                    ))}
                  </select>
                )}

                {/* Division Filter */}
                {uniqueDivisions.length > 0 && (
                  <select
                    value={filterDivision}
                    onChange={(e) => setFilterDivision(e.target.value)}
                    className="h-8 rounded-[6px] border border-border bg-surface px-2 text-xs font-medium text-fg outline-none focus:border-primary"
                  >
                    <option value="ALL">Khối / Division: Tất cả</option>
                    {uniqueDivisions.map((div) => (
                      <option key={div} value={div}>
                        {div}
                      </option>
                    ))}
                  </select>
                )}

                {/* Department Filter */}
                <select
                  value={filterDept}
                  onChange={(e) => setFilterDept(e.target.value)}
                  className="h-8 rounded-[6px] border border-border bg-surface px-2 text-xs font-medium text-fg outline-none focus:border-primary"
                >
                  <option value="ALL">Department: Tất cả</option>
                  {uniqueDeptNames.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>

                {/* Section / Group Filter */}
                {uniqueGroups.length > 0 && (
                  <select
                    value={filterGroup}
                    onChange={(e) => setFilterGroup(e.target.value)}
                    className="h-8 rounded-[6px] border border-border bg-surface px-2 text-xs font-medium text-fg outline-none focus:border-primary"
                  >
                    <option value="ALL">Group / Nhóm: Tất cả</option>
                    {uniqueGroups.map((grp) => (
                      <option key={grp} value={grp}>
                        {grp}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {/* Selection action bar */}
              <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-fg">
                    Đã chọn: <b className="text-primary font-bold">{selectedDeptIds.size}</b> / {depts.length} bộ phận
                  </span>
                  <span className="text-fg-muted">· Đang hiển thị: {filteredDepts.length} dòng</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={selectAllFiltered}
                    className="rounded-[6px] bg-primary-tint px-2.5 py-1 text-xs font-semibold text-primary hover:bg-primary/15 transition-colors"
                  >
                    Chọn tất cả ({filteredDepts.length})
                  </button>
                  <button
                    type="button"
                    onClick={deselectAllFiltered}
                    className="rounded-[6px] bg-surface-hover px-2.5 py-1 text-xs font-semibold text-fg-secondary hover:bg-border transition-colors"
                  >
                    Bỏ chọn kết quả lọc
                  </button>
                  <button
                    type="button"
                    onClick={clearAll}
                    className="rounded-[6px] bg-surface-hover px-2.5 py-1 text-xs font-semibold text-danger hover:bg-danger-tint transition-colors"
                  >
                    Xoá toàn bộ đã chọn
                  </button>
                </div>
              </div>
            </div>

            {/* Scrollable Department Table */}
            <div className="flex-1 overflow-y-auto p-0">
              <table className="grid-sheet w-full text-[13px]">
                <thead className="sticky top-0 z-10 bg-surface-hover text-fg font-semibold border-b border-border shadow-xs">
                  <tr>
                    <th className="w-12 px-3 py-2.5 text-center text-[11px] uppercase">
                      Chọn
                    </th>
                    <th className="px-3 py-2.5 text-left text-[11px] uppercase">Location</th>
                    <th className="px-3 py-2.5 text-left text-[11px] uppercase">Division</th>
                    <th className="px-3 py-2.5 text-left text-[11px] uppercase">Department</th>
                    <th className="px-3 py-2.5 text-left text-[11px] uppercase">Section</th>
                    <th className="px-3 py-2.5 text-left text-[11px] uppercase">Group</th>
                    <th className="px-3 py-2.5 text-left text-[11px] uppercase">Tên Tiếng Việt</th>
                    <th className="px-3 py-2.5 text-left text-[11px] uppercase">Phụ trách</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filteredDepts.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="p-8 text-center text-sm text-fg-muted">
                        Không có bộ phận nào khớp với điều kiện lọc.
                      </td>
                    </tr>
                  ) : (
                    filteredDepts.map((d) => {
                      const isSelected = selectedDeptIds.has(d.id);
                      return (
                        <tr
                          key={d.id}
                          onClick={() => toggleDept(d.id)}
                          className={cn(
                            "cursor-pointer transition-colors hover:bg-surface-hover",
                            isSelected && "bg-primary-tint/50 font-medium",
                          )}
                        >
                          <td className="px-3 py-2.5 text-center">
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => toggleDept(d.id)}
                              onClick={(e) => e.stopPropagation()}
                              className="h-4 w-4 rounded accent-primary cursor-pointer"
                            />
                          </td>
                          <td className="px-3 py-2.5 text-fg-secondary text-xs">{d.location || "—"}</td>
                          <td className="px-3 py-2.5 text-fg-secondary text-xs">{d.division || "—"}</td>
                          <td className="px-3 py-2.5 font-bold text-fg">{d.deptName}</td>
                          <td className="px-3 py-2.5 text-fg-secondary text-xs">{d.section || d.groupName || "—"}</td>
                          <td className="px-3 py-2.5 text-fg font-medium">{d.groupName || "—"}</td>
                          <td className="px-3 py-2.5 text-fg-secondary text-xs">{d.vnName || "—"}</td>
                          <td className="px-3 py-2.5 text-fg-secondary text-xs">
                            {d.supervisor ? `${d.supervisor}${d.supervisorPhone ? ` (${d.supervisorPhone})` : ""}` : "—"}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            {/* Sticky Footer */}
            <div className="flex items-center justify-between border-t border-border bg-surface px-6 py-4">
              <div className="text-xs text-fg-secondary">
                Đang chọn: <b className="text-primary font-bold">{selectedDeptIds.size}</b> bộ phận cho tài khoản <b>{editingUser.fullName}</b>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={closeScopeEditor} disabled={saving}>
                  Hủy
                </Button>
                <Button variant="primary" onClick={saveScopes} loading={saving}>
                  Lưu phân quyền ({selectedDeptIds.size})
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
