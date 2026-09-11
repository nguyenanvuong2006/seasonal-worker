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
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  ErrorState,
  KpiCard,
  PageHeader,
  SkeletonCard,
  StatusBadge,
  cn,
} from "@/components/ui";
import { fetchJsonWithTimeout, type ApiResult } from "@/lib/api-client";
import {
  ArrowLeft,
  ArrowRightLeft,
  FileDown,
  Target,
  UserCheck,
  UserMinus,
  UserPlus,
  Users,
} from "lucide-react";

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
  asOf: string;
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

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export default function RecruitmentRequestDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;

  const [detail, setDetail] = useState<RequestDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [tab, setTab] = useState<TabKey>("recruited");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result: ApiResult<RequestDetail> = await fetchJsonWithTimeout(`/api/recruitment-requests/${id}/detail`, {
      timeoutMs: 12_000,
      label: "recruitment-requests.detail",
    });
    if (result.ok) {
      setDetail(result.data);
    } else {
      setDetail(null);
      setError({ code: result.code, message: result.message });
    }
    setLoading(false);
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const isLive = useMemo(() => detail?.asOf === todayISO(), [detail]);
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
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => router.push("/admin/recruitment-requests")}>
              <ArrowLeft className="h-4 w-4" /> Quay lại danh sách
            </Button>
            <Button variant="primary" onClick={() => window.open(`/api/recruitment-requests/${id}/export`, "_blank")}>
              <FileDown className="h-4 w-4" /> Xuất Excel
            </Button>
          </div>
        }
      />

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
    </div>
  );
}
