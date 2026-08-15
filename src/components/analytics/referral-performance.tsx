"use client";

import * as React from "react";
import { cn } from "@/components/ui";
import { AnalyticsCard, ChartEmpty, fmtNum, fmtPct, HBar, SERIES_COLORS } from "@/components/analytics/chart-primitives";
import type { DashboardAnalytics, ReferralSourceRow } from "@/lib/analytics-core";

/** Referral Source Performance — sort mặc định Started DESC, đổi được cột sort. */

type SortKey = "applications" | "approved" | "started" | "conversionPct";

const SORTS: { key: SortKey; label: string }[] = [
  { key: "started", label: "Bắt đầu làm" },
  { key: "applications", label: "Đăng ký" },
  { key: "approved", label: "Đã nhận việc" },
  { key: "conversionPct", label: "Conversion" },
];

export default function ReferralPerformance({ sources }: { sources: DashboardAnalytics["referralSources"] | null }) {
  const [sort, setSort] = React.useState<SortKey>("started");
  const rows = React.useMemo(() => {
    const list = [...(sources ?? [])];
    list.sort((a, b) => {
      const av = a[sort] ?? -1;
      const bv = b[sort] ?? -1;
      return (bv as number) - (av as number);
    });
    return list;
  }, [sources, sort]);

  const max = Math.max(1, ...rows.map((r) => (sort === "conversionPct" ? r.conversionPct ?? 0 : (r[sort] as number))));

  const valueOf = (r: ReferralSourceRow) => (sort === "conversionPct" ? r.conversionPct ?? 0 : (r[sort] as number));
  const valueText = (r: ReferralSourceRow) => (sort === "conversionPct" ? fmtPct(r.conversionPct) : fmtNum(valueOf(r)));

  return (
    <AnalyticsCard
      title="Hiệu quả kênh giới thiệu"
      subtitle="Đăng ký · Đã nhận việc · Bắt đầu làm · Conversion (Đăng ký → Bắt đầu làm)"
      right={
        <div className="flex flex-wrap gap-1" role="group" aria-label="Sắp xếp theo">
          {SORTS.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setSort(s.key)}
              aria-pressed={sort === s.key}
              className={cn(
                "rounded-full px-2 py-0.5 text-[10.5px] font-bold transition-colors",
                sort === s.key ? "bg-primary text-white" : "bg-surface-hover text-fg-muted hover:text-fg-secondary",
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
      }
    >
      {rows.length === 0 ? (
        <ChartEmpty message="Không có dữ liệu kênh giới thiệu trong kỳ đã chọn." />
      ) : (
        <div className="space-y-2.5">
          {rows.slice(0, 10).map((r) => (
            <HBar
              key={r.source}
              label={r.source}
              sub={`ĐK ${fmtNum(r.applications)} · Nhận ${fmtNum(r.approved)} · Làm ${fmtNum(r.started)} · CV ${fmtPct(r.conversionPct)}`}
              value={valueOf(r)}
              max={max}
              color={SERIES_COLORS.primary}
              valueText={valueText(r)}
              title={`${r.source} — Đăng ký ${fmtNum(r.applications)}, Đã nhận việc ${fmtNum(r.approved)}, Bắt đầu làm ${fmtNum(r.started)}, Conversion ${fmtPct(r.conversionPct)}`}
            />
          ))}
        </div>
      )}
    </AnalyticsCard>
  );
}
