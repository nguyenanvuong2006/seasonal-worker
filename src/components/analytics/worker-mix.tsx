"use client";

import { AnalyticsCard, ChartEmpty, fmtNum, fmtPct, SERIES_COLORS } from "@/components/analytics/chart-primitives";
import type { DashboardAnalytics } from "@/lib/analytics-core";

/** NEW vs RETURNING — composition + unique workers / sessions (worker_profiles + employment_sessions). */
export default function WorkerMix({ mix }: { mix: DashboardAnalytics["workerMix"] | null }) {
  const empty = !mix || mix.uniqueWorkers === 0;
  const total = mix ? mix.newWorkers + mix.returningWorkers : 0;
  const newPct = total > 0 ? (mix!.newWorkers / total) * 100 : 0;

  return (
    <AnalyticsCard title="Người mới vs Người quay lại" subtitle="Phân loại theo đối chiếu DW Data (server-side)">
      {empty ? (
        <ChartEmpty message="Không có lao động nào trong kỳ đã chọn." />
      ) : (
        <>
          <div className="flex h-8 w-full overflow-hidden rounded-full" role="img" aria-label={`Người mới ${fmtNum(mix.newWorkers)}, người quay lại ${fmtNum(mix.returningWorkers)}`}>
            <div
              className="flex items-center justify-center text-[11px] font-bold text-white"
              style={{ width: `${Math.max(newPct, 4)}%`, backgroundColor: SERIES_COLORS.accent }}
              title={`Người mới: ${fmtNum(mix.newWorkers)}`}
            >
              {newPct >= 14 ? `Mới ${Math.round(newPct)}%` : ""}
            </div>
            <div
              className="flex flex-1 items-center justify-center text-[11px] font-bold text-white"
              style={{ backgroundColor: SERIES_COLORS.primary }}
              title={`Người quay lại: ${fmtNum(mix.returningWorkers)}`}
            >
              {100 - newPct >= 14 ? `Quay lại ${Math.round(100 - newPct)}%` : ""}
            </div>
          </div>

          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
            {[
              { label: "Người mới", value: fmtNum(mix.newWorkers) },
              { label: "Người quay lại", value: fmtNum(mix.returningWorkers) },
              { label: "Tỷ lệ quay lại", value: fmtPct(mix.returningRatePct) },
              { label: "Unique Workers", value: fmtNum(mix.uniqueWorkers) },
              { label: "Đợt làm việc (sessions)", value: fmtNum(mix.sessions) },
              { label: "Sessions / Worker", value: mix.sessionsPerWorker !== null ? mix.sessionsPerWorker.toLocaleString("vi-VN") : "—" },
            ].map((item) => (
              <div key={item.label}>
                <dt className="text-[11px] font-semibold text-fg-muted">{item.label}</dt>
                <dd className="mt-0.5 text-[18px] font-bold tabular-nums text-fg">{item.value}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </AnalyticsCard>
  );
}
