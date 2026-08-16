"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertPanel,
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  FormField,
  Input,
  KpiCard,
  Modal,
  PageHeader,
  ProgressBar,
  SectionLabel,
  StatusBadge,
  GenderSplit,
  GenderLegend,
  SkeletonTable,
  cn,
  toast,
} from "@/components/ui";
import {
  UsersRound,
  UserPlus,
  UserX,
  TrendingUp,
  Target,
  AlertTriangle,
  ShieldAlert,
  Eye,
  Link2,
  MessageSquare,
  Search,
  Loader2,
  RefreshCw,
  ArrowRightLeft,
  CheckCircle2,
} from "lucide-react";

/* ============================================================
   WORKFORCE REQUEST — Recruiter view (mục 12) + Dept Manager
   READ (mục 11) + Planning Dashboard (mục 13).
   Mọi KPI đều do server tính từ source of truth
   (Employment Session + request_allocations + Workforce Movement
   + Daily Application pipeline) — page này KHÔNG tự tính.
   ============================================================ */

type WarningDetail = { code: string; severity: "OK" | "SOFT" | "BLOCKING"; message: string };

type RequestKpi = {
  maleRequest: number;
  femaleRequest: number;
  totalRequest: number;
  maleCurrent: number;
  femaleCurrent: number;
  totalCurrent: number;
  maleRecruited: number;
  femaleRecruited: number;
  totalRecruited: number;
  maleQuit: number;
  femaleQuit: number;
  totalQuit: number;
  maleBalance: number;
  femaleBalance: number;
  totalBalance: number;
  fillRatePercent: number;
  warnings: WarningDetail[];
};

type RequestRow = {
  id: string;
  requestCode: string;
  requester: string;
  department: string | null;
  departmentId: string | null;
  section: string | null;
  groupName: string | null;
  division: string | null;
  position: string | null;
  expectedDate: string | null;
  requestedDate: string | null;
  status: string;
  reason: string | null;
  deptName: string | null;
  kpi: RequestKpi;
  applications: { male: number; female: number; total: number };
  linkedPeriod: { id: string; status: string; startDate: string; endDate: string } | null;
};

type Can = { allocate: boolean; overallocate: boolean; comment: boolean; linkPlanning?: boolean };

type DashboardData = {
  summary: {
    totalRequested: { male: number; female: number; total: number };
    currentWorkforce: { male: number; female: number; total: number };
    totalRecruited: { male: number; female: number; total: number };
    totalQuit: { male: number; female: number; total: number };
    needToRecruit: { male: number; female: number; total: number };
  };
  source: "LIVE" | "CACHE";
  computedAt: string;
  asOfDate: string;
  can: Can;
};

type DetailRequest = {
  id: string;
  requestCode: string;
  requester: string;
  department: string | null;
  departmentId: string | null;
  section: string | null;
  groupName: string | null;
  division: string | null;
  position: string | null;
  expectedDate: string | null;
  requestedDate: string | null;
  status: string;
  reason: string | null;
  deptName: string | null;
};

type DetailData = {
  request: DetailRequest;
  kpi: RequestKpi;
  pipeline: { status: string; male: number; female: number; total: number }[];
  currentWorkers: {
    allocationId: string;
    workerId: string;
    workerName: string | null;
    gender: string | null;
    deptName: string | null;
    allocatedAt: string;
    allocatedBy: string;
  }[];
  resignedWorkers: {
    movementId: string;
    workerId: string;
    workerName: string | null;
    gender: string | null;
    effectiveDate: string;
    reason: string | null;
  }[];
  history: {
    id: string;
    action: string;
    workerName: string | null;
    fromRequestId: string | null;
    toRequestId: string | null;
    reason: string | null;
    overrideConfirmed: boolean;
    changedBy: string;
    changedAt: string;
  }[];
  overrides: { id: string; changedBy: string; reason: string; currentTotal: number; totalRequest: number; createdAt: string }[];
  comments: { id: string; username: string; body: string; createdAt: string }[];
  linkedPeriod: { id: string; status: string; startDate: string; endDate: string } | null;
  can: Can;
};

type Candidate = {
  sessionId: string;
  workerId: string;
  workerName: string | null;
  cccd: string;
  gender: string | null;
  deptName: string | null;
  regDate: string;
  currentRequestId: string | null;
  currentRequestCode: string | null;
};

const ACTION_LABEL: Record<string, string> = {
  ALLOCATE: "Phân bổ mới",
  REALLOCATE: "Tái phân bổ",
  END: "Kết thúc allocation",
  OVERRIDE: "Phân bổ vượt tổng (override)",
};

const WARNING_TONE: Record<WarningDetail["severity"], "danger" | "warning" | "success"> = {
  BLOCKING: "danger",
  SOFT: "warning",
  OK: "success",
};

