"use client";

/* ============================================================
   CANONICAL REQUEST DETAIL — /admin/recruitment-requests/:id
   ------------------------------------------------------------
   Phase 2C. Đọc 100% từ GET /api/recruitment-requests/:id/detail
   (getRequestDetail() — cùng engine với /admin/workforce-requests và
   Excel export, KHÔNG tính lại KPI ở client). KPI cards click được để
   lọc tab bên dưới. Nhãn "Hiện tại" vs "Cuối kỳ (Closing Workforce)"
   phụ thuộc asOf server trả về có bằng hôm nay hay không (đóng băng
   theo resolveDefaultAsOf cho request đã EXPIRED/COMPLETED/CANCELLED).
   ============================================================ */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  AlertPanel,
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  ErrorState,
  FormField,
  Input,
  KpiCard,
  Modal,
  PageHeader,
  SectionLabel,
  SkeletonCard,
  StatusBadge,
  cn,
  toast,
} from "@/components/ui";
import { fetchJsonWithTimeout, type ApiResult } from "@/lib/api-client";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRightLeft,
  CheckCircle2,
  FileDown,
  Link2,
  Loader2,
  MessageSquare,
  Search,
  ShieldAlert,
  Target,
  UserCheck,
  UserMinus,
  UserPlus,
  Users,
} from "lucide-react";

type WarningDetail = { code: string; severity: "OK" | "SOFT" | "BLOCKING"; message: string };

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

const ACTION_LABEL: Record<string, string> = {
  ALLOCATE: "Phân bổ mới",
  REALLOCATE: "Tái phân bổ",
  END: "Kết thúc allocation",
  OVERRIDE: "Phân bổ vượt tổng (override)",
};

function genderTone(g?: string | null): "primary" | "accent" | "muted" {
  const gNorm = (g ?? "").trim().toLowerCase();
  if (["nữ", "nu", "female", "f"].includes(gNorm) || gNorm.includes("nữ") || gNorm.includes("nu")) return "accent";
  if (["nam", "male", "m"].includes(gNorm) || gNorm.includes("nam")) return "primary";
  return "muted";
}

function formatDateTime(v?: string | null): string {
  if (!v) return "—";
  const d = new Date(v);
  return `${d.toLocaleDateString("vi-VN")} ${d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })}`;
}

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
  maleTransferOut: number;
  femaleTransferOut: number;
  totalTransferOut: number;
  maleBalance: number;
  femaleBalance: number;
  totalBalance: number;
  fillRatePercent: number;
  warnings: WarningDetail[];
};

type PipelineRow = { status: string; male: number; female: number; total: number };
type CurrentWorkerRow = {
  allocationId: string;
  workerId: string;
  workerName: string | null;
  gender: string | null;
  deptName: string | null;
  allocatedAt: string;
  allocatedBy: string;
};
type ResignedWorkerRow = {
  movementId: string;
  workerId: string;
  workerName: string | null;
  gender: string | null;
  effectiveDate: string;
  reason: string | null;
};
type TransferredWorkerRow = {
  movementId: string;
  workerId: string;
  workerName: string | null;
  gender: string | null;
  effectiveDate: string;
  fromDeptName: string | null;
  toDeptName: string | null;
  destinationRequestId: string | null;
  destinationRequestCode: string | null;
};

type HistoryRow = {
  id: string;
  action: string;
  workerName: string | null;
  fromRequestId: string | null;
  toRequestId: string | null;
  reason: string | null;
  overrideConfirmed: boolean;
  changedBy: string;
  changedAt: string;
};
type OverrideRow = { id: string; changedBy: string; reason: string; currentTotal: number; totalRequest: number; createdAt: string };
type CommentRow = { id: string; username: string; body: string; createdAt: string };
type LinkedPeriod = { id: string; status: string; startDate: string; endDate: string } | null;
type Can = { allocate: boolean; overallocate: boolean; comment: boolean; linkPlanning: boolean };

