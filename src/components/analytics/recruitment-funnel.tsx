"use client";

import { AnalyticsCard, ChartEmpty, fmtNum, fmtPct, SERIES_COLORS } from "@/components/analytics/chart-primitives";
import type { DashboardAnalytics } from "@/lib/analytics-core";

/** Recruitment Funnel: Đăng ký → Đã xử lý → Đã nhận việc → Bắt đầu làm (+ conversion từng bước). */
export default function RecruitmentFunnel({ funnel }: { funnel: DashboardAnalytics["funnel"] | null }) {
  const empty = !funnel || funnel.stages.length === 0 || funnel.stages[0].count === 0;
  const colors = [SERIES_COLORS.primary, "#2a6120", SERIES_COLORS.gold, SERIES_COLORS.accent];

  return (
    <AnalyticsCard
      title="Recruitment Funnel"
      subtitle="Đăng ký → Đã xử lý → Đã nhận việc → Bắt đầu làm"
      right={
        funnel && funnel.overallConversionPct !== null ? (
          <span className="rounded-full bg-primary-tint px-2.5 py-1 text-[11px] font-bold text-primary">
            Tổng conversion: {fmtPct(funnel.overallConversionPct)}
          </span>
        ) : null
      }
    >
      {empty ? (
        <ChartEmpty message="Không có đơn đăng ký nào trong kỳ đã chọn." />
      ) : (
        <div className="space-y-1">
          {funnel.stages.map((s, i) => {
            const max = funnel.stages[0].count || 1;
            const pct = Math.max(2, (s.count / max) * 100);
            return (
              <div key={s.key}>
                {i > 0 ? (
                  <p className="my-1 pl-1 text-[10.5px] font-semibold text-fg-muted" aria-label={`Chuyển đổi từ ${funnel.stages[i - 1].label} sang ${s.label}`}>
                    ↓ {fmtPct(funnel.conversions[i - 1] ?? null)}
                  </p>
                ) : null}
                <div className="flex items-center gap-3">
                  <div className="h-9 flex-1 overflow-hidden rounded-[9px] bg-surface-hover">
                    <div
                      className="flex h-full items-center rounded-[9px] px-3 transition-[width] duration-300"
                      style={{ width: `${pct}%`, backgroundColor: colors[i] ?? SERIES_COLORS.primary }}
                    >
                      <span className="truncate text-[12px] font-bold text-white">{s.label}</span>
                    </div>
                  </div>
                  <span className="w-16 shrink-0 text-right text-[14px] font-bold tabular-nums text-fg">{fmtNum(s.count)}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </AnalyticsCard>
  );
}
