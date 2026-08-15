"use client";

import { AnalyticsCard, ChartEmpty, fmtNum, HBar, SERIES_COLORS } from "@/components/analytics/chart-primitives";
import type { DashboardAnalytics } from "@/lib/analytics-core";

/** Demographics — giới tính + nhóm tuổi (tuổi từ dữ liệu server, không tính lại theo TZ client). */
export default function Demographics({ demographics }: { demographics: DashboardAnalytics["demographics"] | null }) {
  const g = demographics?.gender;
  const total = g ? g.male + g.female + g.other : 0;
  const ages = demographics?.age ?? [];
  const maxAge = Math.max(1, ...ages.map((a) => a.count));

  return (
    <AnalyticsCard title="Giới tính & Độ tuổi" subtitle="Theo đơn đăng ký trong kỳ đã chọn">
      {total === 0 ? (
        <ChartEmpty message="Không có dữ liệu nhân khẩu học trong kỳ đã chọn." />
      ) : (
        <>
          <div
            className="flex h-7 w-full overflow-hidden rounded-full"
            role="img"
            aria-label={`Nam ${fmtNum(g!.male)}, Nữ ${fmtNum(g!.female)}, Khác/Không rõ ${fmtNum(g!.other)}`}
          >
            {g!.male > 0 ? (
              <div className="flex items-center justify-center text-[10.5px] font-bold text-white" style={{ width: `${(g!.male / total) * 100}%`, backgroundColor: SERIES_COLORS.primary }} title={`Nam: ${fmtNum(g!.male)}`}>
                {(g!.male / total) * 100 >= 12 ? "Nam" : ""}
              </div>
            ) : null}
            {g!.female > 0 ? (
              <div className="flex items-center justify-center text-[10.5px] font-bold text-white" style={{ width: `${(g!.female / total) * 100}%`, backgroundColor: SERIES_COLORS.accent }} title={`Nữ: ${fmtNum(g!.female)}`}>
                {(g!.female / total) * 100 >= 12 ? "Nữ" : ""}
              </div>
            ) : null}
            {g!.other > 0 ? (
              <div className="flex items-center justify-center text-[10.5px] font-bold text-white" style={{ width: `${(g!.other / total) * 100}%`, backgroundColor: SERIES_COLORS.muted }} title={`Khác/Không rõ: ${fmtNum(g!.other)}`} />
            ) : null}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] font-semibold text-fg-secondary">
            <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: SERIES_COLORS.primary }} aria-hidden />Nam {fmtNum(g!.male)}</span>
            <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: SERIES_COLORS.accent }} aria-hidden />Nữ {fmtNum(g!.female)}</span>
            {g!.other > 0 ? (
              <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: SERIES_COLORS.muted }} aria-hidden />Khác/Không rõ {fmtNum(g!.other)}</span>
            ) : null}
          </div>

          <h4 className="mt-4 text-[12.5px] font-bold text-fg">Nhóm tuổi</h4>
          <div className="mt-2 space-y-2">
            {ages.map((a) => (
              <HBar key={a.bucket} label={a.bucket} value={a.count} max={maxAge} color="#2a6120" />
            ))}
          </div>
        </>
      )}
    </AnalyticsCard>
  );
}
