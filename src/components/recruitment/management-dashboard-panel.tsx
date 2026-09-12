"use client";

/* ============================================================
   RECRUITMENT MANAGEMENT DASHBOARD (Mission C — C3)
   ------------------------------------------------------------
   Renders GET /api/recruitment-requests/dashboard verbatim — every number
   here is server-computed (getRecruitmentManagementDashboard()); this
   component does NO computation, NO client-side KPI derivation, and issues
   NO direct DB queries. Live requests only (server already applied the
   strict live/historical separation) — this is deliberately NOT the same
   metric as the "Recruitment Balance vs Realtime Gap" snapshot elsewhere.
   ============================================================ */

import { Fragment, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  ErrorState,
  GenderLegend,
  Input,
  KpiCard,
  ProgressBar,
  SectionLabel,
  SkeletonTable,
  StatusBadge,
} from "@/components/ui";
import { fetchJsonWithTimeout, type ApiResult } from "@/lib/api-client";
import { RefreshCw, Target, TrendingUp, UserMinus, UserPlus, UsersRound } from "lucide-react";

type GenderCounts = { male: number; female: number; total: number };

type DashboardDeptRow = {
  departmentId: string;
  departmentName: string | null;
  currentDws: GenderCounts;
  demand: GenderCounts;
  attributed: GenderCounts;
  gap: GenderCounts;
  recruited: GenderCounts;
  quit: GenderCounts;
  transferOut: GenderCounts;
  fillRatePercent: number;
  liveRequestCount: number;
};

type LiveRequestRow = {
  id: string;
  requestCode: string;
  departmentId: string | null;
  departmentName: string | null;
  expectedDate: string | null;
  status: string;
  kpi: { totalCurrent: number; totalRequest: number; totalBalance: number; fillRatePercent: number };
};

type DashboardData = {
  asOfDate: string;
  summary: {
    currentDws: GenderCounts;
    demand: GenderCounts;
    attributed: GenderCounts;
    gap: GenderCounts;
    recruited: GenderCounts;
    quit: GenderCounts;
    transferOut: GenderCounts;
    fillRatePercent: number;
  };
  departments: DashboardDeptRow[];
  liveRequests: LiveRequestRow[];
};

function fmtDate(v?: string | null): string {
  if (!v) return "—";
  const [y, m, d] = v.slice(0, 10).split("-");
  if (!y || !m || !d) return v;
  return `${d}/${m}/${y}`;
}

