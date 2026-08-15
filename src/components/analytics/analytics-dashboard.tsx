"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Download } from "lucide-react";
import { ErrorState } from "@/components/ui";
import AnalyticsFilterBar, { DEFAULT_FILTERS, type FilterState } from "@/components/analytics/analytics-filter-bar";
import KpiStrip from "@/components/analytics/kpi-strip";
import RecruitmentFunnel from "@/components/analytics/recruitment-funnel";
import RecruitmentTrend from "@/components/analytics/recruitment-trend";
import WorkerMix from "@/components/analytics/worker-mix";
import ReferralPerformance from "@/components/analytics/referral-performance";
import PlanningPerformance from "@/components/analytics/planning-performance";
import DepartmentPerformance from "@/components/analytics/department-performance";
import Demographics from "@/components/analytics/demographics";
import WorkforceMovementsChart from "@/components/analytics/workforce-movements-chart";
import ReturningWorkers from "@/components/analytics/returning-workers";
import DataQuality from "@/components/analytics/data-quality";
import { AnalyticsCard, ChartEmpty } from "@/components/analytics/chart-primitives";
import { formatDate } from "@/lib/helpers";
import type { DashboardAnalytics } from "@/lib/analytics-core";

/**
 * Orchestrator của Workforce Analytics Dashboard:
 *   - Giữ filter state, persist vào query string (?from=...&to=...&departmentId=...) —
 *     refresh/back/bookmark giữ nguyên bộ lọc.
 *   - 1 fetch DUY NHẤT tới GET /api/analytics/dashboard cho toàn bộ widget.
 *   - Click 1 department ở bất kỳ widget nào = apply global filter.
 */

const QS_KEYS: (keyof FilterState)[] = [
  "from",
  "to",
  "location",
  "division",
  "departmentId",
  "section",
  "groupName",
  "workerType",
  "gender",
  "referralChannel",
  "status",
];

function filtersFromSearchParams(sp: URLSearchParams): FilterState {
  const def = DEFAULT_FILTERS();
  const out = { ...def };
  for (const k of QS_KEYS) {
    const v = sp.get(k);
    if (v && v.trim()) out[k] = v.trim();
  }
  return out;
}

function filtersToQueryString(f: FilterState): string {
  const def = DEFAULT_FILTERS();
  const sp = new URLSearchParams();
  for (const k of QS_KEYS) {
    if (f[k] && f[k] !== "ALL" && f[k] !== def[k]) sp.set(k, f[k]);
  }
  // luôn giữ from/to để bookmark ổn định
  sp.set("from", f.from);
  sp.set("to", f.to);
  return sp.toString();
}

function filtersToApiQuery(f: FilterState): string {
  const sp = new URLSearchParams();
  sp.set("from", f.from);
  sp.set("to", f.to);
  for (const k of QS_KEYS) {
    if (k === "from" || k === "to") continue;
    if (f[k] && f[k] !== "ALL") sp.set(k, f[k]);
  }
  return sp.toString();
}

