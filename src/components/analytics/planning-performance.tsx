"use client";

import Link from "next/link";
import { ProgressBar } from "@/components/ui";
import {
  AnalyticsCard,
  ChartEmpty,
  ChartLegend,
  fmtNum,
  HBar,
  LineChart,
  SERIES_COLORS,
} from "@/components/analytics/chart-primitives";
import { bucketLabel, type DashboardAnalytics, type Granularity } from "@/lib/analytics-core";

/**
 * Planning / Workforce Demand — số liệu từ planning engine hiện có
 * (batchComputePlanningMetrics — không duplicate công thức), chỉ kỳ ACTIVE
 * không bị supersede. Kèm Supply vs Demand trend (demand = point-in-time,
 * không cộng dồn theo ngày — xem chú thích công thức trong lib/analytics.ts).
 */
export default function PlanningPerformance({
  planning,
  granularity,
  onDeptClick,
}: {
  planning: DashboardAnalytics["planning"] | null;
  granularity: Granularity;
  onDeptClick: (deptId: string) => void;
}) {
  if (!planning) {
    return (
      <AnalyticsCard title="Nhu cầu nhân lực (Planning)" subtitle="Theo kế hoạch ACTIVE giao với kỳ đã chọn">
        <ChartEmpty message="Không có kế hoạch nhu cầu (Planning) nào đang ACTIVE trong kỳ đã chọn." />
        <p className="mt-2 text-center text-[12px]">
          <Link href="/admin/planning" className="font-bold text-primary hover:underline">
            Mở Planning để tạo kế hoạch →
          </Link>
        </p>
      </AnalyticsCard>
    );
  }

  const maxGap = Math.max(1, ...planning.departments.map((d) => d.gap));
  const shortages = planning.departments.filter((d) => d.gap > 0);

  return (
    <AnalyticsCard
      title="Nhu cầu nhân lực (Planning)"
      subtitle={`${planning.activePeriods} kế hoạch ACTIVE giao với kỳ đã chọn`}
      right={
        <span className="rounded-full bg-primary-tint px-2.5 py-1 text-[11px] font-bold text-primary">
          Fill rate: {planning.fillRatePct}%
        </span>
      }
    >
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-5">
        {[
          { label: "Demand", value: planning.demand },
          { label: "Allocated", value: planning.allocated },
          { label: "Resigned", value: planning.resigned },
          { label: "Cần tuyển", value: planning.recruitmentNeeded },
        ].map((i) => (
          <div key={i.label}>
            <dt className="text-[11px] font-semibold text-fg-muted">{i.label}</dt>
            <dd className="mt-0.5 text-[18px] font-bold tabular-nums text-fg">{fmtNum(i.value)}</dd>
          </div>
        ))}
        <div>
          <dt className="text-[11px] font-semibold text-fg-muted">Fill Rate</dt>
          <dd className="mt-1.5">
            <ProgressBar value={planning.fillRatePct} tone={planning.fillRatePct >= 100 ? "success" : "accent"} className="h-2" />
            <span className="mt-0.5 block text-[11.5px] font-bold tabular-nums text-fg">{planning.fillRatePct}%</span>
          </dd>
        </div>
      </dl>

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        {/* Shortage ranking */}
        <div>
          <h4 className="text-[12.5px] font-bold text-fg">Thiếu hụt theo bộ phận (Gap giảm dần)</h4>
          {shortages.length === 0 ? (
            <p className="mt-3 rounded-[12px] bg-success-tint/60 px-3 py-3 text-[12px] font-medium text-success">
              Tất cả bộ phận trong kỳ đã đủ người theo kế hoạch.
            </p>
          ) : (
            <div className="mt-3 space-y-2.5">
              {shortages.slice(0, 8).map((d) => (
                <HBar
                  key={d.deptId}
                  label={d.groupName ? `${d.deptName} — ${d.groupName}` : d.deptName}
                  sub={`Demand ${fmtNum(d.demand)} · Allocated ${fmtNum(d.allocated)} · Fill ${d.fillRatePct}%`}
                  value={d.gap}
                  max={maxGap}
                  color={SERIES_COLORS.accent}
                  valueText={`thiếu ${fmtNum(d.gap)}`}
                  onClick={() => onDeptClick(d.deptId)}
                  title={`Lọc dashboard theo ${d.deptName}`}
                />
              ))}
            </div>
          )}
        </div>

        {/* Supply vs demand trend */}
        <div>
          <h4 className="text-[12.5px] font-bold text-fg">Supply vs Demand theo thời gian</h4>
          {planning.supplyDemand.length === 0 ? (
            <ChartEmpty message="Không có dữ liệu trong kỳ." />
          ) : (
            <>
              <LineChart
                ariaLabel="Biểu đồ Demand, Allocated và Started theo thời gian"
                height={180}
                labels={planning.supplyDemand.map((p) => bucketLabel(p.date, granularity))}
                series={[
                  { key: "demand", label: "Demand (kế hoạch hiệu lực)", color: SERIES_COLORS.info, values: planning.supplyDemand.map((p) => p.demand) },
                  { key: "allocated", label: "Allocated (luỹ kế)", color: SERIES_COLORS.primary, values: planning.supplyDemand.map((p) => p.allocated) },
                  { key: "started", label: "Bắt đầu làm (luỹ kế)", color: SERIES_COLORS.accent, values: planning.supplyDemand.map((p) => p.started) },
                ]}
              />
              <div className="mt-1.5">
                <ChartLegend
                  items={[
                    { label: "Demand (point-in-time)", color: SERIES_COLORS.info },
                    { label: "Allocated (luỹ kế)", color: SERIES_COLORS.primary },
                    { label: "Started (luỹ kế)", color: SERIES_COLORS.accent },
                  ]}
                />
              </div>
            </>
          )}
        </div>
      </div>
    </AnalyticsCard>
  );
}