type RequestDetail = {
  request: {
    id: string;
    requestCode: string;
    requester: string;
    status: string;
    deptName: string | null;
    department: string | null;
    requestedDate: string | null;
    expectedDate: string | null;
    completedDate: string | null;
    endDate: string | null;
  };
  kpi: RequestKpi;
  pipeline: PipelineRow[];
  currentWorkers: CurrentWorkerRow[];
  resignedWorkers: ResignedWorkerRow[];
  transferredWorkers: TransferredWorkerRow[];
  history: HistoryRow[];
  overrides: OverrideRow[];
  comments: CommentRow[];
  linkedPeriod: LinkedPeriod;
  can: Can;
  asOf: string;
  /** Server-computed (asOf === todayStr(), Vietnam-local) — never derive this on the
   *  client via `new Date()`, which reads the browser's UTC calendar day and drifts
   *  from Vietnam-local for ~7 hours every day (00:00–06:59 ICT). */
  isLive: boolean;
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

type TabKey = "recruited" | "current" | "resigned" | "transferred";

const TABS: { key: TabKey; label: string }[] = [
  { key: "recruited", label: "Đã tuyển (Pipeline)" },
  { key: "current", label: "Đang làm việc" },
  { key: "resigned", label: "Nghỉ việc" },
  { key: "transferred", label: "Chuyển đi" },
];

function formatDate(d?: string | null) {
  if (!d) return "—";
  const [y, m, day] = String(d).split("-");
  if (!day) return String(d);
  return `${day}/${m}/${y}`;
}

export default function RecruitmentRequestDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;

  const [detail, setDetail] = useState<RequestDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [tab, setTab] = useState<TabKey>("recruited");

  // Historical snapshot picker (C1 — ported from /admin/workforce-requests).
  // Bỏ trống = server tự resolve (hôm nay nếu request còn mở, đóng băng tại
  // ngày đóng nếu request đã EXPIRED/COMPLETED/CANCELLED — resolveDefaultAsOf).
  const [asOfDate, setAsOfDate] = useState("");

  // Allocate / reallocate modal (C1 — ported from /admin/workforce-requests).
  const [allocateOpen, setAllocateOpen] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [candidateSearch, setCandidateSearch] = useState("");
  const [selectedSessions, setSelectedSessions] = useState<Record<string, boolean>>({});
  const [allocReason, setAllocReason] = useState("");
  const [overrideOn, setOverrideOn] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  const [allocSaving, setAllocSaving] = useState(false);

  // Comments (C1 — ported from /admin/workforce-requests).
  const [commentText, setCommentText] = useState("");
  const [postingComment, setPostingComment] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result: ApiResult<RequestDetail> = await fetchJsonWithTimeout(
      `/api/recruitment-requests/${id}/detail${asOfDate ? `?asOf=${asOfDate}` : ""}`,
      { timeoutMs: 12_000, label: "recruitment-requests.detail" },
    );
    if (result.ok) {
      setDetail(result.data);
    } else {
      setDetail(null);
      setError({ code: result.code, message: result.message });
    }
    setLoading(false);
  }, [id, asOfDate]);

  const openAllocate = useCallback(async () => {
    setAllocateOpen(true);
    setSelectedSessions({});
    setAllocReason("");
    setOverrideOn(false);
    setOverrideReason("");
    const result = await fetchJsonWithTimeout<{ rows: Candidate[] }>("/api/workforce-requests/unplanned", {
      label: "workforce-requests.unplanned",
    });
    setCandidates(result.ok ? (result.data.rows ?? []) : []);
  }, []);

  const submitAllocate = useCallback(async () => {
    const ids = candidates.filter((c) => selectedSessions[c.sessionId]).map((c) => c.sessionId);
    if (ids.length === 0) {
      toast({ title: "Chưa chọn lao động nào.", variant: "destructive" });
      return;
    }
    setAllocSaving(true);
    try {
      const result = await fetchJsonWithTimeout<{ warnings?: WarningDetail[]; overridden?: boolean }>(
        `/api/workforce-requests/${id}/allocate`,
        {
          label: "workforce-requests.allocate",
          init: {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              employmentSessionIds: ids,
              reason: allocReason.trim() || null,
              override: overrideOn ? { confirmed: true, reason: overrideReason } : null,
            }),
          },
        },
      );
      if (!result.ok) {
        toast({ title: result.message, variant: "destructive" });
        return;
      }
      const warningTitles = (result.data.warnings ?? []).filter((w) => w.severity !== "OK").map((w) => WARNING_LABEL[w.code] ?? w.code);
      toast({
        title: `Đã phân bổ ${ids.length} lao động${result.data.overridden ? " (override vượt tổng)" : ""}${warningTitles.length ? ` — ${warningTitles.join(", ")}` : ""}`,
      });
      setAllocateOpen(false);
      void load();
    } finally {
      setAllocSaving(false);
    }
  }, [id, candidates, selectedSessions, allocReason, overrideOn, overrideReason, load]);

  const postComment = useCallback(async () => {
    const text = commentText.trim();
    if (!text) return;
    setPostingComment(true);
    try {
      const result = await fetchJsonWithTimeout(`/api/workforce-requests/${id}/comments`, {
        label: "workforce-requests.comments",
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: text }),
        },
      });
      if (!result.ok) {
        toast({ title: result.message, variant: "destructive" });
        return;
      }
      setCommentText("");
      void load();
    } finally {
      setPostingComment(false);
    }
  }, [id, commentText, load]);

  const filteredCandidates = useMemo(() => {
    const q = candidateSearch.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter(
      (c) => (c.workerName ?? "").toLowerCase().includes(q) || c.cccd.includes(q) || (c.currentRequestCode ?? "").toLowerCase().includes(q),
    );
  }, [candidates, candidateSearch]);

  useEffect(() => {
    void load();
  }, [load]);

  const isLive = detail?.isLive ?? true;
  const currentLabel = isLive ? "Hiện tại" : "Cuối kỳ (Closing Workforce)";

  if (loading) {
    return (
      <div className="space-y-5">
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  if (error || !detail) {
    return (
      <ErrorState
        title="Không tải được chi tiết yêu cầu tuyển dụng"
        description={
          <span>
            {error?.message ?? "Yêu cầu không tồn tại hoặc bạn không có quyền xem."}
            {error?.code ? <span className="text-fg-muted"> Mã lỗi: {error.code}</span> : null}
          </span>
        }
        onRetry={() => void load()}
      />
    );
  }

  const { request, kpi } = detail;

  return (
    <div className="space-y-5">
      <PageHeader
        breadcrumb={[
          { label: "Yêu cầu tuyển dụng", href: "/admin/recruitment-requests" },
          { label: request.requestCode },
        ]}
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{request.requestCode}</span>
            <StatusBadge status={request.status} />
            {!isLive && <Badge tone="gray">Đóng băng tại {formatDate(detail.asOf)}</Badge>}
          </span>
        }
        description={
          <>
            {request.deptName ?? request.department ?? "Chưa xếp phòng ban"} • Người yêu cầu: {request.requester} •
            {" "}Ngày yêu cầu: {formatDate(request.requestedDate)} • Ngày cần nhân lực: {formatDate(request.expectedDate)}
          </>
        }
        actions={
          <div className="flex flex-wrap items-end gap-2">
            <FormField label="Xem lại tại ngày (snapshot)" className="min-w-[150px]">
              <Input type="date" className="h-9" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} />
            </FormField>
            <Button variant="outline" onClick={() => router.push("/admin/recruitment-requests")}>
              <ArrowLeft className="h-4 w-4" /> Quay lại danh sách
            </Button>
            {detail.can.allocate && (
              <Button onClick={() => void openAllocate()}>
                <ArrowRightLeft className="h-4 w-4" /> Phân bổ / tái phân bổ
              </Button>
            )}
            <Button variant="primary" onClick={() => window.open(`/api/recruitment-requests/${id}/export`, "_blank")}>
              <FileDown className="h-4 w-4" /> Xuất Excel
            </Button>
          </div>
        }
      />

      {/* Cảnh báo (mục 6, 15 — ported from /admin/workforce-requests) */}
      {kpi.warnings.length > 0 && (
        <div className="space-y-1.5">
          {kpi.warnings.map((w) => (
            <AlertPanel
              key={w.code}
              tone={WARNING_TONE[w.severity]}
              icon={w.severity === "BLOCKING" ? <ShieldAlert className="h-4 w-4" /> : w.severity === "SOFT" ? <AlertTriangle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
              title={WARNING_LABEL[w.code] ?? w.code}
            >
              <p>{w.message}</p>
            </AlertPanel>
          ))}
        </div>
      )}

      {/* KPI cards — click để lọc tab bên dưới */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard icon={<Target className="h-4 w-4" />} label="Nhu cầu (Requested)" value={kpi.totalRequest} context={`Nam ${kpi.maleRequest} · Nữ ${kpi.femaleRequest}`} tone="primary" />
        <KpiCard icon={<UserPlus className="h-4 w-4" />} label="Đã tuyển (Recruited)" value={kpi.totalRecruited} context={`Nam ${kpi.maleRecruited} · Nữ ${kpi.femaleRecruited}`} tone="success" onClick={() => setTab("recruited")} />
        <KpiCard icon={<Users className="h-4 w-4" />} label={currentLabel} value={kpi.totalCurrent} context={`Nam ${kpi.maleCurrent} · Nữ ${kpi.femaleCurrent}`} tone="info" onClick={() => setTab("current")} />
        <KpiCard icon={<UserMinus className="h-4 w-4" />} label="Nghỉ việc (Quit)" value={kpi.totalQuit} context={`Nam ${kpi.maleQuit} · Nữ ${kpi.femaleQuit}`} tone="danger" onClick={() => setTab("resigned")} />
        <KpiCard icon={<ArrowRightLeft className="h-4 w-4" />} label="Chuyển đi (Transfer Out)" value={kpi.totalTransferOut} context={`Nam ${kpi.maleTransferOut} · Nữ ${kpi.femaleTransferOut}`} tone="warning" onClick={() => setTab("transferred")} />
        <KpiCard icon={<UserCheck className="h-4 w-4" />} label="Còn thiếu (Balance)" value={kpi.totalBalance} context={`Nam ${kpi.maleBalance} · Nữ ${kpi.femaleBalance}`} tone="warning" />
        <KpiCard icon={<Target className="h-4 w-4" />} label="Tỉ lệ đáp ứng (Fill Rate)" value={`${kpi.fillRatePercent}%`} tone="primary" />
      </div>

      {/* Tabs */}
      <Card className="overflow-hidden p-0">
        <div className="flex flex-wrap gap-1 border-b border-border bg-surface-raised p-2">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                "rounded-[8px] px-3 py-1.5 text-[12.5px] font-semibold transition-colors",
                tab === t.key ? "bg-primary text-white" : "text-fg-secondary hover:bg-surface-hover",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <CardContent className="p-0">
          {tab === "recruited" && (
            detail.pipeline.length === 0 ? (
              <EmptyState title="Chưa có ứng viên nào ở pipeline" />
            ) : (
              <table className="w-full text-[12.5px]">
                <thead className="bg-primary-tint/60">
                  <tr>
                    <th className="px-4 py-2 text-left text-[10.5px] font-bold uppercase tracking-wider text-primary">Giai đoạn</th>
                    <th className="px-4 py-2 text-right text-[10.5px] font-bold uppercase tracking-wider text-primary">Nam</th>
                    <th className="px-4 py-2 text-right text-[10.5px] font-bold uppercase tracking-wider text-primary">Nữ</th>
                    <th className="px-4 py-2 text-right text-[10.5px] font-bold uppercase tracking-wider text-primary">Tổng</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {detail.pipeline.map((p) => (
                    <tr key={p.status}>
                      <td className="px-4 py-2 font-medium text-fg">{p.status}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{p.male}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{p.female}</td>
                      <td className="px-4 py-2 text-right font-semibold tabular-nums">{p.total}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}

          {tab === "current" && (
            detail.currentWorkers.length === 0 ? (
              <EmptyState title={`Không có lao động nào — ${currentLabel}`} />
            ) : (
              <table className="w-full text-[12.5px]">
                <thead className="bg-primary-tint/60">
                  <tr>
                    <th className="px-4 py-2 text-left text-[10.5px] font-bold uppercase tracking-wider text-primary">Họ tên</th>
                    <th className="px-4 py-2 text-left text-[10.5px] font-bold uppercase tracking-wider text-primary">Giới tính</th>
                    <th className="px-4 py-2 text-left text-[10.5px] font-bold uppercase tracking-wider text-primary">Bộ phận</th>
                    <th className="px-4 py-2 text-left text-[10.5px] font-bold uppercase tracking-wider text-primary">Ngày phân bổ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {detail.currentWorkers.map((w) => (
                    <tr key={w.allocationId}>
                      <td className="px-4 py-2">
                        <Link href={`/admin/worker-profiles/${w.workerId}`} className="font-medium text-accent hover:underline">
                          {w.workerName ?? "—"}
                        </Link>
                      </td>
                      <td className="px-4 py-2 text-fg-secondary">{w.gender ?? "—"}</td>
                      <td className="px-4 py-2 text-fg-secondary">{w.deptName ?? "—"}</td>
                      <td className="px-4 py-2 text-fg-secondary">{formatDate(w.allocatedAt.slice(0, 10))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}

          {tab === "resigned" && (
            detail.resignedWorkers.length === 0 ? (
              <EmptyState title="Không có ai nghỉ việc trong kỳ này" />
            ) : (
              <table className="w-full text-[12.5px]">
                <thead className="bg-primary-tint/60">
                  <tr>
                    <th className="px-4 py-2 text-left text-[10.5px] font-bold uppercase tracking-wider text-primary">Họ tên</th>
                    <th className="px-4 py-2 text-left text-[10.5px] font-bold uppercase tracking-wider text-primary">Giới tính</th>
                    <th className="px-4 py-2 text-left text-[10.5px] font-bold uppercase tracking-wider text-primary">Ngày hiệu lực</th>
                    <th className="px-4 py-2 text-left text-[10.5px] font-bold uppercase tracking-wider text-primary">Lý do</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {detail.resignedWorkers.map((w) => (
                    <tr key={w.movementId}>
                      <td className="px-4 py-2">
                        <Link href={`/admin/worker-profiles/${w.workerId}`} className="font-medium text-accent hover:underline">
                          {w.workerName ?? "—"}
                        </Link>
                      </td>
                      <td className="px-4 py-2 text-fg-secondary">{w.gender ?? "—"}</td>
                      <td className="px-4 py-2 text-fg-secondary">{formatDate(w.effectiveDate)}</td>
                      <td className="px-4 py-2 text-fg-secondary">{w.reason ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}

          {tab === "transferred" && (
            detail.transferredWorkers.length === 0 ? (
              <EmptyState title="Không có ai chuyển đi trong kỳ này" />
            ) : (
              <table className="w-full text-[12.5px]">
                <thead className="bg-primary-tint/60">
                  <tr>
                    <th className="px-4 py-2 text-left text-[10.5px] font-bold uppercase tracking-wider text-primary">Họ tên</th>
                    <th className="px-4 py-2 text-left text-[10.5px] font-bold uppercase tracking-wider text-primary">Giới tính</th>
                    <th className="px-4 py-2 text-left text-[10.5px] font-bold uppercase tracking-wider text-primary">Ngày hiệu lực</th>
                    <th className="px-4 py-2 text-left text-[10.5px] font-bold uppercase tracking-wider text-primary">Từ → Đến</th>
                    <th className="px-4 py-2 text-left text-[10.5px] font-bold uppercase tracking-wider text-primary">Request đích</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {detail.transferredWorkers.map((w) => (
                    <tr key={w.movementId}>
                      <td className="px-4 py-2">
                        <Link href={`/admin/worker-profiles/${w.workerId}`} className="font-medium text-accent hover:underline">
                          {w.workerName ?? "—"}
                        </Link>
                      </td>
                      <td className="px-4 py-2 text-fg-secondary">{w.gender ?? "—"}</td>
                      <td className="px-4 py-2 text-fg-secondary">{formatDate(w.effectiveDate)}</td>
                      <td className="px-4 py-2 text-fg-secondary">
                        {w.fromDeptName ?? "—"} → {w.toDeptName ?? "—"}
                      </td>
                      <td className="px-4 py-2 text-fg-secondary">
                        {w.destinationRequestCode ?? <span className="italic text-fg-muted">Chưa phân bổ</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}
        </CardContent>
      </Card>

      {/* Liên kết Planning (C1 — ported from /admin/workforce-requests) */}
      <Card>
        <CardContent className="px-4 py-3">
          <div className="flex items-center gap-2 text-[12.5px]">
            <Link2 className="h-3.5 w-3.5 text-fg-muted" />
            <span className="font-semibold text-fg-secondary">Liên kết Planning:</span>
            {detail.linkedPeriod ? (
              <span className="text-fg">
                Period {formatDate(detail.linkedPeriod.startDate)} → {formatDate(detail.linkedPeriod.endDate)} ({detail.linkedPeriod.status}) — KPI Planning lấy từ request này.
              </span>
            ) : (
              <span className="text-fg-muted">Chưa liên kết Planning Period.</span>
            )}
          </div>
          {detail.can.linkPlanning && <LinkPeriodControl requestId={id} onLinked={() => void load()} />}
        </CardContent>
      </Card>

      {/* Lịch sử allocation / audit (C1 — ported from /admin/workforce-requests) */}
      {detail.history.length > 0 && (
        <Card>
          <CardContent>
            <SectionLabel>Lịch sử allocation / audit</SectionLabel>
            <div className="mt-2 max-h-56 space-y-1.5 overflow-y-auto">
              {detail.history.map((h) => (
                <div key={h.id} className="flex flex-wrap items-center gap-2 text-[11.5px]">
                  <span className="font-semibold text-fg-muted">{formatDateTime(h.changedAt)}</span>
                  <Badge tone={h.action === "OVERRIDE" ? "red" : h.action === "END" ? "amber" : "blue"}>{ACTION_LABEL[h.action] ?? h.action}</Badge>
                  <span className="font-semibold">{h.workerName ?? "—"}</span>
                  <span className="text-fg-muted">
                    {h.fromRequestId ? "từ request khác" : ""} {h.toRequestId ? "→ request này" : ""}
                  </span>
                  {h.reason && <span className="italic text-fg-muted">&ldquo;{h.reason}&rdquo;</span>}
                  <span className="text-fg-muted">bởi {h.changedBy}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {detail.overrides.length > 0 && (
        <Card className="border-danger/30 bg-danger-tint/20">
          <CardContent>
            <SectionLabel>Overrides vượt tổng nhu cầu ({detail.overrides.length})</SectionLabel>
            <div className="mt-2 space-y-1">
              {detail.overrides.map((o) => (
                <div key={o.id} className="text-[11.5px]">
                  <b>{formatDateTime(o.createdAt)}</b> — {o.changedBy}: &ldquo;{o.reason}&rdquo; (tổng {o.currentTotal}/{o.totalRequest})
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Bình luận (C1 — ported from /admin/workforce-requests) */}
      <Card>
        <CardContent>
          <SectionLabel>Bình luận</SectionLabel>
          <div className="mt-2 max-h-40 space-y-2 overflow-y-auto">
            {detail.comments.length === 0 && <p className="text-[12px] text-fg-muted">Chưa có bình luận.</p>}
            {detail.comments.map((c) => (
              <div key={c.id} className="text-[12px]">
                <span className="font-semibold">{c.username}</span> <span className="text-[10px] text-fg-muted">{formatDateTime(c.createdAt)}</span>
                <p className="whitespace-pre-wrap text-fg-secondary">{c.body}</p>
              </div>
            ))}
          </div>
          {detail.can.comment && (
            <div className="mt-2 flex gap-2">
              <Input placeholder="Bình luận của bạn..." value={commentText} onChange={(e) => setCommentText(e.target.value)} />
              <Button variant="outline" disabled={postingComment || !commentText.trim()} onClick={() => void postComment()}>
                {postingComment ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MessageSquare className="h-3.5 w-3.5" />}
                Gửi
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ALLOCATE MODAL (C1 — ported from /admin/workforce-requests) */}
      <Modal open={allocateOpen} onClose={() => setAllocateOpen(false)} title={`Phân bổ lao động → ${request.requestCode}`} width="max-w-4xl">
        <div className="space-y-4">
          <div className="rounded-lg border border-border bg-surface px-3 py-2 text-[12px] text-fg-secondary">
            Nhu cầu: Nam <b>{kpi.maleRequest}</b> · Nữ <b>{kpi.femaleRequest}</b> · Tổng <b>{kpi.totalRequest}</b>
            <span className="mx-2">|</span>
            Hiện có: Nam <b>{kpi.maleCurrent}</b> · Nữ <b>{kpi.femaleCurrent}</b> · Tổng <b>{kpi.totalCurrent}</b>
            {kpi.totalCurrent >= kpi.totalRequest && (
              <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-danger-tint px-2 py-0.5 text-[10px] font-bold text-danger">
                <AlertTriangle className="h-3 w-3" /> Tổng phân bổ đã vượt tổng nhu cầu.
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
                      {c.currentRequestCode ? <Badge tone="blue">Đang ở {c.currentRequestCode}</Badge> : <Badge tone="green">Chưa phân bổ</Badge>}
                    </td>
                  </tr>
                ))}
                {filteredCandidates.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-4 text-center text-fg-muted">
                      Không có lao động ACTIVE phù hợp.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <FormField label="Lý do phân bổ / tái phân bổ (lưu vào audit)">
            <Input placeholder="Ví dụ: đáp ứng đơn hàng tuần này, thay thế người nghỉ việc..." value={allocReason} onChange={(e) => setAllocReason(e.target.value)} />
          </FormField>

          {detail.can.overallocate && (
            <div className="rounded-lg border border-warning/40 bg-warning-tint/30 px-3 py-2.5">
              <label className="flex items-center gap-2 text-[12.5px] font-semibold text-warning">
                <input type="checkbox" checked={overrideOn} onChange={(e) => setOverrideOn(e.target.checked)} />
                Override — phân bổ vượt tổng nhu cầu (bạn có quyền planning.overallocate)
              </label>
              {overrideOn && (
                <div className="mt-2 space-y-2">
                  <p className="text-[11.5px] text-fg-muted">Xác nhận này sẽ được ghi audit riêng kèm lý do bắt buộc.</p>
                  <Input placeholder="Lý do override (bắt buộc)" value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} />
                  {!overrideReason.trim() && <p className="text-[11px] text-danger">Phải nhập lý do override.</p>}
                </div>
              )}
            </div>
          )}

          {kpi.totalCurrent >= kpi.totalRequest && !detail.can.overallocate && (
            <AlertPanel tone="danger" icon={<ShieldAlert className="h-4 w-4" />} title="Tổng phân bổ đã vượt tổng nhu cầu.">
              <p>
                Tổng phân bổ hiện tại <b>{kpi.totalCurrent}</b> đã đạt tổng nhu cầu <b>{kpi.totalRequest}</b>. Cần quyền <b>planning.overallocate</b> để phân bổ thêm.
              </p>
            </AlertPanel>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setAllocateOpen(false)}>
              Hủy
            </Button>
            <Button
              disabled={allocSaving || Object.values(selectedSessions).filter(Boolean).length === 0 || (overrideOn && !overrideReason.trim())}
              onClick={() => void submitAllocate()}
            >
              {allocSaving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <ArrowRightLeft className="mr-1.5 h-3.5 w-3.5" />}
              Phân bổ {Object.values(selectedSessions).filter(Boolean).length || ""}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

/** Chọn Planning Period để liên kết 2 chiều bằng ID (C1 — ported from /admin/workforce-requests). */
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
      toast({ title: "Đã liên kết Recruitment Request ↔ Planning (2 chiều bằng ID)." });
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
            {p.deptName ?? "—"} · {formatDate(p.startDate)} → {formatDate(p.endDate)} ({p.status})
          </option>
        ))}
      </select>
      <Button variant="outline" size="sm" disabled={saving || !selected} onClick={() => void link()}>
        {saving ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Link2 className="mr-1 h-3 w-3" />} Liên kết
      </Button>
    </div>
  );
}