export default function AnalyticsDashboard({ canExport }: { canExport: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [filters, setFilters] = React.useState<FilterState>(() => filtersFromSearchParams(new URLSearchParams(searchParams.toString())));
  const [data, setData] = React.useState<DashboardAnalytics | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);

  const apiQuery = filtersToApiQuery(filters);

  const load = React.useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/analytics/dashboard?${apiQuery}`, { signal: ctrl.signal });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Không thể tải dữ liệu phân tích.");
      setData(json as DashboardAnalytics);
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setError((e as Error).message);
    } finally {
      if (!ctrl.signal.aborted) setLoading(false);
    }
  }, [apiQuery]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Persist filter vào query string (replace — không spam history mỗi lần đổi filter).
  React.useEffect(() => {
    const qs = filtersToQueryString(filters);
    router.replace(`${pathname}?${qs}`, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  const patch = React.useCallback((p: Partial<FilterState>) => {
    setFilters((prev) => ({ ...prev, ...p }));
  }, []);

  const reset = React.useCallback(() => setFilters(DEFAULT_FILTERS()), []);

  const onDeptClick = React.useCallback(
    (deptId: string) => {
      setFilters((prev) => ({ ...prev, departmentId: deptId, section: "ALL", groupName: "ALL" }));
      if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
    },
    [],
  );

  const exportHref = (mode: "summary" | "detailed") => `/api/analytics/export?mode=${mode}&${apiQuery}`;

  return (
    <div className="space-y-4">
      <AnalyticsFilterBar meta={data?.meta ?? null} value={filters} onChange={patch} onReset={reset} />

      {/* Meta strip: range + scope + export */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-0.5">
        <p className="text-[12px] text-fg-muted" aria-live="polite">
          {data ? (
            <>
              Kỳ: <strong className="text-fg">{formatDate(data.range.from)} – {formatDate(data.range.to)}</strong> ({data.range.days} ngày) · So với:{" "}
              {formatDate(data.range.previousFrom)} – {formatDate(data.range.previousTo)}
              {data.scoped ? <span className="ml-2 rounded-full bg-info-tint px-2 py-0.5 text-[10.5px] font-bold text-info">Giới hạn theo Data Scope</span> : null}
            </>
          ) : (
            "Đang tải dữ liệu phân tích..."
          )}
        </p>
        {canExport ? (
          <div className="flex items-center gap-1.5">
            <a
              href={exportHref("summary")}
              className="inline-flex items-center gap-1.5 rounded-full border border-border-strong bg-surface-raised px-3 py-1.5 text-[11.5px] font-bold text-fg-secondary transition-colors hover:border-primary/40 hover:text-primary"
            >
              <Download className="h-3.5 w-3.5" aria-hidden /> Export tổng hợp
            </a>
            <a
              href={exportHref("detailed")}
              className="inline-flex items-center gap-1.5 rounded-full border border-border-strong bg-surface-raised px-3 py-1.5 text-[11.5px] font-bold text-fg-secondary transition-colors hover:border-primary/40 hover:text-primary"
            >
              <Download className="h-3.5 w-3.5" aria-hidden /> Export chi tiết
            </a>
          </div>
        ) : null}
      </div>

      {error ? (
        <div className="rounded-[16px] border border-border bg-surface">
          <ErrorState title="Không thể tải dữ liệu phân tích" description={error} onRetry={() => void load()} retrying={loading} />
        </div>
      ) : (
        <>
          {data?.outOfScope ? (
            <AnalyticsCard title="Ngoài phạm vi dữ liệu được phân quyền">
              <ChartEmpty message="Bộ lọc hiện tại nằm ngoài các bộ phận bạn được phân quyền xem (Data Scope). Không có số liệu nào được hiển thị." />
            </AnalyticsCard>
          ) : null}

          {/* Row 2: KPI strip */}
          <KpiStrip kpis={data?.kpis ?? null} loading={loading && !data} />

          {/* Row 3: Funnel | Trend */}
          <div className="grid gap-4 xl:grid-cols-5">
            <div className="xl:col-span-2">
              <RecruitmentFunnel funnel={data?.funnel ?? null} />
            </div>
            <div className="xl:col-span-3">
              <RecruitmentTrend trend={data?.trend ?? null} />
            </div>
          </div>

          {/* Row 4: Worker mix | Referral */}
          <div className="grid gap-4 lg:grid-cols-2">
            <WorkerMix mix={data?.workerMix ?? null} />
            <ReferralPerformance sources={data?.referralSources ?? null} />
          </div>

          {/* Row 5: Planning demand/supply */}
          <PlanningPerformance planning={data?.planning ?? null} granularity={data?.range.granularity ?? "DAY"} onDeptClick={onDeptClick} />

          {/* Row 6: Department performance */}
          <DepartmentPerformance rows={data?.departmentPerformance ?? null} onDeptClick={onDeptClick} />

          {/* Row 7: Demographics | Movements */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Demographics demographics={data?.demographics ?? null} />
            <WorkforceMovementsChart movements={data?.movements ?? null} granularity={data?.range.granularity ?? "DAY"} />
          </div>

          {/* Row 8: Returning workers | Data quality */}
          <div className="grid gap-4 lg:grid-cols-2">
            <ReturningWorkers data={data?.returningWorkers ?? null} />
            <DataQuality items={data?.dataQuality ?? null} />
          </div>
        </>
      )}
    </div>
  );
}
