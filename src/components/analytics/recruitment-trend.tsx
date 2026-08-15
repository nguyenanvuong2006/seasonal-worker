"use client";

import * as React from "react";
import { cn } from "@/components/ui";
import { AnalyticsCard, ChartEmpty, ChartLegend, LineChart, SERIES_COLORS } from "@/components/analytics/chart-primitives";
import { bucketLabel, type DashboardAnalytics } from "@/lib/analytics-core";

/** Recruitment Trend — line chart theo thời gian, granularity server quyết định (DAY/WEEK/MONTH). */

const ALL_SERIES = [
  { key: "applications", label: "Đăng ký", color: SERIES_COLORS.primary },
  { key: "approved", label: "Đã nhận việc", color: SERIES_COLORS.gold },
  { key: "started", label: "Bắt đầu làm", color: SERIES_COLORS.accent },
  { key: "newCount", label: "Người mới", color: SERIES_COLORS.info },
  { key: "returningCount", label: "Quay lại", color: SERIES_COLORS.muted },
] as const;

const GRAN_LABEL: Record<string, string> = { DAY: "theo ngày", WEEK: "theo tuần", MONTH: "theo tháng" };

export default function RecruitmentTrend({ trend }: { trend: DashboardAnalytics["trend"] | null }) {
  const [enabled, setEnabled] = React.useState<Record<string, boolean>>({
    applications: true,
    approved: true,
    started: true,
    newCount: false,
    returningCount: false,
  });

  const buckets = trend?.buckets ?? [];
  const hasData = buckets.some((b) => b.applications > 0 || b.approved > 0 || b.started > 0);
  const activeSeries = ALL_SERIES.filter((s) => enabled[s.key]);

  return (
    <AnalyticsCard
      title="Xu hướng tuyển dụng"
      subtitle={trend ? `Tổng hợp ${GRAN_LABEL[trend.granularity] ?? ""}` : undefined}
      right={
        <div className="flex flex-wrap gap-1" role="group" aria-label="Bật/tắt chuỗi dữ liệu">
          {ALL_SERIES.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setEnabled((prev) => ({ ...prev, [s.key]: !prev[s.key] }))}
              aria-pressed={enabled[s.key]}
              className={cn(
                "rounded-full px-2 py-0.5 text-[10.5px] font-bold transition-colors",
                enabled[s.key] ? "text-white" : "bg-surface-hover text-fg-muted hover:text-fg-secondary",
              )}
              style={enabled[s.key] ? { backgroundColor: s.color } : undefined}
            >
              {s.label}
            </button>
          ))}
        </div>
      }
    >
      {!trend || !hasData ? (
        <ChartEmpty message="Không có dữ liệu tuyển dụng trong kỳ đã chọn." />
      ) : (
        <>
          <LineChart
            ariaLabel="Biểu đồ xu hướng tuyển dụng theo thời gian"
            labels={buckets.map((b) => bucketLabel(b.date, trend.granularity))}
            series={activeSeries.map((s) => ({
              key: s.key,
              label: s.label,
              color: s.color,
              values: buckets.map((b) => b[s.key as keyof typeof b] as number),
            }))}
          />
          <div className="mt-2">
            <ChartLegend items={activeSeries.map((s) => ({ label: s.label, color: s.color }))} />
          </div>
        </>
      )}
    </AnalyticsCard>
  );
}
