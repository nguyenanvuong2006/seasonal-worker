"use client";

import Link from "next/link";
import { AnalyticsCard, ChartEmpty, ChartLegend, fmtNum, LineChart, SERIES_COLORS } from "@/components/analytics/chart-primitives";
import { bucketLabel, type DashboardAnalytics, type Granularity } from "@/lib/analytics-core";

/**
 * Workforce Movements — phân biệt rõ:
 *   - "Yêu cầu tạo trong kỳ" (request created)
 *   - "Đã hiệu lực trong kỳ" (resignation INACTIVE / transfer TRANSFER_COMPLETED, theo effective_date)
 *   - "Đang chờ HR" (PENDING_HR hiện tại) — KHÔNG được đếm là đã nghỉ.
 */
export default function WorkforceMovementsChart({
  movements,
  granularity,
}: {
  movements: DashboardAnalytics["movements"] | null;
  granularity: Granularity;
}) {
  const m = movements;
  const hasTrend = m ? m.trend.some((t) => t.resignations > 0 || t.transfers > 0) : false;
  const hasAny = m
    ? m.effective.resignations + m.effective.transfersIn + m.effective.transfersOut + m.requested.resignations + m.requested.transfers > 0
    : false;

  return (
    <AnalyticsCard
      title="Biến động nhân lực"
      subtitle="Chỉ tính 'đã hiệu lực' khi HR duyệt xong (nghỉ việc INACTIVE / chuyển TRANSFER_COMPLETED)"
      right={
        m && m.pending.resignations + m.pending.transfers > 0 ? (
          <Link href="/admin/workforce-movements" className="rounded-full bg-warning-tint px-2.5 py-1 text-[11px] font-bold text-warning hover:underline">
            {fmtNum(m.pending.resignations + m.pending.transfers)} yêu cầu chờ HR →
          </Link>
        ) : null
      }
    >
      {!m || !hasAny ? (
        <ChartEmpty message="Không có biến động nhân lực nào trong kỳ đã chọn." />
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-5">
            {[
              { label: "Nghỉ việc (hiệu lực)", value: m.effective.resignations },
              { label: "Chuyển đi (hiệu lực)", value: m.effective.transfersOut },
              { label: "Chuyển đến (hiệu lực)", value: m.effective.transfersIn },
              { label: "Yêu cầu nghỉ tạo trong kỳ", value: m.requested.resignations },
              { label: "Yêu cầu chuyển tạo trong kỳ", value: m.requested.transfers },
            ].map((i) => (
              <div key={i.label}>
                <dt className="text-[11px] font-semibold text-fg-muted">{i.label}</dt>
                <dd className="mt-0.5 text-[18px] font-bold tabular-nums text-fg">{fmtNum(i.value)}</dd>
              </div>
            ))}
          </dl>

          {hasTrend ? (
            <div className="mt-4">
              <LineChart
                ariaLabel="Biểu đồ biến động nhân lực đã hiệu lực theo thời gian"
                height={160}
                labels={m.trend.map((t) => bucketLabel(t.date, granularity))}
                series={[
                  { key: "res", label: "Nghỉ việc", color: SERIES_COLORS.accent, values: m.trend.map((t) => t.resignations) },
                  { key: "tr", label: "Thuyên chuyển", color: SERIES_COLORS.info, values: m.trend.map((t) => t.transfers) },
                ]}
              />
              <div className="mt-1.5">
                <ChartLegend
                  items={[
                    { label: "Nghỉ việc (hiệu lực)", color: SERIES_COLORS.accent },
                    { label: "Thuyên chuyển (hiệu lực)", color: SERIES_COLORS.info },
                  ]}
                />
              </div>
            </div>
          ) : null}

          {m.topDepartments.length > 0 ? (
            <div className="mt-4">
              <h4 className="text-[12.5px] font-bold text-fg">Bộ phận biến động nhiều nhất</h4>
              <ul className="mt-2 divide-y divide-border">
                {m.topDepartments.slice(0, 5).map((d) => (
                  <li key={d.deptId} className="flex items-center justify-between gap-3 py-1.5 text-[12.5px]">
                    <span className="min-w-0 truncate font-semibold text-fg" title={d.groupName ? `${d.deptName} — ${d.groupName}` : d.deptName}>
                      {d.groupName ? `${d.deptName} — ${d.groupName}` : d.deptName}
                    </span>
                    <span className="shrink-0 tabular-nums text-fg-secondary">
                      Nghỉ {fmtNum(d.resignations)} · Đi {fmtNum(d.transfersOut)} · Đến {fmtNum(d.transfersIn)}
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
