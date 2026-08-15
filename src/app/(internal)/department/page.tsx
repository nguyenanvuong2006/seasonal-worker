"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  EmptyState,
  FormField,
  Input,
  KpiCard,
  Modal,
  StatusBadge,
  cn,
  toast,
} from "@/components/ui";
import {
  ArrowLeftRight,
  Calendar,
  Download,
  FileSpreadsheet,
  Loader2,
  Percent,
  Search,
  Target,
  UserMinus,
  Users,
} from "lucide-react";
import { formatDate, todayStr } from "@/lib/helpers";

type AppRow = {
  id: string;
  regDate: string;
  cccd: string;
  fullName: string;
  gender: string | null;
  phone: string;
  deptId: string | null;
  deptName: string | null;
  groupName: string | null;
  vnName: string | null;
  location: string | null;
  division: string | null;
  section: string | null;
  supervisor: string | null;
  supervisorPhone: string | null;
  status: string;
  startingDate: string | null;
  dwMatch: string;
  workerId?: string | null;
};

type Dept = {
  id: string;
  deptName: string;
  groupName: string | null;
  vnName: string | null;
  location?: string | null;
  division?: string | null;
  section?: string | null;
  dailyQuota?: number;
};

export default function MyDepartmentPage() {
  const [rows, setRows] = useState<AppRow[]>([]);
  const [depts, setDepts] = useState<Dept[]>([]);
  const [loading, setLoading] = useState(true);

  // Date filters (defaults to today)
  const [from, setFrom] = useState(() => todayStr());
  const [to, setTo] = useState(() => todayStr());

  // Search & hierarchy filters — DEPENDENT chain (dept -> group), scoped
  const [search, setSearch] = useState("");
  const [filterDeptId, setFilterDeptId] = useState("ALL");
  const [filterGroup, setFilterGroup] = useState("ALL");

  // Multi-selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Bulk Resignation modal
  const [resignationModalOpen, setResignationModalOpen] = useState(false);
  const [resignationTargetRows, setResignationTargetRows] = useState<AppRow[]>([]);
  const [resignationReasons, setResignationReasons] = useState<Record<string, string>>({});
  const [effectiveDate, setEffectiveDate] = useState(() => todayStr());
  const [resignationNote, setResignationNote] = useState("");
  const [submittingResignation, setSubmittingResignation] = useState(false);

  // Bulk Transfer modal
  const [transferModalOpen, setTransferModalOpen] = useState(false);
  const [transferTargetRows, setTransferTargetRows] = useState<AppRow[]>([]);
  const [transferReasons, setTransferReasons] = useState<Record<string, string>>({});
  const [transferToDeptId, setTransferToDeptId] = useState("");
  const [transferDate, setTransferDate] = useState(() => todayStr());
  const [transferNote, setTransferNote] = useState("");
  const [submittingTransfer, setSubmittingTransfer] = useState(false);

  // Load departments and scoped registrations
  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [regRes, deptRes] = await Promise.all([
        // API tự áp Data Scope thật của tài khoản đang đăng nhập (server-side, không tin client)
        fetch(`/api/registrations?from=${from}&to=${to}`),
        fetch("/api/departments?scope=self"),
      ]);

      if (!regRes.ok || !deptRes.ok) {
        toast({ title: "Không thể tải dữ liệu", variant: "destructive" });
        setLoading(false);
        return;
      }

      const regData = await regRes.json();
      const deptData = await deptRes.json();

      setRows(regData.rows ?? []);
      setDepts(deptData.rows ?? []);
    } catch (e) {
      toast({ title: "Lỗi kết nối", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // Bộ phận được phân quyền = chính danh sách /api/departments?scope=self
  const scopedDeptIds = useMemo(() => new Set(depts.map((d) => d.id)), [depts]);

  // Unique department names — CHỈ trong phạm vi phân quyền
  const uniqueDeptNames = useMemo(() => {
    const set = new Set<string>();
    depts.forEach((d) => d.deptName && set.add(d.deptName));
    return Array.from(set).sort();
  }, [depts]);

  // Groups DEPENDENT on selected department — chỉ nhóm thuộc bộ phận đang chọn
  const groupsForSelectedDept = useMemo(() => {
    const set = new Set<string>();
    if (filterDeptId === "ALL") {
      depts.forEach((d) => d.groupName && set.add(d.groupName));
    } else {
      const dept = depts.find((d) => d.id === filterDeptId);
      if (dept?.groupName) set.add(dept.groupName);
    }
    return Array.from(set).sort();
  }, [depts, filterDeptId]);

  // Reset dependent group khi đổi bộ phận
  const changeDept = (deptId: string) => {
    setFilterDeptId(deptId);
    setFilterGroup("ALL");
  };

  // Filtered rows — scope + filter bộ phận/nhóm đã chọn
  const filteredRows = useMemo(() => {
    return rows.filter((r) => {
      // Chỉ giữ người thuộc bộ phận được phân quyền (lưới an toàn phía client)
      if (r.deptId && !scopedDeptIds.has(r.deptId)) return false;
      if (filterDeptId !== "ALL" && r.deptId !== filterDeptId) return false;
      if (filterGroup !== "ALL" && (r.groupName || "") !== filterGroup) return false;

      if (search.trim()) {
        const q = search.toLowerCase().trim();
        const name = (r.fullName || "").toLowerCase();
        const cccd = (r.cccd || "").toLowerCase();
        const phone = (r.phone || "").toLowerCase();
        const dept = (r.deptName || "").toLowerCase();
        const grp = (r.groupName || "").toLowerCase();
        if (!name.includes(q) && !cccd.includes(q) && !phone.includes(q) && !dept.includes(q) && !grp.includes(q)) {
          return false;
        }
      }
      return true;
    });
  }, [rows, scopedDeptIds, filterDeptId, filterGroup, search]);

  // Toggle row selection
  const toggleRow = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Select all visible
  const selectAllVisible = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      filteredRows.forEach((r) => next.add(r.id));
      return next;
    });
  };

  // Deselect all
  const deselectAll = () => {
    setSelectedIds(new Set());
  };

  const isAllVisibleSelected =
    filteredRows.length > 0 && filteredRows.every((r) => selectedIds.has(r.id));

  // Mở modal Báo nghỉ việc (1 người hoặc nhiều người được tick)
  const openResignation = (rows: AppRow[]) => {
    if (rows.length === 0) return;
    setResignationTargetRows(rows);
    // Lý do mặc định có thể sửa riêng từng người ngay trong bảng thông tin
    setResignationReasons(
      Object.fromEntries(rows.map((r) => [r.id, "Nghỉ Tập nghề theo nguyện vọng cá nhân"])),
    );
    setEffectiveDate(todayStr());
    setResignationNote("");
    setResignationModalOpen(true);
  };

  // Mở modal Báo thuyên chuyển (1 người hoặc nhiều người được tick)
  const openTransfer = (rows: AppRow[]) => {
    if (rows.length === 0) return;
    setTransferTargetRows(rows);
    setTransferReasons(Object.fromEntries(rows.map((r) => [r.id, ""])));
    setTransferToDeptId("");
    setTransferDate(todayStr());
    setTransferNote("");
    setTransferModalOpen(true);
  };

  // Submit Resignation (single or bulk)
  const submitResignation = async () => {
    if (resignationTargetRows.length === 0) return;
    setSubmittingResignation(true);
    let successCount = 0;
    let failCount = 0;

    for (const r of resignationTargetRows) {
      try {
        // Find workerId from worker profile if not directly present
        let workerId = r.workerId;
        if (!workerId) {
          const profileRes = await fetch(`/api/worker-profiles/${r.cccd}`);
          if (profileRes.ok) {
            const pData = await profileRes.json();
            workerId = pData.profile?.id;
          }
        }

        if (!workerId) {
          failCount++;
          continue;
        }

        const res = await fetch("/api/workforce-movements", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            movementType: "resignation",
            workerId,
            effectiveDate,
            reason: resignationReasons[r.id]?.trim() || "Nghỉ Tập nghề",
            note: resignationNote || null,
          }),
        });

        if (res.ok) successCount++;
        else failCount++;
      } catch (e) {
        failCount++;
      }
    }

    setSubmittingResignation(false);
    setResignationModalOpen(false);

    if (successCount > 0) {
      toast({
        title: `Đã tạo ${successCount} yêu cầu nghỉ Tập nghề thành công (chờ HR duyệt)`,
      });
      deselectAll();
      await loadData();
    }
    if (failCount > 0) {
      toast({
        title: `Có ${failCount} người không thể tạo yêu cầu nghỉ (chưa có hồ sơ Tập nghề)`,
        variant: "destructive",
      });
    }
  };

  // Submit Transfer (single or bulk)
  const submitTransfer = async () => {
    if (transferTargetRows.length === 0) return;
    if (!transferToDeptId) {
      toast({ title: "Vui lòng chọn Bộ phận mới để chuyển đến.", variant: "destructive" });
      return;
    }
    setSubmittingTransfer(true);
    let successCount = 0;
    let failCount = 0;

    for (const r of transferTargetRows) {
      try {
        let workerId = r.workerId;
        if (!workerId) {
          const profileRes = await fetch(`/api/worker-profiles/${r.cccd}`);
          if (profileRes.ok) {
            const pData = await profileRes.json();
            workerId = pData.profile?.id;
          }
        }

        if (!workerId) {
          failCount++;
          continue;
        }

        const res = await fetch("/api/workforce-movements", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            movementType: "transfer",
            workerId,
            toDeptId: transferToDeptId,
            effectiveDate: transferDate,
            reason: transferReasons[r.id]?.trim() || null,
            note: transferNote || null,
          }),
        });

        if (res.ok) successCount++;
        else failCount++;
      } catch (e) {
        failCount++;
      }
    }

    setSubmittingTransfer(false);
    setTransferModalOpen(false);

    if (successCount > 0) {
      toast({
        title: `Đã tạo ${successCount} yêu cầu thuyên chuyển thành công (chờ HR duyệt)`,
      });
      deselectAll();
      await loadData();
    }
    if (failCount > 0) {
      toast({
        title: `Có ${failCount} người không thể tạo yêu cầu thuyên chuyển (chưa có hồ sơ Tập nghề)`,
        variant: "destructive",
      });
    }
  };

  // Export selected or all visible to CSV/Excel
  const exportData = () => {
    const targetRows = selectedIds.size > 0
      ? filteredRows.filter((r) => selectedIds.has(r.id))
      : filteredRows;

    if (targetRows.length === 0) {
      toast({ title: "Không có dữ liệu để xuất", variant: "destructive" });
      return;
    }

    const headers = [
      "STT",
      "Ngày",
      "Họ và tên",
      "SĐT",
      "Giới tính",
      "Department",
      "Section",
      "Group",
      "Ngày bắt đầu",
      "Trạng thái",
    ];

    const csvRows = [
      headers.join(","),
      ...targetRows.map((r, i) =>
        [
          i + 1,
          r.regDate,
          `"${(r.fullName || "").replace(/"/g, '""')}"`,
          `"${r.phone || ""}"`,
          r.gender || "",
          `"${(r.deptName || "").replace(/"/g, '""')}"`,
          `"${(r.section || "").replace(/"/g, '""')}"`,
          `"${(r.groupName || "").replace(/"/g, '""')}"`,
          r.startingDate || "",
          r.status || "",
        ].join(","),
      ),
    ];

    const blob = new Blob(["\uFEFF" + csvRows.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Danh_sach_Tap_nghe_${from}_den_${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: `Đã xuất ${targetRows.length} dòng dữ liệu` });
  };

  // KPIs
  const activeCount = filteredRows.filter((r) => r.status === "APPROVED").length;
  const inactiveCount = filteredRows.filter((r) => r.status === "INACTIVE").length;
  const totalQuota = depts.reduce((acc, d) => acc + (d.dailyQuota || 0), 0);

  return (
    <div className="space-y-5 pb-20">
      {/* Page Header */}
      <Card className="p-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <Badge tone="purple">Cổng Bộ phận tiếp nhận Tập nghề</Badge>
            <h1 className="mt-2 text-2xl font-bold tracking-tight text-fg">
              Bộ phận của tôi — Danh sách người tập nghề
            </h1>
            <p className="text-xs text-fg-secondary">
              Chỉ hiển thị người tập nghề thuộc bộ phận và nhóm được phân quyền (Data Scope) của bạn.
            </p>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <div>
              <p className="mb-1 text-[11px] font-semibold text-fg-muted">Từ ngày</p>
              <input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                className="h-9 rounded-[8px] border border-border bg-surface px-2.5 text-xs font-medium text-fg outline-none focus:border-primary"
              />
            </div>
            <div>
              <p className="mb-1 text-[11px] font-semibold text-fg-muted">Đến ngày</p>
              <input
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="h-9 rounded-[8px] border border-border bg-surface px-2.5 text-xs font-medium text-fg outline-none focus:border-primary"
              />
            </div>
            <Button variant="primary" size="sm" onClick={loadData} className="h-9">
              Xem
            </Button>
            <Button variant="outline" size="sm" onClick={exportData} className="h-9 gap-1.5">
              <Download className="h-4 w-4" /> Xuất Excel / CSV
            </Button>
          </div>
        </div>
      </Card>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard
          icon={<Users className="h-4 w-4" />}
          label="Đang tập nghề"
          value={activeCount}
          context={`${filteredRows.length} người trong khoảng ngày`}
          tone="primary"
        />
        <KpiCard
          icon={<Target className="h-4 w-4" />}
          label="Nhu cầu nhân lực"
          value={totalQuota > 0 ? totalQuota : "—"}
          tone="warning"
        />
        <KpiCard
          icon={<Calendar className="h-4 w-4" />}
          label="Đã nghỉ việc"
          value={inactiveCount}
          tone="info"
        />
        <KpiCard
          icon={<Percent className="h-4 w-4" />}
          label="Tỷ lệ đáp ứng nhu cầu"
          value={totalQuota > 0 ? `${Math.round((activeCount / totalQuota) * 100)}%` : "100%"}
          tone="success"
        />
      </div>

      {/* Hierarchy Filter Toolbar — chỉ hiển thị bộ phận/nhóm được phân quyền */}
      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2 flex-1">
            {/* Search Input */}
            <div className="relative min-w-[200px] flex-1 max-w-xs">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-muted" />
              <input
                type="text"
                placeholder="Tìm theo tên, CCCD, SĐT..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-8 w-full rounded-[6px] border border-border bg-surface pl-8 pr-3 text-xs text-fg placeholder:text-fg-muted outline-none focus:border-primary"
              />
            </div>

            {/* Department filter — chỉ bộ phận được phân quyền */}
            <select
              value={filterDeptId}
              onChange={(e) => changeDept(e.target.value)}
              className="h-8 max-w-[200px] rounded-[6px] border border-border bg-surface px-2 text-xs font-medium text-fg outline-none focus:border-primary"
            >
              <option value="ALL">Department: Tất cả ({uniqueDeptNames.length})</option>
              {uniqueDeptNames.map((d) => {
                const deptRow = depts.find((x) => x.deptName === d);
                return (
                  <option key={d} value={deptRow?.id ?? d}>
                    {d}
                  </option>
                );
              })}
            </select>

            {/* Group filter — dependent vào bộ phận đã chọn */}
            {groupsForSelectedDept.length > 0 && (
              <select
                value={filterGroup}
                onChange={(e) => setFilterGroup(e.target.value)}
                className="h-8 rounded-[6px] border border-border bg-surface px-2 text-xs font-medium text-fg outline-none focus:border-primary"
              >
                <option value="ALL">Group: Tất cả</option>
                {groupsForSelectedDept.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Quick selection summary */}
          <div className="flex items-center gap-2 text-xs text-fg-muted">
            <span>Hiển thị: <b>{filteredRows.length}</b> người</span>
            {selectedIds.size > 0 && (
              <span className="font-semibold text-primary">· Đã chọn {selectedIds.size} người</span>
            )}
          </div>
        </div>
      </Card>

      {/* Main Table */}
      <Card className="overflow-hidden p-0">
        <CardHeader
          title={`Danh sách Tập nghề (${formatDate(from)}${from !== to ? " → " + formatDate(to) : ""})`}
          right={
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={isAllVisibleSelected ? deselectAll : selectAllVisible}
                className="text-xs font-semibold text-primary hover:underline"
              >
                {isAllVisibleSelected ? "Bỏ chọn tất cả" : `Chọn tất cả (${filteredRows.length})`}
              </button>
            </div>
          }
        />
        <CardContent className="p-0">
          {loading ? (
            <div className="p-10 text-center">
              <Loader2 className="mx-auto h-6 w-6 animate-spin text-primary" />
              <p className="mt-2 text-xs text-fg-muted">Đang tải danh sách người tập nghề...</p>
            </div>
          ) : filteredRows.length === 0 ? (
            <EmptyState
              icon={<Users className="h-5 w-5" aria-hidden />}
              title="Không có người tập nghề nào"
              description="Không có người tập nghề nào được xếp cho bộ phận được phân quyền trong khoảng thời gian đã chọn."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="grid-sheet w-full text-[13px]">
                <thead className="bg-primary text-white">
                  <tr>
                    <th className="w-10 px-3 py-2.5 text-center">
                      <input
                        type="checkbox"
                        checked={isAllVisibleSelected}
                        onChange={isAllVisibleSelected ? deselectAll : selectAllVisible}
                        className="h-4 w-4 rounded accent-primary cursor-pointer"
                      />
                    </th>
                    <th className="w-12 px-3 py-2.5 text-center text-[10.5px] uppercase">#</th>
                    <th className="px-3 py-2.5 text-left text-[10.5px] uppercase">Họ và tên</th>
                    <th className="px-3 py-2.5 text-center text-[10.5px] uppercase">Giới tính</th>
                    <th className="px-3 py-2.5 text-left text-[10.5px] uppercase">Department</th>
                    <th className="px-3 py-2.5 text-left text-[10.5px] uppercase">Section</th>
                    <th className="px-3 py-2.5 text-left text-[10.5px] uppercase">Group</th>
                    <th className="px-3 py-2.5 text-left text-[10.5px] uppercase">Ngày bắt đầu</th>
                    <th className="px-3 py-2.5 text-center text-[10.5px] uppercase">Trạng thái</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filteredRows.map((r, i) => {
                    const isSelected = selectedIds.has(r.id);
                    return (
                      <tr
                        key={r.id}
                        onClick={() => toggleRow(r.id)}
                        className={cn(
                          "transition-colors hover:bg-surface-hover cursor-pointer",
                          isSelected && "bg-primary-tint/50 font-medium",
                        )}
                      >
                        <td className="px-3 py-2.5 text-center">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleRow(r.id)}
                            onClick={(e) => e.stopPropagation()}
                            className="h-4 w-4 rounded accent-primary cursor-pointer"
                          />
                        </td>
                        <td className="px-3 py-2.5 text-center text-xs text-fg-muted">{i + 1}</td>
                        <td className="px-3 py-2.5 font-bold text-fg">{r.fullName}</td>
                        <td className="px-3 py-2.5 text-center">
                          <Badge tone={r.gender === "Nữ" ? "purple" : "blue"}>
                            {r.gender ?? "—"}
                          </Badge>
                        </td>
                        <td className="px-3 py-2.5 text-fg font-semibold">{r.deptName || "—"}</td>
                        <td className="px-3 py-2.5 text-xs text-fg-secondary">{r.section || "—"}</td>
                        <td className="px-3 py-2.5 text-xs text-fg-secondary">{r.groupName || "—"}</td>
                        <td className="px-3 py-2.5 text-xs text-fg-secondary">
                          {formatDate(r.startingDate || r.regDate)}
                        </td>
                        <td className="px-3 py-2.5 text-center">
                          <StatusBadge status={r.status} />
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

      {/* Floating Bulk Action Bar */}
      {selectedIds.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex flex-wrap items-center justify-center gap-3 rounded-[12px] bg-[#0B2E19] text-white px-5 py-3 shadow-xl ring-1 ring-white/10 animate-in slide-in-from-bottom-4 duration-200">
          <span className="text-xs font-semibold">
            Đã chọn <b className="text-accent text-sm">{selectedIds.size}</b> người tập nghề
          </span>
          <div className="h-4 w-px bg-white/20" />
          <Button
            variant="danger"
            size="sm"
            onClick={() => openResignation(filteredRows.filter((r) => selectedIds.has(r.id)))}
            className="gap-1.5 text-xs font-semibold bg-danger hover:bg-danger-hover text-white"
          >
            <UserMinus className="h-3.5 w-3.5" /> Báo nghỉ việc ({selectedIds.size})
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => openTransfer(filteredRows.filter((r) => selectedIds.has(r.id)))}
            className="gap-1.5 text-xs font-semibold bg-accent hover:bg-accent-hover text-white"
          >
            <ArrowLeftRight className="h-3.5 w-3.5" /> Báo thuyên chuyển ({selectedIds.size})
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={exportData}
            className="gap-1.5 text-xs text-white border-white/30 bg-white/10 hover:bg-white/20"
          >
            <FileSpreadsheet className="h-3.5 w-3.5" /> Xuất ({selectedIds.size})
          </Button>
          <button
            type="button"
            onClick={deselectAll}
            className="text-xs text-white/70 hover:text-white underline ml-1"
          >
            Bỏ chọn
          </button>
        </div>
      )}

      {/* Modal: Báo nghỉ Tập nghề (Single or Bulk) */}
      <Modal
        open={resignationModalOpen}
        onClose={() => setResignationModalOpen(false)}
        title={
          resignationTargetRows.length > 1
            ? `Báo Nghỉ Việc Hàng Loạt (${resignationTargetRows.length} Người Tập Nghề)`
            : `Báo Nghỉ Tập Nghề — ${resignationTargetRows[0]?.fullName ?? ""}`
        }
      >
        <div className="space-y-4">
          <p className="text-xs text-fg-muted">
            Yêu cầu báo nghỉ sẽ được gửi tới Phòng Nhân sự (HR Recruiter) để duyệt và cập nhật chỉ số nghỉ việc vào Kế hoạch Tập nghề.
          </p>

          {/* Bảng thông tin gọn của tất cả người được chọn — nhập Lý do nghỉ việc cho từng người */}
          <div className="max-h-52 overflow-auto rounded-[8px] border border-border">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-primary text-white">
                <tr>
                  <th className="px-2 py-1.5 text-left text-[10px] uppercase">Họ và tên</th>
                  <th className="px-2 py-1.5 text-left text-[10px] uppercase">Giới tính</th>
                  <th className="px-2 py-1.5 text-left text-[10px] uppercase">Department</th>
                  <th className="px-2 py-1.5 text-left text-[10px] uppercase">Section</th>
                  <th className="px-2 py-1.5 text-left text-[10px] uppercase">Group</th>
                  <th className="px-2 py-1.5 text-left text-[10px] uppercase">Ngày bắt đầu</th>
                  <th className="px-2 py-1.5 text-left text-[10px] uppercase">Trạng thái</th>
                  <th className="min-w-[180px] px-2 py-1.5 text-left text-[10px] uppercase">Lý do nghỉ việc</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {resignationTargetRows.map((r) => (
                  <tr key={r.id} className="bg-surface">
                    <td className="px-2 py-1.5 font-semibold text-fg">{r.fullName}</td>
                    <td className="px-2 py-1.5 text-fg-secondary">{r.gender ?? "—"}</td>
                    <td className="px-2 py-1.5 text-fg-secondary">{r.deptName || "—"}</td>
                    <td className="px-2 py-1.5 text-fg-secondary">{r.section || "—"}</td>
                    <td className="px-2 py-1.5 text-fg-secondary">{r.groupName || "—"}</td>
                    <td className="px-2 py-1.5 text-fg-secondary">{formatDate(r.startingDate || r.regDate)}</td>
                    <td className="px-2 py-1.5"><StatusBadge status={r.status} /></td>
                    <td className="px-2 py-1.5">
                      <input
                        type="text"
                        placeholder="Nhập lý do..."
                        value={resignationReasons[r.id] ?? ""}
                        onChange={(e) =>
                          setResignationReasons((prev) => ({ ...prev, [r.id]: e.target.value }))
                        }
                        className="h-7 w-full min-w-[170px] rounded-[6px] border border-border bg-surface px-2 text-xs text-fg outline-none focus:border-primary"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <FormField label="Ngày có hiệu lực (Effective Date)" required>
            <Input
              type="date"
              value={effectiveDate}
              onChange={(e) => setEffectiveDate(e.target.value)}
            />
          </FormField>

          <FormField label="Ghi chú thêm">
            <Input
              placeholder="Ghi chú bàn giao hoặc thông tin khác..."
              value={resignationNote}
              onChange={(e) => setResignationNote(e.target.value)}
            />
          </FormField>

          <Button
            variant="danger"
            size="lg"
            className="w-full"
            loading={submittingResignation}
            onClick={submitResignation}
          >
            Xác nhận gửi yêu cầu báo nghỉ ({resignationTargetRows.length})
          </Button>
        </div>
      </Modal>

      {/* Modal: Báo thuyên chuyển (Single or Bulk) */}
      <Modal
        open={transferModalOpen}
        onClose={() => setTransferModalOpen(false)}
        title={
          transferTargetRows.length > 1
            ? `Báo Thuyên Chuyển Hàng Loạt (${transferTargetRows.length} Người Tập Nghề)`
            : `Báo Thuyên Chuyển — ${transferTargetRows[0]?.fullName ?? ""}`
        }
      >
        <div className="space-y-4">
          <p className="text-xs text-fg-muted">
            Yêu cầu thuyên chuyển sẽ được gửi tới Phòng Nhân sự (HR Recruiter) để duyệt. Bộ phận mới có thể là bất kỳ bộ phận nào trong hệ thống (không giới hạn theo phân quyền của bạn).
          </p>

          {/* Bảng thông tin gọn của tất cả người được chọn — nhập Lý do thuyên chuyển cho từng người */}
          <div className="max-h-52 overflow-auto rounded-[8px] border border-border">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-primary text-white">
                <tr>
                  <th className="px-2 py-1.5 text-left text-[10px] uppercase">Họ và tên</th>
                  <th className="px-2 py-1.5 text-left text-[10px] uppercase">Giới tính</th>
                  <th className="px-2 py-1.5 text-left text-[10px] uppercase">Department</th>
                  <th className="px-2 py-1.5 text-left text-[10px] uppercase">Section</th>
                  <th className="px-2 py-1.5 text-left text-[10px] uppercase">Group</th>
                  <th className="px-2 py-1.5 text-left text-[10px] uppercase">Ngày bắt đầu</th>
                  <th className="px-2 py-1.5 text-left text-[10px] uppercase">Trạng thái</th>
                  <th className="min-w-[180px] px-2 py-1.5 text-left text-[10px] uppercase">Lý do thuyên chuyển</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {transferTargetRows.map((r) => (
                  <tr key={r.id} className="bg-surface">
                    <td className="px-2 py-1.5 font-semibold text-fg">{r.fullName}</td>
                    <td className="px-2 py-1.5 text-fg-secondary">{r.gender ?? "—"}</td>
                    <td className="px-2 py-1.5 text-fg-secondary">{r.deptName || "—"}</td>
                    <td className="px-2 py-1.5 text-fg-secondary">{r.section || "—"}</td>
                    <td className="px-2 py-1.5 text-fg-secondary">{r.groupName || "—"}</td>
                    <td className="px-2 py-1.5 text-fg-secondary">{formatDate(r.startingDate || r.regDate)}</td>
                    <td className="px-2 py-1.5"><StatusBadge status={r.status} /></td>
                    <td className="px-2 py-1.5">
                      <input
                        type="text"
                        placeholder="Nhập lý do..."
                        value={transferReasons[r.id] ?? ""}
                        onChange={(e) =>
                          setTransferReasons((prev) => ({ ...prev, [r.id]: e.target.value }))
                        }
                        className="h-7 w-full min-w-[170px] rounded-[6px] border border-border bg-surface px-2 text-xs text-fg outline-none focus:border-primary"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <FormField label="Bộ phận mới (Bộ phận nhận thuyên chuyển)" required>
            <AllTransferDeptOptions value={transferToDeptId} onChange={setTransferToDeptId} />
            <p className="mt-1 text-[11px] text-fg-muted">
              Danh sách gồm toàn bộ bộ phận trong hệ thống để bộ phận nhận thuyên chuyển có thể cập nhật thông tin.
            </p>
          </FormField>

          <FormField label="Ngày thuyên chuyển" required>
            <Input
              type="date"
              value={transferDate}
              onChange={(e) => setTransferDate(e.target.value)}
            />
          </FormField>

          <FormField label="Ghi chú thêm">
            <Input
              placeholder="Ghi chú bàn giao hoặc thông tin khác..."
              value={transferNote}
              onChange={(e) => setTransferNote(e.target.value)}
            />
          </FormField>

          <Button
            variant="primary"
            size="lg"
            className="w-full"
            loading={submittingTransfer}
            onClick={submitTransfer}
          >
            Xác nhận gửi yêu cầu thuyên chuyển ({transferTargetRows.length})
          </Button>
        </div>
      </Modal>
    </div>
  );
}

/** Toàn bộ bộ phận trong hệ thống (không giới hạn phân quyền) — cho dropdown Bộ phận mới. */
function AllTransferDeptOptions({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [allDepts, setAllDepts] = useState<Dept[]>([]);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/departments?scope=all");
        if (res.ok) {
          const data = await res.json();
          setAllDepts(data.rows ?? []);
        }
      } catch {
        /* giữ dropdown trống nếu không tải được */
      }
    })();
  }, []);

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-10 w-full rounded-[10px] border border-border-strong bg-surface px-3 text-[14px] font-medium text-fg outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
    >
      <option value="">— Chọn bộ phận mới —</option>
      {allDepts.map((d) => (
        <option key={d.id} value={d.id}>
          {d.deptName}
          {d.groupName ? ` — ${d.groupName}` : ""}
        </option>
      ))}
    </select>
  );
}