const WARNING_LABEL: Record<string, string> = {
  MALE_SHORTAGE: "Thiếu Nam",
  FEMALE_SHORTAGE: "Thiếu Nữ",
  MALE_OVER_TARGET: "Nam vượt cơ cấu",
  FEMALE_OVER_TARGET: "Nữ vượt cơ cấu",
  TOTAL_OVER_TARGET: "Vượt tổng nhu cầu",
  FULFILLED: "Đã đáp ứng",
};

function fmtDate(v?: string | null): string {
  if (!v) return "—";
  const [y, m, d] = v.slice(0, 10).split("-");
  if (!y || !m || !d) return v;
  return `${d}/${m}/${y}`;
}

function fmtDateTime(v?: string | null): string {
  if (!v) return "—";
  const d = new Date(v);
  return `${d.toLocaleDateString("vi-VN")} ${d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })}`;
}

function genderTone(g?: string | null): "primary" | "accent" | "muted" {
  const gNorm = (g ?? "").trim().toLowerCase();
  if (["nữ", "nu", "female", "f"].includes(gNorm) || gNorm.includes("nữ") || gNorm.includes("nu")) return "accent";
  if (["nam", "male", "m"].includes(gNorm) || gNorm.includes("nam")) return "primary";
  return "muted";
}

