"use client";

import * as React from "react";
import { cn } from "@/components/ui";
import { AnalyticsCard, ChartEmpty, fmtNum, HBar, SERIES_COLORS } from "@/components/analytics/chart-primitives";
import type { DashboardAnalytics, DeptPerformanceRow } from "@/lib/analytics-core";

/** Department Performance — horizontal bar, metric selector, click = apply global filter. */

type MetricKey = "registered" | "approved" | "started" | "currentWorkforce" | "shortage";

const METRICS: { key: MetricKey; label: string; color: string }[] = [
  { key: "started", label: "Bắt đầu làm", color: SERIES_COLORS.primary },
  { key: "registered", label: "Đăng ký", color: SERIES_COLORS.info },
  { key: "approved", label: "Đã nhận việc", color: SERIES_COLORS.gold },
  { key: "currentWorkforce", label: "Đang làm việc", color: "#2a6120" },
  { key: "shortage", label: "Còn thiếu", color: SERIES_COLORS.accent },
];

export default function DepartmentPerformance({
  rows,
  onDeptClick,
}: {
  rows: DashboardAnalytics["departmentPerformance"] | null;
  onDeptClick: (deptId: string) => void;
}) {
  const [metric, setMetric] = React.useState<MetricKey>("started");
  const conf = METRICS.find((m) => m.key === metric)!;

  const sorted = React.useMemo(() => {
    const list = [...(rows ?? [])];
    list.sort((a, b) => (b[metric] as number) - (a[metric] as number));
    return list.filter((r) => (r[metric] as number) > 0 || metric === "started").slice(0, 15);
  }, [rows, metric]);

  const max = Math.max(1, ...sorted.map((r) => r[metric] as number));

  const label = (d: DeptPerformanceRow) => {
    const parts = [d.deptName];
    if (d.groupName) parts.push(d.groupName);
    return parts.join(" — ");
  };

  return (
    <AnalyticsCard
      title="Hiệu suất theo bộ phận"
      subtitle="Bấm vào một bộ phận để lọc toàn bộ Dashboard theo bộ phận đó"
      right={
        <div className="flex flex-wrap gap-1" role="group" aria-label="Chọn chỉ số">
          {METRICS.map((m) => (
            <button
              key={m.key}
              type="button"
              onClick={() => setMetric(m.key)}
              aria-pressed={metric === m.key}
              className={cn(
                "rounded-full px-2 py-0.5 text-[10.5px] font-bold transition-colors",
                metric === m.key ? "bg-primary text-white" : "bg-surface-hover text-fg-muted hover:text-fg-secondary",
              )}
            >
              {m.label}
            </button>
          ))}
        </div>
      }
    >
      {sorted.length === 0 ? (
        <ChartEmpty message="Không có dữ liệu bộ phận nào khớp bộ lọc trong kỳ đã chọn." />
      ) : (
        <div className="grid gap-x-8 gap-y-2.5 lg:grid-cols-2">
          {sorted.map((d) => (
            <HBar
              key={d.id}
              label={label(d)}
              sub={[d.location, d.division].filter(Boolean).join(" · ") || undefined}
              value={d[metric] as number}
              max={max}
              color={conf.color}
              onClick={() => onDeptClick(d.id)}
              title={`${label(d)} — Đăng ký ${fmtNum(d.registered)}, Nhận việc ${fmtNum(d.approved)}, Bắt đầu ${fmtNum(d.started)}, Đang làm ${fmtNum(d.currentWorkforce)}, Thiếu ${fmtNum(d.shortage)}. Bấm để lọc.`}
            />
          ))}
        </div>
      )}
    </AnalyticsCard>
  );
}
