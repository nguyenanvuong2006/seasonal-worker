"use client";

import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { AnalyticsCard, fmtNum } from "@/components/analytics/chart-primitives";
import type { DashboardAnalytics } from "@/lib/analytics-core";

/** Data Quality panel — read-only; bấm vào metric mở màn hình danh sách tương ứng (nếu có). */
export default function DataQuality({ items }: { items: DashboardAnalytics["dataQuality"] | null }) {
  const list = items ?? [];
  const issues = list.filter((i) => i.count > 0);

  return (
    <AnalyticsCard title="Chất lượng dữ liệu" subtitle="Chỉ đọc — xử lý dữ liệu tại màn hình nghiệp vụ tương ứng">
      {issues.length === 0 ? (
        <div className="flex items-center gap-2.5 rounded-[12px] bg-success-tint/60 px-3.5 py-3 text-[12.5px] font-medium text-success">
          <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden />
          Không phát hiện vấn đề chất lượng dữ liệu trong kỳ đã chọn.
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {list.map((i) => {
            const row = (
              <div className="flex items-center justify-between gap-3 py-2">
                <span className={`min-w-0 truncate text-[12.5px] font-medium ${i.count > 0 ? "text-fg" : "text-fg-muted"}`} title={i.label}>
                  {i.label}
                </span>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[11.5px] font-bold tabular-nums ${
                    i.count > 0 ? "bg-warning-tint text-warning" : "bg-surface-hover text-fg-muted"
                  }`}
                >
                  {fmtNum(i.count)}
                </span>
              </div>
            );
            return (
              <li key={i.key}>
                {i.href && i.count > 0 ? (
                  <Link href={i.href} className="block transition-colors hover:bg-surface-hover" title="Mở danh sách đã lọc tương ứng">
                    {row}
                  </Link>
                ) : (
                  row
                )}
              </li>
            );
          })}
        </ul>
      )}
    </AnalyticsCard>
  );
}
