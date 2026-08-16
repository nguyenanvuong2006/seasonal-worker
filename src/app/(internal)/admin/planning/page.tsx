"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  ErrorState,
  FormField,
  GenderSplit,
  Input,
  Modal,
  PageHeader,
  PeriodBar,
  ProgressBar,
  SectionLabel,
  SkeletonTable,
  cn,
  toast,
} from "@/components/ui";
import {
  CalendarRange,
  Plus,
  Search,
  TrendingUp,
  UserCheck,
  UserMinus,
  UserPlus2,
  FilePlus2,
  Users,
} from "lucide-react";
import { formatDate } from "@/lib/helpers";
import { fetchJsonWithTimeout, type ApiResult } from "@/lib/api-client";

type PlanningMetrics = {
  demandMale: number;
  demandFemale: number;
  demandTotal: number;
  allocatedMale: number;
  allocatedFemale: number;
  allocatedTotal: number;
  resignedMale: number;
  resignedFemale: number;
  resignedTotal: number;
  recruitmentNeededMale: number;
  recruitmentNeededFemale: number;
  recruitmentNeededTotal: number;
  fillRatePercent: number;
};

type Period = {
  id: string;
  departmentId: string;
  deptName: string | null;
  deptVnName: string | null;
  location: string | null;
  division: string | null;
  section: string | null;
  groupName: string | null;
  periodSection: string | null;
  periodGroupName: string | null;
  startDate: string;
  endDate: string;
  status: "DRAFT" | "ACTIVE" | "EXPIRED";
  version: number;
  requestType: "ORIGINAL" | "SUPPLEMENT";
  supplementIndex: number;
  parentPeriodId: string | null;
  supersededBy: string | null;
  requestId: string | null;
  createdBy: string;
  createdAt: string;
  demandMale: number;
  demandFemale: number;
  targetCount: number;
  note: string | null;
  metrics: PlanningMetrics & { metricsSource?: "linked_request" | "legacy" };
};

type Dept = {
  id: string;
  deptName: string;
  groupName: string | null;
  vnName: string | null;
  location?: string | null;
  division?: string | null;
  section?: string | null;
};

type Unplanned = {
  id: string;
  workerName: string | null;
  workerCccd: string | null;
  gender: string | null;
  deptName: string | null;
  regDate: string;
};

const STATUS_TABS = [
  { key: "ACTIVE", label: "Đang áp dụng" },
  { key: "DRAFT", label: "Nháp" },
  { key: "EXPIRED", label: "Đã hết hạn" },
  { key: "ALL", label: "Tất cả" },
];