export default function WorkforceRequestsPage() {
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [can, setCan] = useState<Can>({ allocate: false, overallocate: false, comment: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState("ALL");
  const [search, setSearch] = useState("");
  const [asOfMode, setAsOfMode] = useState<"today" | "expected" | "date">("today");
  const [asOfDate, setAsOfDate] = useState("");

  const [detail, setDetail] = useState<DetailData | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [allocateFor, setAllocateFor] = useState<RequestRow | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [candidateSearch, setCandidateSearch] = useState("");
  const [selectedSessions, setSelectedSessions] = useState<Record<string, boolean>>({});
  const [reason, setReason] = useState("");
  const [overrideOn, setOverrideOn] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  const [saving, setSaving] = useState(false);

  const [commentText, setCommentText] = useState("");
  const [postingComment, setPostingComment] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const asOf = asOfMode === "date" && asOfDate ? asOfDate : asOfMode === "expected" ? "expected" : "today";
      const [listRes, dashRes] = await Promise.all([
        fetch(`/api/workforce-requests?status=${statusFilter}&search=${encodeURIComponent(search)}&asOf=${asOf}`),
        fetch(`/api/workforce-requests/dashboard${asOfMode === "date" && asOfDate ? `?asOf=${asOfDate}` : ""}`),
      ]);
      if (listRes.status === 403 || dashRes.status === 403) {
        setError("Tài khoản của bạn không có quyền xem Workforce Request.");
        return;
      }
      const listJson = (await listRes.json()) as { rows: RequestRow[]; can: Can };
      const dashJson = (await dashRes.json()) as DashboardData;
      setRows(listJson.rows ?? []);
      setCan(listJson.can ?? { allocate: false, overallocate: false, comment: false });
      setDashboard(dashJson);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, search, asOfMode, asOfDate]);

  const openDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    setDetail(null);
    try {
      const res = await fetch(`/api/workforce-requests/${id}`);
      if (!res.ok) {
        toast({ title: "Không thể tải chi tiết request.", variant: "destructive" });
        return;
      }
      setDetail((await res.json()) as DetailData);
    } catch {
      toast({ title: "Lỗi khi tải chi tiết.", variant: "destructive" });
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // Hỗ trợ link từ Planning: ?open=<requestId>
    const openParam = new URLSearchParams(window.location.search).get("open");
    if (openParam) void openDetail(openParam);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, openDetail]);

  const openAllocate = useCallback(
    async (row: RequestRow) => {
      setAllocateFor(row);
      setSelectedSessions({});
      setReason("");
      setOverrideOn(false);
      setOverrideReason("");
      try {
        const res = await fetch("/api/workforce-requests/unplanned");
        const json = (await res.json()) as { rows: Candidate[] };
        setCandidates(json.rows ?? []);
      } catch {
        setCandidates([]);
      }
    },
    [],
  );

  const submitAllocate = useCallback(async () => {
    if (!allocateFor) return;
    const ids = candidates.filter((c) => selectedSessions[c.sessionId]).map((c) => c.sessionId);
    if (ids.length === 0) {
      toast({ title: "Chưa chọn lao động nào.", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/workforce-requests/${allocateFor.id}/allocate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          employmentSessionIds: ids,
          reason: reason.trim() || null,
          override: overrideOn ? { confirmed: true, reason: overrideReason } : null,
        }),
      });
      const json = (await res.json()) as { error?: string; results?: { outcome: string; workerName: string }[]; warnings?: WarningDetail[]; overridden?: boolean };
      if (!res.ok) {
        toast({ title: json.error ?? "Không thể phân bổ.", variant: "destructive" });
        return;
      }
      const warningTitles = (json.warnings ?? []).filter((w) => w.severity !== "OK").map((w) => WARNING_LABEL[w.code] ?? w.code);
      toast({
        title: `Đã phân bổ ${ids.length} lao động${json.overridden ? " (override vượt tổng)" : ""}${warningTitles.length ? ` — ${warningTitles.join(", ")}` : ""}`,
      });
      setAllocateFor(null);
      void load();
      if (detail) void openDetail(detail.request.id);
    } catch (e) {
      toast({ title: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }, [allocateFor, candidates, selectedSessions, reason, overrideOn, overrideReason, load, detail, openDetail]);

  const postComment = useCallback(async () => {
    if (!detail) return;
    const text = commentText.trim();
    if (!text) return;
    setPostingComment(true);
    try {
      const res = await fetch(`/api/workforce-requests/${detail.request.id}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: text }),
      });
      if (!res.ok) {
        const json = (await res.json()) as { error?: string };
        toast({ title: json.error ?? "Không thể gửi bình luận.", variant: "destructive" });
        return;
      }
      setCommentText("");
      void openDetail(detail.request.id);
    } finally {
      setPostingComment(false);
    }
  }, [detail, commentText, openDetail]);

  const filteredCandidates = useMemo(() => {
    const q = candidateSearch.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter(
      (c) => (c.workerName ?? "").toLowerCase().includes(q) || c.cccd.includes(q) || (c.currentRequestCode ?? "").toLowerCase().includes(q),
    );
  }, [candidates, candidateSearch]);

  const readOnly = !can.allocate;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Workforce Request"
        description="Yêu cầu nhân lực — Nhu cầu, Hiện có, Đã tuyển, Nghỉ việc, Cần tuyển tiếp (Nam/Nữ) tính từ cùng một nguồn dữ liệu."
      />

      {/* PLANNING DASHBOARD (mục 13) */}
      {dashboard && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <KpiCard
            icon={<Target className="h-4 w-4" />}
            label="Tổng nhu cầu (Requested)"
            value={dashboard.summary.totalRequested.total}
            context={<GenderLegend male={dashboard.summary.totalRequested.male} female={dashboard.summary.totalRequested.female} />}
            tone="primary"
          />
          <KpiCard
            icon={<UsersRound className="h-4 w-4" />}
            label="Hiện có (Current Workforce)"
            value={dashboard.summary.currentWorkforce.total}
            context={<GenderLegend male={dashboard.summary.currentWorkforce.male} female={dashboard.summary.currentWorkforce.female} />}
            tone="success"
          />
          <KpiCard
            icon={<UserPlus className="h-4 w-4" />}
            label="Đã tuyển (Recruited)"
            value={dashboard.summary.totalRecruited.total}
            context={<GenderLegend male={dashboard.summary.totalRecruited.male} female={dashboard.summary.totalRecruited.female} />}
            tone="info"
          />
          <KpiCard
            icon={<UserX className="h-4 w-4" />}
            label="Nghỉ việc (Quit)"
            value={dashboard.summary.totalQuit.total}
            context={<GenderLegend male={dashboard.summary.totalQuit.male} female={dashboard.summary.totalQuit.female} />}
            tone="danger"
          />
          <KpiCard
            icon={<TrendingUp className="h-4 w-4" />}
            label="Cần tuyển tiếp"
            value={dashboard.summary.needToRecruit.total}
            context={
              <span className="text-[11.5px]">
                Nam {dashboard.summary.needToRecruit.male} · Nữ {dashboard.summary.needToRecruit.female}
              </span>
            }
            tone="warning"
          />
        </div>
      )}

      <Card>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <FormField label="Trạng thái" className="min-w-[140px]">
              <select
                className="h-9 w-full rounded-lg border border-border bg-surface px-2.5 text-[13px] text-fg"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
              >
                {["ALL", "PENDING", "PROCESSING", "COMPLETED", "CANCELLED"].map((s) => (
                  <option key={s} value={s}>
                    {s === "ALL" ? "Tất cả" : s}
                  </option>
                ))}
              </select>
            </FormField>
            <FormField label="Tìm kiếm" className="min-w-[220px]">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-muted" />
                <Input
                  className="h-9 pl-8"
                  placeholder="Mã yêu cầu, người yêu cầu, bộ phận..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
            </FormField>
            <FormField label="Mốc tính KPI (as of)" className="min-w-[220px]">
              <div className="flex items-center gap-2">
                <select
                  className="h-9 rounded-lg border border-border bg-surface px-2.5 text-[13px] text-fg"
                  value={asOfMode}
                  onChange={(e) => setAsOfMode(e.target.value as "today" | "expected" | "date")}
                >
                  <option value="today">Hôm nay</option>
                  <option value="expected">Expected Date từng request</option>
                  <option value="date">Ngày lịch sử (snapshot)</option>
                </select>
                {asOfMode === "date" && <Input type="date" className="h-9 w-[150px]" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} />}
              </div>
            </FormField>
            <Button variant="outline" onClick={() => void load()} className="h-9">
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Làm mới
            </Button>
          </div>

          {dashboard && (
            <div className="text-[11px] text-fg-muted">
              Dữ liệu dashboard tính tới <b>{fmtDate(dashboard.asOfDate)}</b> · nguồn:{" "}
              {dashboard.source === "CACHE" ? `cache (tính lúc ${fmtDateTime(dashboard.computedAt)})` : "tính trực tiếp từ dữ liệu gốc"}
              {readOnly && (
                <Badge tone="blue" className="ml-2">
                  Chế độ xem — Dept Manager không chỉnh sửa Request/Recruit/Allocation/Balance
                </Badge>
              )}
            </div>
          )}

          {error && (
            <AlertPanel tone="danger" icon={<ShieldAlert className="h-4 w-4" />} title="Không thể tải dữ liệu">
              <p>{error}</p>
            </AlertPanel>
          )}

          {loading ? (
            <SkeletonTable rows={6} cols={8} />
          ) : rows.length === 0 ? (
            <EmptyState title="Chưa có Workforce Request" description="Import yêu cầu tại trang “Yêu cầu tuyển dụng” hoặc tạo Planning liên kết." />
          ) : (
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full min-w-[1280px] border-collapse text-[12px]">
                <thead>
                  <tr className="bg-surface-hover text-[10px] uppercase tracking-wider text-fg-muted">
                    <th className="px-3 py-2 text-left">Mã YC / Bộ phận</th>
                    <th className="px-2 py-2 text-center" colSpan={3}>Nhu cầu</th>
                    <th className="px-2 py-2 text-center" colSpan={3}>Hiện có</th>
                    <th className="px-2 py-2 text-center" colSpan={3}>Đã tuyển</th>
                    <th className="px-2 py-2 text-center" colSpan={3}>Nghỉ việc</th>
                    <th className="px-2 py-2 text-center" colSpan={3}>Cần tuyển tiếp</th>
                    <th className="px-3 py-2 text-center">Đáp ứng</th>
                    <th className="px-3 py-2 text-center">Expected</th>
                    <th className="px-3 py-2 text-center">Trạng thái</th>
                    <th className="px-3 py-2 text-left">Cảnh báo</th>
                    <th className="px-3 py-2 text-right">Thao tác</th>
                  </tr>
                  <tr className="bg-surface-hover/60 text-[9.5px] text-fg-muted">
                    <th className="px-3 py-1 text-left">—</th>
                    {(["N", "M", "T"] as const).map((h) => <th key={`rq-${h}`} className="px-1 py-1 text-center">{h}</th>)}
                    {(["N", "M", "T"] as const).map((h) => <th key={`cur-${h}`} className="px-1 py-1 text-center">{h}</th>)}
                    {(["N", "M", "T"] as const).map((h) => <th key={`rc-${h}`} className="px-1 py-1 text-center">{h}</th>)}
                    {(["N", "M", "T"] as const).map((h) => <th key={`q-${h}`} className="px-1 py-1 text-center">{h}</th>)}
                    {(["N", "M", "T"] as const).map((h) => <th key={`b-${h}`} className="px-1 py-1 text-center">{h}</th>)}
                    <th className="px-3 py-1" colSpan={5}>—</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((r) => (
                    <tr key={r.id} className="bg-surface align-top transition-colors hover:bg-botanical-50">
                      <td className="px-3 py-2.5">
                        <div className="font-semibold text-fg">{r.requestCode}</div>
                        <div className="text-[11px] text-fg-muted">
                          {r.deptName || r.department || "—"}
                          {r.section ? ` · ${r.section}` : ""}
                          {r.groupName ? ` · ${r.groupName}` : ""}
                        </div>
                        {r.linkedPeriod && (
                          <div className="mt-1 inline-flex items-center gap-1 rounded-full bg-botanical-100 px-2 py-0.5 text-[9.5px] font-semibold text-botanical-800">
                            <Link2 className="h-2.5 w-2.5" /> Planning {fmtDate(r.linkedPeriod.startDate)} → {fmtDate(r.linkedPeriod.endDate)}
                          </div>
                        )}
                      </td>
                      <td className="px-1 py-2.5 text-center font-semibold text-primary">{r.kpi.maleRequest}</td>
                      <td className="px-1 py-2.5 text-center font-semibold text-accent">{r.kpi.femaleRequest}</td>
                      <td className="px-1 py-2.5 text-center font-bold">{r.kpi.totalRequest}</td>
                      <td className="px-1 py-2.5 text-center text-primary">{r.kpi.maleCurrent}</td>
                      <td className="px-1 py-2.5 text-center text-accent">{r.kpi.femaleCurrent}</td>
                      <td className="px-1 py-2.5 text-center font-semibold">{r.kpi.totalCurrent}</td>
                      <td className="px-1 py-2.5 text-center text-primary">{r.kpi.maleRecruited}</td>
                      <td className="px-1 py-2.5 text-center text-accent">{r.kpi.femaleRecruited}</td>
                      <td className="px-1 py-2.5 text-center">{r.kpi.totalRecruited}</td>
                      <td className="px-1 py-2.5 text-center text-danger">{r.kpi.maleQuit}</td>
                      <td className="px-1 py-2.5 text-center text-danger">{r.kpi.femaleQuit}</td>
                      <td className="px-1 py-2.5 text-center">{r.kpi.totalQuit}</td>
                      <td className="px-1 py-2.5 text-center font-bold text-warning">{r.kpi.maleBalance}</td>
                      <td className="px-1 py-2.5 text-center font-bold text-warning">{r.kpi.femaleBalance}</td>
                      <td className="px-1 py-2.5 text-center font-bold text-warning">{r.kpi.totalBalance}</td>
                      <td className="px-3 py-2.5">
                        <div className="mx-auto w-[90px]">
                          <ProgressBar value={r.kpi.fillRatePercent} tone={r.kpi.fillRatePercent >= 100 ? "success" : "primary"} />
                          <div className="mt-1 text-center text-[10px] font-semibold text-fg-muted">{r.kpi.fillRatePercent}%</div>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-center text-[11px]">{fmtDate(r.expectedDate)}</td>
                      <td className="px-3 py-2.5 text-center">
                        <StatusBadge status={r.status} />
                      </td>
                      <td className="max-w-[220px] px-3 py-2.5">
                        <div className="flex flex-wrap gap-1">
                          {r.kpi.warnings.map((w) => (
                            <span
                              key={w.code}
                              title={w.message}
                              className={cn(
                                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[9.5px] font-semibold",
                                w.severity === "BLOCKING" && "bg-danger-tint text-danger",
                                w.severity === "SOFT" && "bg-warning-tint text-warning",
                                w.severity === "OK" && "bg-success-tint text-success",
                              )}
                            >
                              {w.severity === "BLOCKING" && <AlertTriangle className="h-2.5 w-2.5" />}
                              {WARNING_LABEL[w.code] ?? w.code}
                            </span>
                          ))}
                          {r.kpi.warnings.length === 0 && <span className="text-[10px] text-fg-muted">—</span>}
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex justify-end gap-1.5">
                          <Button variant="outline" size="sm" onClick={() => void openDetail(r.id)}>
                            <Eye className="mr-1 h-3 w-3" /> Chi tiết
                          </Button>
                          {!readOnly && (
                            <Button size="sm" onClick={() => void openAllocate(r)}>
                              <ArrowRightLeft className="mr-1 h-3 w-3" /> Phân bổ
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* DETAIL MODAL */}
      <Modal open={detailLoading || !!detail} onClose={() => setDetail(null)} title={detail ? `Chi tiết Workforce Request ${detail.request.requestCode}` : "Đang tải..."} width="max-w-5xl">
        {detail && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2 text-[12px] text-fg-muted">
              <span>
                Bộ phận: <b className="text-fg">{detail.request.deptName || detail.request.department || "—"}</b>
              </span>
              <span>·</span>
              <span>
                Section/Group: <b className="text-fg">{detail.request.section || "—"} / {detail.request.groupName || "—"}</b>
              </span>
              <span>·</span>
              <span>
                Expected: <b className="text-fg">{fmtDate(detail.request.expectedDate)}</b>
              </span>
              <StatusBadge status={detail.request.status} />
              {detail.request.reason && <span className="italic">Lý do: {detail.request.reason}</span>}
            </div>

            {/* Bảng KPI Nam/Nữ (mục 2) */}
            <div className="overflow-hidden rounded-xl border border-border">
              <table className="w-full text-[12.5px]">
                <thead>
                  <tr className="bg-surface-hover text-[10.5px] uppercase tracking-wider text-fg-muted">
                    <th className="px-3 py-2 text-left">Chỉ số</th>
                    <th className="px-3 py-2 text-right">Nam</th>
                    <th className="px-3 py-2 text-right">Nữ</th>
                    <th className="px-3 py-2 text-right">Tổng</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {[
                    ["Nhu cầu (Requested)", detail.kpi.maleRequest, detail.kpi.femaleRequest, detail.kpi.totalRequest],
                    ["Hiện có (Current Workforce)", detail.kpi.maleCurrent, detail.kpi.femaleCurrent, detail.kpi.totalCurrent],
                    ["Đã tuyển (Recruited)", detail.kpi.maleRecruited, detail.kpi.femaleRecruited, detail.kpi.totalRecruited],
                    ["Nghỉ việc (Quit)", detail.kpi.maleQuit, detail.kpi.femaleQuit, detail.kpi.totalQuit],
                    ["Cần tuyển tiếp (Balance)", detail.kpi.maleBalance, detail.kpi.femaleBalance, detail.kpi.totalBalance],
                  ].map(([label, m, f, t]) => (
                    <tr key={label as string}>
                      <td className="px-3 py-1.5 font-semibold text-fg-secondary">{label as string}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-primary">{(m as number) ?? 0}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-accent">{(f as number) ?? 0}</td>
                      <td className="px-3 py-1.5 text-right font-bold tabular-nums">{(t as number) ?? 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="flex items-center gap-3 border-t border-border px-3 py-2">
                <span className="text-[11px] font-semibold text-fg-muted">Tỷ lệ đáp ứng</span>
                <div className="w-[160px]">
                  <ProgressBar value={detail.kpi.fillRatePercent} tone={detail.kpi.fillRatePercent >= 100 ? "success" : "primary"} />
                </div>
                <span className="text-[12px] font-bold tabular-nums">{detail.kpi.fillRatePercent}%</span>
              </div>
            </div>

            {/* Warnings */}
            {detail.kpi.warnings.length > 0 && (
              <div className="space-y-1.5">
                {detail.kpi.warnings.map((w) => (
                  <AlertPanel
                    key={w.code}
                    tone={WARNING_TONE[w.severity]}
                    icon={
                      w.severity === "BLOCKING" ? <ShieldAlert className="h-4 w-4" /> : w.severity === "SOFT" ? <AlertTriangle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />
                    }
                    title={WARNING_LABEL[w.code] ?? w.code}
                  >
                    <p>{w.message}</p>
                  </AlertPanel>
                ))}
              </div>
            )}

            {/* Pipeline */}
            {detail.pipeline.length > 0 && (
              <div>
                <SectionLabel>Pipeline (Daily Application + Workflow)</SectionLabel>
                <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                  {detail.pipeline.map((p) => (
                    <div key={p.status} className="rounded-lg border border-border bg-surface px-3 py-2">
                      <div className="text-[11px] font-semibold text-fg-muted">{p.status}</div>
                      <div className="text-[15px] font-bold">{p.total}</div>
                      <GenderSplit male={p.male} female={p.female} height={6} className="mt-1" />
                      <GenderLegend male={p.male} female={p.female} />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Lao động hiện có */}
            <div>
              <SectionLabel>Lao động hiện có ({detail.currentWorkers.length})</SectionLabel>
              {detail.currentWorkers.length === 0 ? (
                <p className="text-[12px] text-fg-muted">Chưa có lao động ACTIVE nào được phân bổ vào request này.</p>
              ) : (
                <div className="max-h-48 overflow-y-auto rounded-lg border border-border">
                  <table className="w-full text-[12px]">
                    <tbody className="divide-y divide-border">
                      {detail.currentWorkers.map((w) => (
                        <tr key={w.allocationId}>
                          <td className="px-3 py-1.5 font-semibold">{w.workerName ?? "—"}</td>
                          <td className={cn("px-3 py-1.5", w.gender && genderTone(w.gender) !== "muted" ? (genderTone(w.gender) === "primary" ? "text-primary" : "text-accent") : "text-fg-muted")}>
                            {w.gender ?? "—"}
                          </td>
                          <td className="px-3 py-1.5 text-fg-muted">{w.deptName ?? "—"}</td>
                          <td className="px-3 py-1.5 text-right text-[10.5px] text-fg-muted">Phân bổ {fmtDate(w.allocatedAt)} bởi {w.allocatedBy}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Nghỉ việc */}
            {detail.resignedWorkers.length > 0 && (
              <div>
                <SectionLabel>Nghỉ việc trong kỳ request ({detail.resignedWorkers.length})</SectionLabel>
                <div className="max-h-36 overflow-y-auto rounded-lg border border-border">
                  <table className="w-full text-[12px]">
                    <tbody className="divide-y divide-border">
                      {detail.resignedWorkers.map((w) => (
                        <tr key={w.movementId}>
                          <td className="px-3 py-1.5 font-semibold">{w.workerName ?? "—"}</td>
                          <td className="px-3 py-1.5 text-fg-muted">{w.gender ?? "—"}</td>
                          <td className="px-3 py-1.5 text-danger">Nghỉ {fmtDate(w.effectiveDate)}</td>
                          <td className="px-3 py-1.5 text-[11px] text-fg-muted">{w.reason ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Liên kết Planning (mục 8) */}
            <div className="rounded-lg border border-border bg-surface px-3 py-2.5">
              <div className="flex items-center gap-2 text-[12.5px]">
                <Link2 className="h-3.5 w-3.5 text-fg-muted" />
                <span className="font-semibold text-fg-secondary">Liên kết Planning:</span>
                {detail.linkedPeriod ? (
                  <span className="text-fg">
                    Period {fmtDate(detail.linkedPeriod.startDate)} → {fmtDate(detail.linkedPeriod.endDate)} ({detail.linkedPeriod.status}) — KPI Planning lấy từ request này.
                  </span>
                ) : (
                  <span className="text-fg-muted">Chưa liên kết Planning Period.</span>
                )}
              </div>
              {detail.can.linkPlanning && (
                <LinkPeriodControl requestId={detail.request.id} onLinked={() => void openDetail(detail.request.id)} />
              )}
            </div>

            {/* Lịch sử allocation (mục 15) */}
            {detail.history.length > 0 && (
              <div>
                <SectionLabel>Lịch sử allocation / audit</SectionLabel>
                <div className="max-h-44 space-y-1 overflow-y-auto rounded-lg border border-border px-3 py-2">
                  {detail.history.map((h) => (
                    <div key={h.id} className="flex flex-wrap items-center gap-2 text-[11.5px]">
                      <span className="font-semibold text-fg-muted">{fmtDateTime(h.changedAt)}</span>
                      <Badge tone={h.action === "OVERRIDE" ? "red" : h.action === "END" ? "amber" : "blue"}>{ACTION_LABEL[h.action] ?? h.action}</Badge>
                      <span className="font-semibold">{h.workerName ?? "—"}</span>
                      <span className="text-fg-muted">
                        {h.fromRequestId ? "từ request khác" : ""} {h.toRequestId ? "→ request này" : ""}
                      </span>
                      {h.reason && <span className="italic text-fg-muted">“{h.reason}”</span>}
                      <span className="text-fg-muted">bởi {h.changedBy}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {detail.overrides.length > 0 && (
              <div>
                <SectionLabel>Overrides vượt tổng nhu cầu ({detail.overrides.length})</SectionLabel>
                <div className="space-y-1 rounded-lg border border-danger/30 bg-danger-tint/40 px-3 py-2">
                  {detail.overrides.map((o) => (
                    <div key={o.id} className="text-[11.5px]">
                      <b>{fmtDateTime(o.createdAt)}</b> — {o.changedBy}: “{o.reason}” (tổng {o.currentTotal}/{o.totalRequest})
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Comments (mục 11) */}
            <div>
              <SectionLabel>Bình luận</SectionLabel>
              <div className="max-h-40 space-y-2 overflow-y-auto rounded-lg border border-border px-3 py-2">
                {detail.comments.length === 0 && <p className="text-[12px] text-fg-muted">Chưa có bình luận.</p>}
                {detail.comments.map((c) => (
                  <div key={c.id} className="text-[12px]">
                    <span className="font-semibold">{c.username}</span>{" "}
                    <span className="text-[10px] text-fg-muted">{fmtDateTime(c.createdAt)}</span>
                    <p className="whitespace-pre-wrap text-fg-secondary">{c.body}</p>
                  </div>
                ))}
              </div>
              {detail.can.comment && (
                <div className="mt-2 flex gap-2">
                  <Input
                    placeholder="Bình luận của bạn (Dept Manager có thể góp ý tại đây)..."
                    value={commentText}
                    onChange={(e) => setCommentText(e.target.value)}
                  />
                  <Button variant="outline" disabled={postingComment || !commentText.trim()} onClick={() => void postComment()}>
                    {postingComment ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MessageSquare className="h-3.5 w-3.5" />}
                    Gửi
                  </Button>
                </div>
              )}
            </div>

            {!readOnly && (
              <div className="flex justify-end">
                <Button
                  onClick={() => {
                    const row = rows.find((r) => r.id === detail.request.id);
                    if (row) void openAllocate(row);
                    setDetail(null);
                  }}
                >
                  <ArrowRightLeft className="mr-1.5 h-3.5 w-3.5" /> Phân bổ / tái phân bổ
                </Button>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* ALLOCATE MODAL */}
      <Modal open={!!allocateFor} onClose={() => setAllocateFor(null)} title={allocateFor ? `Phân bổ lao động → ${allocateFor.requestCode}` : ""} width="max-w-4xl">
        {allocateFor && (
          <div className="space-y-4">
            <div className="rounded-lg border border-border bg-surface px-3 py-2 text-[12px] text-fg-secondary">
              Nhu cầu: Nam <b>{allocateFor.kpi.maleRequest}</b> · Nữ <b>{allocateFor.kpi.femaleRequest}</b> · Tổng <b>{allocateFor.kpi.totalRequest}</b>
              <span className="mx-2">|</span>
              Hiện có: Nam <b>{allocateFor.kpi.maleCurrent}</b> · Nữ <b>{allocateFor.kpi.femaleCurrent}</b> · Tổng <b>{allocateFor.kpi.totalCurrent}</b>
              {allocateFor.kpi.totalCurrent >= allocateFor.kpi.totalRequest && (
                <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-danger-tint px-2 py-0.5 text-[10px] font-bold text-danger">
                  <AlertTriangle className="h-3 w-3" /> {TOTAL_OVER_TARGET_TEXT}
                </span>
              )}
            </div>

            <div className="flex items-center gap-2">
              <Search className="h-3.5 w-3.5 text-fg-muted" />
              <Input placeholder="Tìm theo tên hoặc CCCD..." value={candidateSearch} onChange={(e) => setCandidateSearch(e.target.value)} />
            </div>

            <div className="max-h-72 overflow-y-auto rounded-lg border border-border">
              <table className="w-full text-[12px]">
                <tbody className="divide-y divide-border">
                  {filteredCandidates.map((c) => (
                    <tr key={c.sessionId} className={cn("hover:bg-surface-hover", selectedSessions[c.sessionId] && "bg-botanical-50")}>
                      <td className="px-3 py-1.5">
                        <input
                          type="checkbox"
                          checked={!!selectedSessions[c.sessionId]}
                          onChange={(e) => setSelectedSessions((prev) => ({ ...prev, [c.sessionId]: e.target.checked }))}
                        />
                      </td>
                      <td className="px-2 py-1.5 font-semibold">{c.workerName ?? "—"}</td>
                      <td className="px-2 py-1.5 text-fg-muted">{c.cccd}</td>
                      <td className={cn("px-2 py-1.5", genderTone(c.gender) === "primary" && "text-primary", genderTone(c.gender) === "accent" && "text-accent")}>
                        {c.gender ?? "—"}
                      </td>
                      <td className="px-2 py-1.5 text-fg-muted">{c.deptName ?? "—"}</td>
                      <td className="px-2 py-1.5">
                        {c.currentRequestCode ? (
                          <Badge tone="blue">Đang ở {c.currentRequestCode}</Badge>
                        ) : (
                          <Badge tone="green">Chưa phân bổ</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                  {filteredCandidates.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-3 py-4 text-center text-fg-muted">
                        Không có lao động ACTIVE phù hợp. Lao động cần có Employment Session ACTIVE (APPROVED + chưa kết thúc).
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <FormField label="Lý do phân bổ / tái phân bổ (lưu vào audit)">
              <Input placeholder="Ví dụ: đáp ứng đơn hàng tuần này, thay thế người nghỉ việc..." value={reason} onChange={(e) => setReason(e.target.value)} />
            </FormField>

            {/* OVERRIDE (mục 6) */}
            {can.overallocate && (
              <div className="rounded-lg border border-warning/40 bg-warning-tint/30 px-3 py-2.5">
                <label className="flex items-center gap-2 text-[12.5px] font-semibold text-warning">
                  <input type="checkbox" checked={overrideOn} onChange={(e) => setOverrideOn(e.target.checked)} />
                  Override — phân bổ vượt tổng nhu cầu (bạn có quyền planning.overallocate)
                </label>
                {overrideOn && (
                  <div className="mt-2 space-y-2">
                    <p className="text-[11.5px] text-fg-muted">
                      Xác nhận này sẽ được <b>ghi audit riêng</b> (request_allocation_overrides) kèm lý do bắt buộc.
                    </p>
                    <Input placeholder="Lý do override (bắt buộc)" value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} />
                    {overrideOn && !overrideReason.trim() && <p className="text-[11px] text-danger">Phải nhập lý do override.</p>}
                  </div>
                )}
              </div>
            )}

            {allocateFor.kpi.totalCurrent >= allocateFor.kpi.totalRequest && !can.overallocate && (
              <AlertPanel
                tone="danger"
                icon={<ShieldAlert className="h-4 w-4" />}
                title={TOTAL_OVER_TARGET_TEXT}
              >
                <p>
                  Tổng phân bổ hiện tại <b>{allocateFor.kpi.totalCurrent}</b> đã đạt tổng nhu cầu <b>{allocateFor.kpi.totalRequest}</b>. Cần quyền{" "}
                  <b>planning.overallocate</b> để phân bổ thêm (kèm lý do + xác nhận + audit).
                </p>
              </AlertPanel>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setAllocateFor(null)}>
                Hủy
              </Button>
              <Button
                disabled={saving || Object.values(selectedSessions).filter(Boolean).length === 0 || (overrideOn && !overrideReason.trim())}
                onClick={() => void submitAllocate()}
              >
                {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <ArrowRightLeft className="mr-1.5 h-3.5 w-3.5" />}
                Phân bổ {Object.values(selectedSessions).filter(Boolean).length || ""}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

const TOTAL_OVER_TARGET_TEXT = "Tổng phân bổ đã vượt tổng nhu cầu.";

/** Chọn Planning Period để liên kết 2 chiều bằng ID (mục 8). */
function LinkPeriodControl({ requestId, onLinked }: { requestId: string; onLinked: () => void }) {
  const [periods, setPeriods] = useState<{ id: string; departmentId: string; deptName: string | null; startDate: string; endDate: string; status: string }[]>([]);
  const [selected, setSelected] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/planning?status=ALL")
      .then((r) => r.json())
      .then((json) => setPeriods((json as { rows: typeof periods }).rows ?? []))
      .catch(() => setPeriods([]));
  }, []);

  const link = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/workforce-requests/${requestId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planningPeriodId: selected }),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) {
        toast({ title: json.error ?? "Không thể liên kết Planning.", variant: "destructive" });
        return;
      }
      toast({ title: "Đã liên kết Workforce Request ↔ Planning (2 chiều bằng ID)." });
      onLinked();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <select
        className="h-8 max-w-[360px] rounded-lg border border-border bg-surface px-2 text-[12px] text-fg"
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
      >
        <option value="">Chọn Planning Period...</option>
        {periods.map((p) => (
          <option key={p.id} value={p.id}>
            {p.deptName ?? "—"} · {fmtDate(p.startDate)} → {fmtDate(p.endDate)} ({p.status})
          </option>
        ))}
      </select>
      <Button variant="outline" size="sm" disabled={saving || !selected} onClick={() => void link()}>
        {saving ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Link2 className="mr-1 h-3 w-3" />} Liên kết
      </Button>
    </div>
  );
}