export function ManagementDashboardPanel() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [expandedDept, setExpandedDept] = useState<string | null>(null);
  const [asOfDate, setAsOfDate] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result: ApiResult<DashboardData> = await fetchJsonWithTimeout(
      `/api/recruitment-requests/dashboard${asOfDate ? `?asOf=${asOfDate}` : ""}`,
      { timeoutMs: 12_000, label: "recruitment-requests.dashboard" },
    );
    if (result.ok) {
      setData(result.data);
    } else {
      setData(null);
      setError({ code: result.code, message: result.message });
    }
    setLoading(false);
  }, [asOfDate]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <SkeletonTable rows={6} cols={7} />;

  if (error || !data) {
    return (
      <ErrorState
        title="Không tải được Dashboard quản lý tuyển dụng"
        description={
          <span>
            {error?.message ?? "Đã có lỗi xảy ra."} <span className="text-fg-muted">Mã lỗi: {error?.code}</span>
          </span>
        }
        onRetry={() => void load()}
      />
    );
  }

  const { summary } = data;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="text-[11.5px] text-fg-muted">
          Dữ liệu tính tới <b>{fmtDate(data.asOfDate)}</b> — chỉ gồm Yêu cầu tuyển dụng đang mở (PENDING/PROCESSING); yêu cầu đã đóng không được cộng vào các tổng bên dưới.
        </p>
        <div className="flex items-end gap-2">
          <label className="flex flex-col gap-1 text-[11px] font-semibold text-fg-muted">
            Xem lại tại ngày
            <Input type="date" className="h-9 w-[150px]" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} />
          </label>
          <Button variant="outline" onClick={() => void load()} className="h-9">
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Làm mới
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-7">
        <KpiCard
          icon={<UsersRound className="h-4 w-4" />}
          label="Current DWS (Employment)"
          value={summary.currentDws.total}
          context={<GenderLegend male={summary.currentDws.male} female={summary.currentDws.female} />}
          tone="success"
        />
        <KpiCard
          icon={<Target className="h-4 w-4" />}
          label="Nhu cầu (Live Demand)"
          value={summary.demand.total}
          context={<GenderLegend male={summary.demand.male} female={summary.demand.female} />}
          tone="primary"
        />
        <KpiCard
          icon={<UsersRound className="h-4 w-4" />}
          label="Đã phân bổ (Attributed)"
          value={summary.attributed.total}
          context={<GenderLegend male={summary.attributed.male} female={summary.attributed.female} />}
          tone="info"
        />
        <KpiCard
          icon={<TrendingUp className="h-4 w-4" />}
          label="Còn thiếu (Gap)"
          value={summary.gap.total}
          context={<GenderLegend male={summary.gap.male} female={summary.gap.female} />}
          tone="warning"
        />
        <KpiCard
          icon={<UserPlus className="h-4 w-4" />}
          label="Đã tuyển (Recruited)"
          value={summary.recruited.total}
          context={<GenderLegend male={summary.recruited.male} female={summary.recruited.female} />}
          tone="success"
        />
        <KpiCard
          icon={<UserMinus className="h-4 w-4" />}
          label="Nghỉ / Chuyển đi"
          value={summary.quit.total + summary.transferOut.total}
          context={`Nghỉ ${summary.quit.total} · Chuyển ${summary.transferOut.total}`}
          tone="danger"
        />
        <KpiCard icon={<Target className="h-4 w-4" />} label="Tỉ lệ đáp ứng" value={`${summary.fillRatePercent}%`} tone="primary" />
      </div>

      <Card className="overflow-hidden p-0">
        <div className="border-b border-border px-5 py-3">
          <SectionLabel tone="green">Theo bộ phận</SectionLabel>
        </div>
        {data.departments.length === 0 ? (
          <EmptyState title="Không có bộ phận nào trong phạm vi dữ liệu của bạn" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-[12.5px]">
              <thead className="bg-primary-tint/60">
                <tr>
                  <th className="px-3 py-2 text-left text-[10.5px] font-bold uppercase tracking-wider text-primary">Bộ phận</th>
                  <th className="px-3 py-2 text-right text-[10.5px] font-bold uppercase tracking-wider text-primary">Current DWS</th>
                  <th className="px-3 py-2 text-right text-[10.5px] font-bold uppercase tracking-wider text-primary">Nhu cầu</th>
                  <th className="px-3 py-2 text-right text-[10.5px] font-bold uppercase tracking-wider text-primary">Đã phân bổ</th>
                  <th className="px-3 py-2 text-right text-[10.5px] font-bold uppercase tracking-wider text-primary">Còn thiếu</th>
                  <th className="px-3 py-2 text-right text-[10.5px] font-bold uppercase tracking-wider text-primary">Đã tuyển</th>
                  <th className="px-3 py-2 text-right text-[10.5px] font-bold uppercase tracking-wider text-primary">Nghỉ/Chuyển</th>
                  <th className="px-3 py-2 text-center text-[10.5px] font-bold uppercase tracking-wider text-primary">Đáp ứng</th>
                  <th className="px-3 py-2 text-right text-[10.5px] font-bold uppercase tracking-wider text-primary">RQ mở</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.departments.map((d) => (
                  <Fragment key={d.departmentId}>
                    <tr
                      className="cursor-pointer bg-surface transition-colors hover:bg-botanical-50"
                      onClick={() => setExpandedDept(expandedDept === d.departmentId ? null : d.departmentId)}
                    >
                      <td className="px-3 py-2.5 font-semibold text-fg">{d.departmentName ?? "Chưa xếp phòng ban"}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{d.currentDws.total}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{d.demand.total}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{d.attributed.total}</td>
                      <td className="px-3 py-2.5 text-right font-bold tabular-nums text-warning">{d.gap.total}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{d.recruited.total}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{d.quit.total + d.transferOut.total}</td>
                      <td className="px-3 py-2.5 text-center">
                        <div className="mx-auto w-[80px]">
                          <ProgressBar value={d.fillRatePercent} tone={d.fillRatePercent >= 100 ? "success" : "primary"} />
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums">{d.liveRequestCount}</td>
                    </tr>
                    {expandedDept === d.departmentId && (
                      <tr>
                        <td colSpan={9} className="bg-surface-hover px-3 py-3">
                          <LiveRequestDrillDown
                            rows={data.liveRequests.filter((r) => (r.departmentId ?? "__none__") === d.departmentId)}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function LiveRequestDrillDown({ rows }: { rows: LiveRequestRow[] }) {
  if (rows.length === 0) return <p className="text-[12px] text-fg-muted">Không có Yêu cầu tuyển dụng đang mở nào.</p>;
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <table className="w-full text-[12px]">
        <thead className="bg-surface-hover">
          <tr>
            <th className="px-3 py-1.5 text-left text-[10px] font-bold uppercase text-fg-muted">Mã YC</th>
            <th className="px-3 py-1.5 text-center text-[10px] font-bold uppercase text-fg-muted">Trạng thái</th>
            <th className="px-3 py-1.5 text-right text-[10px] font-bold uppercase text-fg-muted">Nhu cầu</th>
            <th className="px-3 py-1.5 text-right text-[10px] font-bold uppercase text-fg-muted">Đã phân bổ</th>
            <th className="px-3 py-1.5 text-right text-[10px] font-bold uppercase text-fg-muted">Còn thiếu</th>
            <th className="px-3 py-1.5 text-right text-[10px] font-bold uppercase text-fg-muted">Ngày cần nhân lực</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border bg-surface">
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="px-3 py-1.5">
                <Link href={`/admin/recruitment-requests/${r.id}`} className="font-mono font-semibold text-primary hover:underline">
                  {r.requestCode}
                </Link>
              </td>
              <td className="px-3 py-1.5 text-center">
                <StatusBadge status={r.status} />
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums">{r.kpi.totalRequest}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{r.kpi.totalCurrent}</td>
              <td className="px-3 py-1.5 text-right font-bold tabular-nums text-warning">{r.kpi.totalBalance}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{fmtDate(r.expectedDate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