export default function PlanningPage() {
  const searchParams = useSearchParams();
  const highlightId = searchParams.get("highlight");
  const [rows, setRows] = useState<Period[]>([]);
  const [depts, setDepts] = useState<Dept[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState(() => searchParams.get("status") || "ACTIVE");
  const [requestTypeFilter, setRequestTypeFilter] = useState("ALL");
  const [searchQuery, setSearchQuery] = useState("");
  const [deptFilter, setDeptFilter] = useState("ALL");

  const [createOpen, setCreateOpen] = useState(false);
  const [createMode, setCreateMode] = useState<"ORIGINAL" | "SUPPLEMENT">("ORIGINAL");
  const [reviseTarget, setReviseTarget] = useState<Period | null>(null);
  const [allocateTarget, setAllocateTarget] = useState<Period | null>(null);
  const [unplanned, setUnplanned] = useState<Unplanned[]>([]);
  const [unplannedSel, setUnplannedSel] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState({
    departmentId: "",
    startDate: "",
    endDate: "",
    demandMale: 0,
    demandFemale: 0,
    requestType: "ORIGINAL" as "ORIGINAL" | "SUPPLEMENT",
    parentPeriodId: "",
    note: "",
    activateNow: true,
  });

  const [reviseForm, setReviseForm] = useState({
    startDate: "",
    endDate: "",
    demandMale: 0,
    demandFemale: 0,
    note: "",
  });

  const [loadError, setLoadError] = useState<{ code: string; message: string } | null>(null);

  const load = useCallback(
    async (status = statusFilter) => {
      setLoading(true);
      setLoadError(null);
      let pRes: ApiResult<{ rows?: Period[] }>;
      let dRes: ApiResult<{ rows?: Dept[] }>;
      try {
        [pRes, dRes] = await Promise.all([
          fetchJsonWithTimeout<{ rows?: Period[] }>(`/api/planning?status=${status}`, {
            timeoutMs: 12_000,
            label: "planning.list",
          }),
          fetchJsonWithTimeout<{ rows?: Dept[] }>(`/api/departments`, {
            timeoutMs: 12_000,
            label: "departments.list",
          }),
        ]);
      } catch (err) {
        // Defensive: helper should not throw, but network-level crash must not hang the UI.
        setLoadError({
          code: "NETWORK",
          message: "Không kết nối được tới máy chủ. Vui lòng thử lại.",
        });
        setLoading(false);
        return;
      }

      if (!pRes.ok) {
        setLoadError({ code: pRes.code, message: pRes.message });
        setRows([]);
        setLoading(false);
        return;
      }
      if (!dRes.ok) {
        // Departments failure: planning vẫn chạy được với dept list rỗng (filter sẽ rỗng).
        setDepts([]);
        toast({
          title: `Không tải được danh sách bộ phận: ${dRes.message}`,
          variant: "destructive",
        });
      } else {
        setDepts(dRes.data.rows ?? []);
      }
      setRows(pRes.data.rows ?? []);
      setLoading(false);
    },
    [statusFilter],
  );

  useEffect(() => {
    void load(statusFilter);
  }, [statusFilter, load]);

  const selectedDept = depts.find((d) => d.id === form.departmentId);

  // Kế hoạch gốc đang có của bộ phận đã chọn (để liên kết supplement)
  const originalPlansForSelectedDept = useMemo(() => {
    if (!form.departmentId) return [];
    return rows.filter(
      (r) => r.departmentId === form.departmentId && r.requestType === "ORIGINAL" && r.status === "ACTIVE",
    );
  }, [rows, form.departmentId]);

  const openCreateModal = (mode: "ORIGINAL" | "SUPPLEMENT" = "ORIGINAL") => {
    setCreateMode(mode);
    setForm({
      departmentId: "",
      startDate: "",
      endDate: "",
      demandMale: 0,
      demandFemale: 0,
      requestType: mode,
      parentPeriodId: "",
      note: "",
      activateNow: true,
    });
    setCreateOpen(true);
  };

  const submitCreate = async () => {
    if (!form.departmentId || !form.startDate || !form.endDate) {
      toast({ title: "Vui lòng chọn bộ phận và ngày bắt đầu/kết thúc", variant: "destructive" });
      return;
    }
    const male = Number(form.demandMale) || 0;
    const female = Number(form.demandFemale) || 0;
    if (male <= 0 && female <= 0) {
      toast({ title: "Vui lòng nhập nhu cầu cần tuyển (Nam hoặc Nữ > 0)", variant: "destructive" });
      return;
    }

    setSaving(true);
    try {
      const res = await fetch("/api/planning", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          departmentId: form.departmentId,
          section: selectedDept?.section ?? selectedDept?.groupName ?? null,
          groupName: selectedDept?.groupName ?? null,
          startDate: form.startDate,
          endDate: form.endDate,
          demandMale: male,
          demandFemale: female,
          targetCount: male + female,
          requestType: form.requestType,
          parentPeriodId: form.parentPeriodId || null,
          note: form.note,
          activateNow: form.activateNow,
        }),
      });
      const d = await res.json();
      if (!res.ok) {
        toast({ title: d.error ?? "Lỗi tạo kế hoạch", variant: "destructive" });
        return;
      }
      toast({
        title: form.requestType === "SUPPLEMENT" ? "Đã tạo yêu cầu bổ sung nhu cầu" : "Đã tạo kế hoạch nhu cầu gốc",
      });
      setCreateOpen(false);
      await load(statusFilter);
    } finally {
      setSaving(false);
    }
  };

  const activate = async (p: Period) => {
    const res = await fetch(`/api/planning/${p.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "activate" }),
    });
    const d = await res.json();
    if (!res.ok) {
      toast({ title: d.error ?? "Lỗi kích hoạt", variant: "destructive" });
      return;
    }
    toast({ title: "Đã kích hoạt kế hoạch nhu cầu" });
    await load(statusFilter);
  };

  const submitRevise = async () => {
    if (!reviseTarget) return;
    const male = Number(reviseForm.demandMale) || 0;
    const female = Number(reviseForm.demandFemale) || 0;
    if (male <= 0 && female <= 0) {
      toast({ title: "Vui lòng nhập nhu cầu (Nam hoặc Nữ > 0)", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/planning/${reviseTarget.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "revise",
          startDate: reviseForm.startDate,
          endDate: reviseForm.endDate,
          demandMale: male,
          demandFemale: female,
          targetCount: male + female,
          note: reviseForm.note,
        }),
      });
      const d = await res.json();
      if (!res.ok) {
        toast({ title: d.error ?? "Lỗi cập nhật kế hoạch", variant: "destructive" });
        return;
      }
      toast({ title: "Đã lưu phiên bản mới (v" + (reviseTarget.version + 1) + "), bản cũ chuyển sang lịch sử" });
      setReviseTarget(null);
      await load(statusFilter);
    } finally {
      setSaving(false);
    }
  };

  const openAllocate = async (p: Period) => {
    setAllocateTarget(p);
    setUnplannedSel({});
    const res = await fetch(`/api/planning/unplanned?departmentId=${p.departmentId}`);
    const d = await res.json();
    setUnplanned(d.rows ?? []);
  };

  const submitAllocate = async () => {
    if (!allocateTarget) return;
    const ids = Object.keys(unplannedSel).filter((k) => unplannedSel[k]);
    if (ids.length === 0) {
      setAllocateTarget(null);
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/planning/${allocateTarget.id}/allocate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employmentSessionIds: ids }),
      });
      const d = await res.json();
      if (!res.ok) {
        toast({ title: d.error ?? "Lỗi phân bổ", variant: "destructive" });
        return;
      }
      toast({ title: `Đã phân bổ ${ids.length} người tập nghề vào kế hoạch` });
      setAllocateTarget(null);
      await load(statusFilter);
    } finally {
      setSaving(false);
    }
  };

  // Filtered rows
  const filteredRows = useMemo(() => {
    return rows.filter((r) => {
      if (requestTypeFilter !== "ALL" && r.requestType !== requestTypeFilter) return false;
      if (deptFilter !== "ALL" && r.departmentId !== deptFilter) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const dept = (r.deptName ?? "").toLowerCase();
        const vn = (r.deptVnName ?? "").toLowerCase();
        const loc = (r.location ?? "").toLowerCase();
        const div = (r.division ?? "").toLowerCase();
        const sec = (r.section ?? r.periodSection ?? "").toLowerCase();
        const grp = (r.groupName ?? r.periodGroupName ?? "").toLowerCase();
        if (!dept.includes(q) && !vn.includes(q) && !loc.includes(q) && !div.includes(q) && !sec.includes(q) && !grp.includes(q)) {
          return false;
        }
      }
      return true;
    });
  }, [rows, requestTypeFilter, deptFilter, searchQuery]);

  // Overall KPI totals
  const totals = useMemo(() => {
    return filteredRows.reduce(
      (acc, r) => {
        acc.demandTotal += r.metrics.demandTotal;
        acc.demandMale += r.metrics.demandMale;
        acc.demandFemale += r.metrics.demandFemale;

        acc.allocatedTotal += r.metrics.allocatedTotal;
        acc.allocatedMale += r.metrics.allocatedMale;
        acc.allocatedFemale += r.metrics.allocatedFemale;

        acc.resignedTotal += r.metrics.resignedTotal;
        acc.resignedMale += r.metrics.resignedMale;
        acc.resignedFemale += r.metrics.resignedFemale;

        acc.recruitmentNeededTotal += r.metrics.recruitmentNeededTotal;
        acc.recruitmentNeededMale += r.metrics.recruitmentNeededMale;
        acc.recruitmentNeededFemale += r.metrics.recruitmentNeededFemale;
        return acc;
      },
      {
        demandTotal: 0,
        demandMale: 0,
        demandFemale: 0,
        allocatedTotal: 0,
        allocatedMale: 0,
        allocatedFemale: 0,
        resignedTotal: 0,
        resignedMale: 0,
        resignedFemale: 0,
        recruitmentNeededTotal: 0,
        recruitmentNeededMale: 0,
        recruitmentNeededFemale: 0,
      },
    );
  }, [filteredRows]);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={<SectionLabel>Workforce Demand Planning</SectionLabel>}
        title="Planning — Kế hoạch Nhu cầu Tập nghề"
        description="Quản lý nhu cầu tuyển dụng theo giai đoạn & phân tách Nam/Nữ. Hỗ trợ kế hoạch gốc và nhiều yêu cầu bổ sung trùng khoảng thời gian."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => openCreateModal("SUPPLEMENT")}>
              <FilePlus2 className="h-4 w-4" /> Yêu cầu bổ sung
            </Button>
            <Button variant="primary" onClick={() => openCreateModal("ORIGINAL")}>
              <Plus className="h-4 w-4" /> Kế hoạch gốc mới
            </Button>
          </div>
        }
      />

      {/* Demand Summary — hierarchy: shortage hero + fill rate + gender demand/allocation */}
      <Card className="overflow-hidden p-0">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <SectionLabel tone="green">Demand Summary</SectionLabel>
            <h2 className="mt-1 text-[16px] font-bold tracking-[-0.01em] text-fg">Tổng hợp theo bộ lọc hiện tại</h2>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="green" dot>
              Nhu cầu {totals.demandTotal}
            </Badge>
            <Badge tone="blue">Đã phân bổ {totals.allocatedTotal}</Badge>
            <Badge tone="amber">Nghỉ việc {totals.resignedTotal}</Badge>
          </div>
        </div>
        <div className="grid gap-5 p-5 lg:grid-cols-[230px_1fr_1fr]">
          {/* Shortage hero */}
          <div className="flex flex-col justify-between rounded-[16px] border border-accent/20 bg-accent-tint/60 p-5">
            <div>
              <p className="flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-[0.14em] text-accent">
                <TrendingUp className="h-3.5 w-3.5" aria-hidden /> Cần tuyển thêm
              </p>
              <p className="mt-2 text-[42px] font-bold leading-none tracking-tight tabular-nums text-accent">{totals.recruitmentNeededTotal}</p>
              <p className="mt-2 text-[12px] font-medium leading-relaxed text-fg-secondary">
                Nam {totals.recruitmentNeededMale} · Nữ {totals.recruitmentNeededFemale}
              </p>
            </div>
            <div className="mt-4">
              <div className="flex items-center justify-between text-[11px] font-semibold text-fg-secondary">
                <span>Tỷ lệ đáp ứng</span>
                <span className="tabular-nums text-fg">
                  {totals.demandTotal > 0 ? Math.round((totals.allocatedTotal / totals.demandTotal) * 100) : 100}%
                </span>
              </div>
              <ProgressBar
                value={totals.demandTotal > 0 ? (totals.allocatedTotal / totals.demandTotal) * 100 : 100}
                tone={totals.demandTotal > 0 && totals.allocatedTotal >= totals.demandTotal ? "success" : "accent"}
                className="mt-2 h-2"
              />
            </div>
          </div>

          {/* Gender demand vs allocation */}
          <div className="rounded-[16px] border border-border bg-surface-raised p-5">
            <p className="text-[10.5px] font-bold uppercase tracking-[0.14em] text-fg-muted">Nhu cầu theo giới tính</p>
            <div className="mt-4 space-y-4">
              <div>
                <div className="flex items-center justify-between text-[13px] font-semibold">
                  <span className="inline-flex items-center gap-1.5 text-fg">
                    <span className="h-2 w-2 rounded-full bg-primary" aria-hidden /> Nam
                  </span>
                  <span className="tabular-nums text-fg-secondary">
                    {totals.demandMale} cần · {totals.allocatedMale} đã bố trí
                  </span>
                </div>
                <ProgressBar
                  value={totals.demandMale > 0 ? (totals.allocatedMale / totals.demandMale) * 100 : 100}
                  tone="primary"
                  className="mt-1.5 h-2"
                />
              </div>
              <div>
                <div className="flex items-center justify-between text-[13px] font-semibold">
                  <span className="inline-flex items-center gap-1.5 text-fg">
                    <span className="h-2 w-2 rounded-full bg-accent" aria-hidden /> Nữ
                  </span>
                  <span className="tabular-nums text-fg-secondary">
                    {totals.demandFemale} cần · {totals.allocatedFemale} đã bố trí
                  </span>
                </div>
                <ProgressBar
                  value={totals.demandFemale > 0 ? (totals.allocatedFemale / totals.demandFemale) * 100 : 100}
                  tone="accent"
                  className="mt-1.5 h-2"
                />
              </div>
            </div>
            <div className="mt-4 border-t border-border pt-3">
              <GenderSplit male={totals.demandMale} female={totals.demandFemale} className="h-2" />
              <p className="mt-2 text-[11px] text-fg-muted">Cơ cấu nhu cầu — xanh: Nam · cam: Nữ</p>
            </div>
          </div>

          {/* Allocation snapshot */}
          <div className="rounded-[16px] border border-border bg-surface-raised p-5">
            <p className="text-[10.5px] font-bold uppercase tracking-[0.14em] text-fg-muted">Tình hình phân bổ & nghỉ việc</p>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <div className="rounded-[14px] bg-primary-tint p-4">
                <UserCheck className="h-4 w-4 text-primary" aria-hidden />
                <p className="mt-2 text-[26px] font-bold leading-none tabular-nums text-primary">{totals.allocatedTotal}</p>
                <p className="mt-1 text-[11px] font-semibold text-fg-secondary">Đã phân bổ</p>
                <p className="text-[10.5px] text-fg-muted">Nam {totals.allocatedMale} · Nữ {totals.allocatedFemale}</p>
              </div>
              <div className="rounded-[14px] bg-warning-tint p-4">
                <UserMinus className="h-4 w-4 text-warning" aria-hidden />
                <p className="mt-2 text-[26px] font-bold leading-none tabular-nums text-warning">{totals.resignedTotal}</p>
                <p className="mt-1 text-[11px] font-semibold text-fg-secondary">Nghỉ việc</p>
                <p className="text-[10.5px] text-fg-muted">Nam {totals.resignedMale} · Nữ {totals.resignedFemale}</p>
              </div>
            </div>
            <p className="mt-3 text-[11.5px] leading-relaxed text-fg-muted">
              Cần tuyển thêm = max(0, nhu cầu − đã phân bổ + nghỉ việc), tính riêng cho từng kế hoạch.
            </p>
          </div>
        </div>
      </Card>

      {/* Filter Toolbar */}
      <Card className="p-4 shadow-[0_1px_2px_rgba(23,32,18,0.04),0_8px_24px_rgba(23,32,18,0.05)]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {/* Status tabs */}
            <div className="flex gap-1 rounded-[10px] border border-border bg-surface-hover/80 p-1">
              {STATUS_TABS.map((t) => {
                const active = statusFilter === t.key;
                const activeCls =
                  t.key === "ACTIVE"
                    ? "bg-primary text-white shadow-sm"
                    : t.key === "DRAFT"
                      ? "bg-warning-tint text-warning"
                      : t.key === "EXPIRED"
                        ? "bg-surface-hover text-fg-secondary"
                        : "bg-surface text-primary shadow-sm";
                return (
                  <button
                    key={t.key}
                    onClick={() => setStatusFilter(t.key)}
                    aria-pressed={active}
                    className={cn(
                      "rounded-[8px] px-3 py-1.5 text-[12px] font-semibold transition-colors",
                      active ? activeCls : "text-fg-secondary hover:text-fg",
                    )}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>

            {/* Request Type filter */}
            <select
              value={requestTypeFilter}
              onChange={(e) => setRequestTypeFilter(e.target.value)}
              className="h-9 rounded-[8px] border border-border-strong bg-surface-raised px-2.5 text-xs font-medium text-fg outline-none focus:border-accent"
            >
              <option value="ALL">Mọi loại yêu cầu</option>
              <option value="ORIGINAL">Kế hoạch gốc</option>
              <option value="SUPPLEMENT">Yêu cầu bổ sung</option>
            </select>

            {/* Department filter */}
            <select
              value={deptFilter}
              onChange={(e) => setDeptFilter(e.target.value)}
              className="h-9 max-w-[220px] rounded-[8px] border border-border-strong bg-surface-raised px-2.5 text-xs font-medium text-fg outline-none focus:border-accent"
            >
              <option value="ALL">Tất cả bộ phận</option>
              {depts.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.deptName} {d.groupName ? `— ${d.groupName}` : ""}
                </option>
              ))}
            </select>
          </div>

          {/* Search box */}
          <div className="relative min-w-[200px] flex-1 max-w-xs">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-muted" />
            <input
              type="text"
              placeholder="Tìm theo cơ cấu / bộ phận..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-9 w-full rounded-[8px] border border-border-strong bg-surface-raised pl-8 pr-3 text-xs text-fg placeholder:text-fg-muted outline-none focus:border-accent"
            />
          </div>
        </div>
      </Card>

      {/* Main Table / List */}
      <Card className="overflow-hidden p-0">
        <CardContent className="p-0">
          {loading ? (
            <div className="p-6">
              <SkeletonTable rows={6} cols={5} />
              <p className="mt-4 text-center text-[12.5px] text-fg-muted">Đang tải kế hoạch nhu cầu...</p>
            </div>
          ) : loadError ? (
            <ErrorState
              title="Không tải được kế hoạch nhu cầu"
              description={
                <span>
                  {loadError.message}
                  {loadError.code ? (
                    <>
                      {" "}
                      <span className="text-fg-muted">Mã lỗi: {loadError.code}</span>
                    </>
                  ) : null}
                </span>
              }
              onRetry={() => void load(statusFilter)}
            />
          ) : filteredRows.length === 0 ? (
            <EmptyState
              icon={<CalendarRange className="h-5 w-5" aria-hidden />}
              title="Chưa có kế hoạch nhu cầu nào"
              description="Không có kế hoạch nhu cầu nào phù hợp với bộ lọc hiện tại. Tạo kế hoạch gốc hoặc yêu cầu bổ sung để bắt đầu lập kế hoạch nhân lực."
              action={
                <Button variant="primary" size="sm" onClick={() => openCreateModal("ORIGINAL")}>
                  <Plus className="h-4 w-4" /> Tạo kế hoạch gốc mới
                </Button>
              }
            />
          ) : (
            <div className="v2-scroll overflow-x-auto">
              <table className="grid-sheet w-full text-[13px]">
                <thead className="sticky top-0 z-10 bg-primary-tint/95 shadow-[inset_0_-1px_0_var(--color-border)] backdrop-blur">
                  <tr>
                    <th className="px-3 py-2.5 text-left text-[10.5px] font-bold uppercase tracking-wider text-primary">Cơ cấu tổ chức</th>
                    <th className="px-3 py-2.5 text-left text-[10.5px] font-bold uppercase tracking-wider text-primary">Thời gian & Loại</th>
                    <th className="px-3 py-2.5 text-center text-[10.5px] font-bold uppercase tracking-wider text-primary">Nhu cầu (Nam / Nữ / Tổng)</th>
                    <th className="px-3 py-2.5 text-center text-[10.5px] font-bold uppercase tracking-wider text-primary">Phân bổ</th>
                    <th className="px-3 py-2.5 text-center text-[10.5px] font-bold uppercase tracking-wider text-primary">Nghỉ việc</th>
                    <th className="px-3 py-2.5 text-center text-[10.5px] font-bold uppercase tracking-wider text-primary">Cần tuyển</th>
                    <th className="px-3 py-2.5 text-center text-[10.5px] font-bold uppercase tracking-wider text-primary">Đáp ứng</th>
                    <th className="px-3 py-2.5 text-center text-[10.5px] font-bold uppercase tracking-wider text-primary">Trạng thái</th>
                    <th className="px-3 py-2.5 text-right text-[10.5px] font-bold uppercase tracking-wider text-primary">Thao tác</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filteredRows.map((p) => {
                    const reqLabel = p.requestType === "SUPPLEMENT"
                      ? `Bổ sung ${p.supplementIndex || 1}`
                      : "Gốc";
                    const isSupplement = p.requestType === "SUPPLEMENT";

                    return (
                      <tr
                        key={p.id}
                        className={cn(
                          "border-b border-border/70 bg-surface transition-colors hover:bg-botanical-50",
                          p.id === highlightId && "bg-accent-tint/60 ring-1 ring-inset ring-accent/30 hover:bg-accent-tint/70",
                        )}
                      >
                        {/* Org Hierarchy */}
                        <td className="px-3 py-3">
                          <div className="font-semibold text-fg">
                            {p.deptName}
                            {p.groupName || p.periodGroupName ? ` — ${p.groupName || p.periodGroupName}` : ""}
                          </div>
                          <div className="text-[11px] text-fg-muted">
                            {p.location ? `${p.location} · ` : ""}{p.division ? `${p.division} · ` : ""}{p.deptVnName || ""}
                          </div>
                        </td>

                        {/* Date & Request Type */}
                        <td className="min-w-[210px] px-3 py-3">
                          <div className="font-medium text-fg">
                            {formatDate(p.startDate)} → {formatDate(p.endDate)}
                          </div>
                          {p.metrics?.metricsSource === "linked_request" && (
                            <a
                              href={`/admin/workforce-requests?open=${p.requestId ?? ""}`}
                              className="mt-1 inline-flex items-center gap-1 rounded-full bg-botanical-100 px-2 py-0.5 text-[10px] font-semibold text-botanical-800"
                              title="Số liệu của kế hoạch này được tính TỪ Workforce Request (source of truth)"
                            >
                              Theo Workforce Request
                            </a>
                          )}
                          <div className="mt-1 flex items-center gap-1.5">
                            <Badge tone={isSupplement ? "purple" : "blue"}>
                              {reqLabel}
                            </Badge>
                            <span className="text-[11px] text-fg-muted font-mono">v{p.version}</span>
                          </div>
                          <PeriodBar
                            startDate={p.startDate}
                            endDate={p.endDate}
                            tone={p.status === "ACTIVE" ? "primary" : p.status === "DRAFT" ? "warning" : "success"}
                            className="mt-2 max-w-[190px]"
                          />
                        </td>

                        {/* Demand: Male / Female / Total */}
                        <td className="px-3 py-3 text-center">
                          <div className="font-bold text-fg">
                            {p.metrics.demandTotal}
                          </div>
                          <div className="text-[11px] text-fg-muted">
                            <span className="font-semibold text-primary">{p.metrics.demandMale} Nam</span> · <span className="font-semibold text-accent">{p.metrics.demandFemale} Nữ</span>
                          </div>
                          <GenderSplit male={p.metrics.demandMale} female={p.metrics.demandFemale} className="mx-auto mt-1.5 h-1.5 max-w-[110px]" />
                        </td>

                        {/* Allocated: Male / Female / Total */}
                        <td className="px-3 py-3 text-center">
                          <div className="font-semibold text-success">
                            {p.metrics.allocatedTotal}
                          </div>
                          <div className="text-[11px] text-fg-muted">
                            {p.metrics.allocatedMale} Nam · {p.metrics.allocatedFemale} Nữ
                          </div>
                          <GenderSplit male={p.metrics.allocatedMale} female={p.metrics.allocatedFemale} className="mx-auto mt-1.5 h-1.5 max-w-[110px]" />
                        </td>

                        {/* Resigned: Male / Female / Total */}
                        <td className="px-3 py-3 text-center">
                          <div className="font-semibold text-warning">
                            {p.metrics.resignedTotal}
                          </div>
                          <div className="text-[11px] text-fg-muted">
                            {p.metrics.resignedMale} Nam · {p.metrics.resignedFemale} Nữ
                          </div>
                        </td>

                        {/* Recruitment Needed: Male / Female / Total */}
                        <td className="px-3 py-3 text-center">
                          <div className={cn("font-bold text-base", p.metrics.recruitmentNeededTotal > 0 ? "text-primary" : "text-fg-muted")}>
                            {p.metrics.recruitmentNeededTotal}
                          </div>
                          <div className="text-[11px] text-fg-muted">
                            <span className={p.metrics.recruitmentNeededMale > 0 ? "font-semibold text-primary" : ""}>{p.metrics.recruitmentNeededMale} Nam</span> · <span className={p.metrics.recruitmentNeededFemale > 0 ? "font-semibold text-accent" : ""}>{p.metrics.recruitmentNeededFemale} Nữ</span>
                          </div>
                        </td>

                        {/* Fill rate */}
                        <td className="px-3 py-3 text-center">
                          <span className={cn("inline-block rounded-full px-2 py-0.5 text-xs font-semibold", p.metrics.fillRatePercent >= 100 ? "bg-success-tint text-success" : "bg-primary-tint text-primary")}>
                            {p.metrics.fillRatePercent}%
                          </span>
                          <ProgressBar
                            value={p.metrics.fillRatePercent}
                            tone={p.metrics.fillRatePercent >= 100 ? "success" : "primary"}
                            className="mx-auto mt-1.5 h-1.5 max-w-[110px]"
                          />
                        </td>

                        {/* Status */}
                        <td className="px-3 py-3 text-center">
                          <Badge tone={p.status === "ACTIVE" ? "green" : p.status === "DRAFT" ? "amber" : "gray"} dot>
                            {p.status === "ACTIVE" ? "Áp dụng" : p.status === "DRAFT" ? "Nháp" : "Hết hạn"}
                          </Badge>
                        </td>

                        {/* Actions */}
                        <td className="px-3 py-3 text-right">
                          <div className="flex justify-end gap-1.5">
                            {p.status === "DRAFT" && (
                              <button
                                onClick={() => activate(p)}
                                className="rounded-full bg-success-tint px-2.5 py-1 text-[11px] font-semibold text-success hover:bg-success/20 transition-colors"
                              >
                                Kích hoạt
                              </button>
                            )}
                            {p.status === "ACTIVE" && (
                              <>
                                <button
                                  onClick={() => {
                                    setReviseTarget(p);
                                    setReviseForm({
                                      startDate: p.startDate,
                                      endDate: p.endDate,
                                      demandMale: p.metrics.demandMale,
                                      demandFemale: p.metrics.demandFemale,
                                      note: p.note ?? "",
                                    });
                                  }}
                                  className="rounded-full bg-primary-tint px-2.5 py-1 text-[11px] font-semibold text-primary hover:bg-primary/15 transition-colors"
                                >
                                  Sửa (v{p.version + 1})
                                </button>
                                <button
                                  onClick={() => openAllocate(p)}
                                  className="rounded-full bg-surface-hover px-2.5 py-1 text-[11px] font-semibold text-fg-secondary hover:bg-border transition-colors"
                                >
                                  Phân bổ
                                </button>
                              </>
                            )}
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

      {/* Modal: Create Plan (Original or Supplement) */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title={createMode === "SUPPLEMENT" ? "Tạo Yêu Cầu Bổ Sung Nhu Cầu" : "Tạo Kế Hoạch Nhu Cầu Gốc"}
      >
        <div className="space-y-4">
          <div className="flex gap-2 rounded-[8px] bg-surface-hover p-1">
            <button
              type="button"
              onClick={() => {
                setCreateMode("ORIGINAL");
                setForm((prev) => ({ ...prev, requestType: "ORIGINAL" }));
              }}
              className={cn(
                "flex-1 rounded-[6px] py-1.5 text-xs font-semibold transition-colors",
                createMode === "ORIGINAL" ? "bg-surface text-primary shadow-sm" : "text-fg-secondary",
              )}
            >
              Kế hoạch gốc (Original)
            </button>
            <button
              type="button"
              onClick={() => {
                setCreateMode("SUPPLEMENT");
                setForm((prev) => ({ ...prev, requestType: "SUPPLEMENT" }));
              }}
              className={cn(
                "flex-1 rounded-[6px] py-1.5 text-xs font-semibold transition-colors",
                createMode === "SUPPLEMENT" ? "bg-surface text-primary shadow-sm" : "text-fg-secondary",
              )}
            >
              Yêu cầu bổ sung (Supplement)
            </button>
          </div>

          <FormField label="Bộ phận (Department / Group)" required>
            <select
              value={form.departmentId}
              onChange={(e) => setForm({ ...form, departmentId: e.target.value })}
              className="h-10 w-full rounded-[10px] border border-border bg-surface px-3 text-sm font-medium text-fg outline-none focus:border-primary focus:ring-2 focus:ring-primary/15"
            >
              <option value="">— Chọn bộ phận tiếp nhận —</option>
              {depts.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.deptName} {d.groupName ? `— ${d.groupName}` : ""} {d.vnName ? `(${d.vnName})` : ""}
                </option>
              ))}
            </select>
          </FormField>

          {createMode === "SUPPLEMENT" && originalPlansForSelectedDept.length > 0 && (
            <FormField label="Liên kết kế hoạch gốc">
              <select
                value={form.parentPeriodId}
                onChange={(e) => setForm({ ...form, parentPeriodId: e.target.value })}
                className="h-10 w-full rounded-[10px] border border-border bg-surface px-3 text-sm font-medium text-fg outline-none focus:border-primary"
              >
                <option value="">— Tự động liên kết kế hoạch gốc gần nhất —</option>
                {originalPlansForSelectedDept.map((op) => (
                  <option key={op.id} value={op.id}>
                    Gốc: {formatDate(op.startDate)} → {formatDate(op.endDate)} (Nhu cầu: {op.metrics.demandTotal})
                  </option>
                ))}
              </select>
            </FormField>
          )}

          <div className="grid grid-cols-2 gap-3">
            <FormField label="Từ ngày" required>
              <Input
                type="date"
                value={form.startDate}
                onChange={(e) => setForm({ ...form, startDate: e.target.value })}
              />
            </FormField>
            <FormField label="Đến ngày" required>
              <Input
                type="date"
                value={form.endDate}
                onChange={(e) => setForm({ ...form, endDate: e.target.value })}
              />
            </FormField>
          </div>

          <div className="rounded-[10px] border border-border bg-surface-hover/50 p-3">
            <p className="mb-2 text-xs font-semibold text-fg">Nhu cầu tuyển dụng theo giới tính</p>
            <div className="grid grid-cols-2 gap-3">
              <FormField label="Nhu cầu cần (Nam)">
                <Input
                  type="number"
                  min={0}
                  value={form.demandMale}
                  onChange={(e) => setForm({ ...form, demandMale: Math.max(0, Number(e.target.value)) })}
                />
              </FormField>
              <FormField label="Nhu cầu cần (Nữ)">
                <Input
                  type="number"
                  min={0}
                  value={form.demandFemale}
                  onChange={(e) => setForm({ ...form, demandFemale: Math.max(0, Number(e.target.value)) })}
                />
              </FormField>
            </div>
            <div className="mt-2 text-right text-xs font-semibold text-fg-secondary">
              Tổng nhu cầu: <b className="text-primary font-bold">{Number(form.demandMale || 0) + Number(form.demandFemale || 0)}</b> người
            </div>
          </div>

          <FormField label="Ghi chú nghiệp vụ">
            <Input
              placeholder="Lý do bổ sung hoặc ghi chú công việc..."
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
            />
          </FormField>

          <label className="flex items-center gap-2 text-sm font-medium text-fg cursor-pointer">
            <input
              type="checkbox"
              checked={form.activateNow}
              onChange={(e) => setForm({ ...form, activateNow: e.target.checked })}
              className="h-4 w-4 rounded accent-primary"
            />
            Kích hoạt ngay (bỏ tick = lưu ở trạng thái Nháp)
          </label>

          <Button variant="primary" size="lg" className="w-full" loading={saving} onClick={submitCreate}>
            Lưu kế hoạch
          </Button>
        </div>
      </Modal>

      {/* Modal: Revise Plan (New Version) */}
      <Modal
        open={!!reviseTarget}
        onClose={() => setReviseTarget(null)}
        title={`Sửa Kế Hoạch — Tạo Phiên Bản Mới (v${(reviseTarget?.version ?? 1) + 1})`}
      >
        <div className="space-y-4">
          <p className="text-xs text-fg-muted">
            Phiên bản hiện tại (v{reviseTarget?.version}) sẽ chuyển sang trạng thái <b>Đã hết hạn</b> và được lưu trong lịch sử. Các hồ sơ đã phân bổ sẽ tự động chuyển sang phiên bản mới.
          </p>

          <div className="grid grid-cols-2 gap-3">
            <FormField label="Từ ngày">
              <Input
                type="date"
                value={reviseForm.startDate}
                onChange={(e) => setReviseForm({ ...reviseForm, startDate: e.target.value })}
              />
            </FormField>
            <FormField label="Đến ngày">
              <Input
                type="date"
                value={reviseForm.endDate}
                onChange={(e) => setReviseForm({ ...reviseForm, endDate: e.target.value })}
              />
            </FormField>
          </div>

          <div className="rounded-[10px] border border-border bg-surface-hover/50 p-3">
            <p className="mb-2 text-xs font-semibold text-fg">Cập nhật nhu cầu tuyển dụng</p>
            <div className="grid grid-cols-2 gap-3">
              <FormField label="Nhu cầu cần (Nam)">
                <Input
                  type="number"
                  min={0}
                  value={reviseForm.demandMale}
                  onChange={(e) => setReviseForm({ ...reviseForm, demandMale: Math.max(0, Number(e.target.value)) })}
                />
              </FormField>
              <FormField label="Nhu cầu cần (Nữ)">
                <Input
                  type="number"
                  min={0}
                  value={reviseForm.demandFemale}
                  onChange={(e) => setReviseForm({ ...reviseForm, demandFemale: Math.max(0, Number(e.target.value)) })}
                />
              </FormField>
            </div>
            <div className="mt-2 text-right text-xs font-semibold text-fg-secondary">
              Tổng nhu cầu mới: <b className="text-primary font-bold">{Number(reviseForm.demandMale || 0) + Number(reviseForm.demandFemale || 0)}</b> người
            </div>
          </div>

          <FormField label="Ghi chú điều chỉnh">
            <Input
              value={reviseForm.note}
              onChange={(e) => setReviseForm({ ...reviseForm, note: e.target.value })}
            />
          </FormField>

          <Button variant="primary" className="w-full" loading={saving} onClick={submitRevise}>
            Lưu phiên bản mới
          </Button>
        </div>
      </Modal>

      {/* Modal: Allocate Unplanned Interns */}
      <Modal open={!!allocateTarget} onClose={() => setAllocateTarget(null)} title="Phân Bổ Người Tập Nghề Vào Kế Hoạch">
        <div className="space-y-4">
          <p className="text-xs text-fg-muted">
            Danh sách người tập nghề đang làm việc tại <b>{allocateTarget?.deptName}</b> nhưng chưa thuộc kế hoạch ACTIVE nào.
          </p>

          {unplanned.length === 0 ? (
            <EmptyState
              icon={<Users className="h-5 w-5" aria-hidden />}
              title="Không có người tập nghề Unplanned"
              description="Tất cả người tập nghề ở bộ phận này đã được phân bổ vào các kế hoạch."
            />
          ) : (
            <div className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
              {unplanned.map((u) => (
                <label
                  key={u.id}
                  className="flex items-center gap-2.5 rounded-[8px] border border-border bg-surface p-2 text-xs transition-colors hover:bg-surface-hover cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={!!unplannedSel[u.id]}
                    onChange={(e) => setUnplannedSel({ ...unplannedSel, [u.id]: e.target.checked })}
                    className="h-4 w-4 rounded accent-primary"
                  />
                  <div className="flex-1">
                    <span className="font-semibold text-fg">{u.workerName}</span>
                    <span className="ml-2 font-mono text-fg-muted">({u.workerCccd})</span>
                  </div>
                  <Badge tone={u.gender === "Nữ" ? "purple" : "blue"}>
                    {u.gender || "—"}
                  </Badge>
                </label>
              ))}
            </div>
          )}

          <Button variant="primary" className="w-full" loading={saving} onClick={submitAllocate}>
            {unplanned.length === 0 ? "Đóng" : `Phân bổ ${Object.values(unplannedSel).filter(Boolean).length} người đã chọn`}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
