"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
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
  PageHeader,
  cn,
  toast,
} from "@/components/ui";
import {
  Building2,
  Calendar,
  Check,
  CheckSquare,
  ChevronDown,
  Download,
  FileSpreadsheet,
  Filter,
  IdCard,
  Loader2,
  Percent,
  Search,
  Square,
  Target,
  UserMinus,
  UserPlus2,
  Users,
  X,
} from "lucide-react";
import { formatDate, maskCccd, todayStr } from "@/lib/helpers";

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

  // Search & hierarchy filters
  const [search, setSearch] = useState("");
  const [filterLocation, setFilterLocation] = useState("ALL");
  const [filterDivision, setFilterDivision] = useState("ALL");
  const [filterDept, setFilterDept] = useState("ALL");
  const [filterSection, setFilterSection] = useState("ALL");
  const [filterGroup, setFilterGroup] = useState("ALL");

  // Multi-selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Bulk Resignation modal
  const [resignationModalOpen, setResignationModalOpen] = useState(false);
  const [resignationTargetRows, setResignationTargetRows] = useState<AppRow[]>([]);
  const [effectiveDate, setEffectiveDate] = useState(() => todayStr());
  const [resignationReason, setResignationReason] = useState("");
  const [resignationNote, setResignationNote] = useState("");
  const [submittingResignation, setSubmittingResignation] = useState(false);

  // Load departments and registrations
  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [regRes, deptRes] = await Promise.all([
        fetch(`/api/registrations?from=${from}&to=${to}`),
        fetch("/api/departments"),
      ]);

      if (!regRes.ok) {
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

  // Unique values for dropdown filters
  const uniqueLocations = useMemo(() => {
    const set = new Set<string>();
    depts.forEach((d) => d.location && set.add(d.location));
    rows.forEach((r) => r.location && set.add(r.location));
    return Array.from(set).sort();
  }, [depts, rows]);

  const uniqueDivisions = useMemo(() => {
    const set = new Set<string>();
    depts.forEach((d) => d.division && set.add(d.division));
    rows.forEach((r) => r.division && set.add(r.division));
    return Array.from(set).sort();
  }, [depts, rows]);

  const uniqueDeptNames = useMemo(() => {
    const set = new Set<string>();
    depts.forEach((d) => d.deptName && set.add(d.deptName));
    rows.forEach((r) => r.deptName && set.add(r.deptName));
    return Array.from(set).sort();
  }, [depts, rows]);

  const uniqueSections = useMemo(() => {
    const set = new Set<string>();
    depts.forEach((d) => (d.section || d.groupName) && set.add(d.section || d.groupName || ""));
    rows.forEach((r) => (r.section || r.groupName) && set.add(r.section || r.groupName || ""));
    return Array.from(set).sort();
  }, [depts, rows]);

  const uniqueGroups = useMemo(() => {
    const set = new Set<string>();
    depts.forEach((d) => d.groupName && set.add(d.groupName));
    rows.forEach((r) => r.groupName && set.add(r.groupName));
    return Array.from(set).sort();
  }, [depts, rows]);

  // Filtered rows
  const filteredRows = useMemo(() => {
    return rows.filter((r) => {
      if (filterLocation !== "ALL" && (r.location || "") !== filterLocation) return false;
      if (filterDivision !== "ALL" && (r.division || "") !== filterDivision) return false;
      if (filterDept !== "ALL" && r.deptName !== filterDept) return false;
      if (filterSection !== "ALL" && (r.section || r.groupName || "") !== filterSection) return false;
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
  }, [rows, filterLocation, filterDivision, filterDept, filterSection, filterGroup, search]);

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

  // Open single resignation modal
  const openSingleResignation = (row: AppRow) => {
    setResignationTargetRows([row]);
    setEffectiveDate(todayStr());
    setResignationReason("Nghỉ Tập nghề theo nguyện vọng cá nhân");
    setResignationNote("");
    setResignationModalOpen(true);
  };

  // Open bulk resignation modal
  const openBulkResignation = () => {
    const targets = filteredRows.filter((r) => selectedIds.has(r.id));
    if (targets.length === 0) return;
    setResignationTargetRows(targets);
    setEffectiveDate(todayStr());
    setResignationReason("Báo nghỉ Tập nghề hàng loạt");
    setResignationNote("");
    setResignationModalOpen(true);
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
            reason: resignationReason || "Nghỉ Tập nghề",
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
      "Ngày ĐK",
      "Họ và tên",
      "CCCD",
      "Giới tính",
      "SĐT",
      "Location",
      "Division",
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
          `"${r.cccd}"`,
          r.gender || "",
          r.phone || "",
          `"${(r.location || "").replace(/"/g, '""')}"`,
          `"${(r.division || "").replace(/"/g, '""')}"`,
          `"${(r.deptName || "").replace(/"/g, '""')}"`,
          `"${(r.section || r.groupName || "").replace(/"/g, '""')}"`,
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
  const newCount = filteredRows.filter((r) => r.dwMatch === "NEW").length;
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
              Hiển thị toàn bộ người tập nghề thuộc phạm vi phân quyền Data Scope của bạn.
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
          label="Tiếp nhận Tập nghề"
          value={filteredRows.length}
          tone="primary"
        />
        <KpiCard
          icon={<Target className="h-4 w-4" />}
          label="Nhu cầu nhân lực"
          value={totalQuota > 0 ? totalQuota : "—"}
          tone="warning"
        />
        <KpiCard
          icon={<UserPlus2 className="h-4 w-4" />}
          label="Người mới (DW Match)"
          value={newCount}
          tone="info"
        />
        <KpiCard
          icon={<Percent className="h-4 w-4" />}
          label="Tỷ lệ đáp ứng nhu cầu"
          value={totalQuota > 0 ? `${Math.round((filteredRows.length / totalQuota) * 100)}%` : "100%"}
          tone="success"
        />
      </div>

      {/* Hierarchy Filter Toolbar */}
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

            {/* Location filter */}
            {uniqueLocations.length > 0 && (
              <select
                value={filterLocation}
                onChange={(e) => setFilterLocation(e.target.value)}
                className="h-8 rounded-[6px] border border-border bg-surface px-2 text-xs font-medium text-fg outline-none focus:border-primary"
              >
                <option value="ALL">Location: Tất cả</option>
                {uniqueLocations.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            )}

            {/* Division filter */}
            {uniqueDivisions.length > 0 && (
              <select
                value={filterDivision}
                onChange={(e) => setFilterDivision(e.target.value)}
                className="h-8 rounded-[6px] border border-border bg-surface px-2 text-xs font-medium text-fg outline-none focus:border-primary"
              >
                <option value="ALL">Division: Tất cả</option>
                {uniqueDivisions.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            )}

            {/* Department filter */}
            <select
              value={filterDept}
              onChange={(e) => setFilterDept(e.target.value)}
              className="h-8 max-w-[200px] rounded-[6px] border border-border bg-surface px-2 text-xs font-medium text-fg outline-none focus:border-primary"
            >
              <option value="ALL">Department: Tất cả</option>
              {uniqueDeptNames.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>

            {/* Section / Group filter */}
            {uniqueGroups.length > 0 && (
              <select
                value={filterGroup}
                onChange={(e) => setFilterGroup(e.target.value)}
                className="h-8 rounded-[6px] border border-border bg-surface px-2 text-xs font-medium text-fg outline-none focus:border-primary"
              >
                <option value="ALL">Group: Tất cả</option>
                {uniqueGroups.map((g) => (
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
              description="Không có người tập nghề nào được xếp cho bộ phận trong khoảng thời gian đã chọn."
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
                    <th className="px-3 py-2.5 text-left text-[10.5px] uppercase">CCCD</th>
                    <th className="px-3 py-2.5 text-center text-[10.5px] uppercase">Giới tính</th>
                    <th className="px-3 py-2.5 text-left text-[10.5px] uppercase">Department</th>
                    <th className="px-3 py-2.5 text-left text-[10.5px] uppercase">Section</th>
                    <th className="px-3 py-2.5 text-left text-[10.5px] uppercase">Group</th>
                    <th className="px-3 py-2.5 text-left text-[10.5px] uppercase">Ngày bắt đầu</th>
                    <th className="px-3 py-2.5 text-center text-[10.5px] uppercase">Trạng thái</th>
                    <th className="px-3 py-2.5 text-right text-[10.5px] uppercase">Thao tác</th>
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
                        <td className="px-3 py-2.5 font-bold text-fg">
                          {r.fullName}
                          {r.phone ? (
                            <span className="block text-[11px] font-normal text-fg-muted font-mono">{r.phone}</span>
                          ) : null}
                        </td>
                        <td className="px-3 py-2.5 font-mono text-xs text-fg-secondary">
                          {maskCccd(r.cccd)}
                        </td>
                        <td className="px-3 py-2.5 text-center">
                          <Badge tone={r.gender === "Nữ" ? "purple" : "blue"}>
                            {r.gender ?? "—"}
                          </Badge>
                        </td>
                        <td className="px-3 py-2.5 text-fg font-semibold">{r.deptName || "—"}</td>
                        <td className="px-3 py-2.5 text-xs text-fg-secondary">{r.section || r.groupName || "—"}</td>
                        <td className="px-3 py-2.5 text-xs text-fg-secondary">{r.groupName || "—"}</td>
                        <td className="px-3 py-2.5 text-xs text-fg-secondary">
                          {formatDate(r.startingDate || r.regDate)}
                        </td>
                        <td className="px-3 py-2.5 text-center">
                          <Badge tone="green" dot>
                            Đã nhận việc
                          </Badge>
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                            <button
                              type="button"
                              onClick={() => openSingleResignation(r)}
                              title="Báo nghỉ Tập nghề"
                              className="rounded-full bg-danger-tint px-2.5 py-1 text-[11px] font-semibold text-danger hover:bg-danger/20 transition-colors"
                            >
                              Báo nghỉ
                            </button>
                            <Link
                              href={`/admin/worker-profiles?cccd=${r.cccd}`}
                              title="Xem hồ sơ Tập nghề"
                              className="rounded-full bg-surface-hover p-1 text-fg-secondary hover:bg-border transition-colors inline-flex items-center justify-center"
                            >
                              <IdCard className="h-3.5 w-3.5" />
                            </Link>
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

      {/* Floating Bulk Action Bar */}
      {selectedIds.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 rounded-[12px] bg-[#0B2E19] text-white px-5 py-3 shadow-xl ring-1 ring-white/10 animate-in slide-in-from-bottom-4 duration-200">
          <span className="text-xs font-semibold">
            Đã chọn <b className="text-accent text-sm">{selectedIds.size}</b> người tập nghề
          </span>
          <div className="h-4 w-px bg-white/20" />
          <Button
            variant="danger"
            size="sm"
            onClick={openBulkResignation}
            className="gap-1.5 text-xs font-semibold bg-danger hover:bg-danger-hover text-white"
          >
            <UserMinus className="h-3.5 w-3.5" /> Báo nghỉ việc ({selectedIds.size})
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

          {resignationTargetRows.length > 1 && (
            <div className="max-h-36 overflow-y-auto rounded-[8px] border border-border bg-surface-hover/50 p-2 text-xs space-y-1">
              {resignationTargetRows.map((r) => (
                <div key={r.id} className="flex justify-between items-center text-fg">
                  <span className="font-semibold">{r.fullName}</span>
                  <span className="text-fg-muted font-mono">{r.deptName} — {maskCccd(r.cccd)}</span>
                </div>
              ))}
            </div>
          )}

          <FormField label="Ngày có hiệu lực (Effective Date)" required>
            <Input
              type="date"
              value={effectiveDate}
              onChange={(e) => setEffectiveDate(e.target.value)}
            />
          </FormField>

          <FormField label="Lý do nghỉ việc" required>
            <Input
              placeholder="VD: Nghỉ theo nguyện vọng, hoàn thành kỳ tập nghề..."
              value={resignationReason}
              onChange={(e) => setResignationReason(e.target.value)}
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
    </div>
  );
}
