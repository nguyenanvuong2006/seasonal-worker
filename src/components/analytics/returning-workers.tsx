"use client";

import { AnalyticsCard, ChartEmpty, fmtNum, fmtPct, HBar, SERIES_COLORS } from "@/components/analytics/chart-primitives";
import type { DashboardAnalytics } from "@/lib/analytics-core";

/**
 * "Tỷ lệ lao động quay lại" — cố ý KHÔNG gọi là retention: dữ liệu hiện tại chỉ xác định
 * được người quay lại (DW match / số đợt làm việc), không đủ để đo retention theo thời gian.
 */
export default function ReturningWorkers({ data }: { data: DashboardAnalytics["returningWorkers"] | null }) {
  const empty = !data || data.distribution.every((d) => d.count === 0);
  const maxDist = data ? Math.max(1, ...data.distribution.map((d) => d.count)) : 1;

  return (
    <AnalyticsCard title="Lao động quay lại" subtitle="Theo worker_profiles + employment_sessions (số đợt làm việc trọn đời)">
      {empty ? (
        <ChartEmpty message="Không có dữ liệu lao động trong kỳ đã chọn." />
      ) : (
        <>
          <dl className="grid grid-cols-3 gap-x-4 gap-y-3">
            <div>
              <dt className="text-[11px] font-semibold text-fg-muted">Tỷ lệ lao động quay lại</dt>
              <dd className="mt-0.5 text-[20px] font-bold tabular-nums text-fg">{fmtPct(data.returningRatePct)}</dd>
            </div>
            <div>
              <dt className="text-[11px] font-semibold text-fg-muted">Sessions / Worker</dt>
              <dd className="mt-0.5 text-[20px] font-bold tabular-nums text-fg">
                {data.sessionsPerWorker !== null ? data.sessionsPerWorker.toLocaleString("vi-VN") : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] font-semibold text-fg-muted">TB đợt / người quay lại</dt>
              <dd className="mt-0.5 text-[20px] font-bold tabular-nums text-fg">
                {data.avgSessionsReturning !== null ? data.avgSessionsReturning.toLocaleString("vi-VN") : "—"}
              </dd>
            </div>
          </dl>

          <h4 className="mt-4 text-[12.5px] font-bold text-fg">Phân bố số đợt làm việc</h4>
          <div className="mt-2 space-y-2">
            {data.distribution.map((d) => (
              <HBar key={d.label} label={d.label} value={d.count} max={maxDist} color={SERIES_COLORS.primary} />
            ))}
          </div>

          {data.topReturningDepartments.length > 0 ? (
            <div className="mt-4">
              <h4 className="text-[12.5px] font-bold text-fg">Bộ phận có tỷ lệ quay lại cao nhất</h4>
              <ul className="mt-2 divide-y divide-border">
                {data.topReturningDepartments.map((d) => (
                  <li key={d.deptId} className="flex items-center justify-between gap-3 py-1.5 text-[12.5px]">
                    <span className="min-w-0 truncate font-semibold text-fg" title={d.groupName ? `${d.deptName} — ${d.groupName}` : d.deptName}>
                      {d.groupName ? `${d.deptName} — ${d.groupName}` : d.deptName}
                    </span>
                    <span className="shrink-0 tabular-nums text-fg-secondary">
                      {fmtNum(d.workers)} người · <span className="font-bold text-primary">{d.returningPct.toLocaleString("vi-VN")}%</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </AnalyticsCard>
  );
}
