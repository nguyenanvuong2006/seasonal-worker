"use client";

import {
  CheckCircle2,
  ClipboardList,
  PlayCircle,
  Target,
  TrendingDown,
  UserPlus2,
  Users,
  RefreshCcw,
} from "lucide-react";
import { Skeleton } from "@/components/ui";
import { DeltaBadge, fmtNum } from "@/components/analytics/chart-primitives";
import type { DashboardAnalytics, KpiValue } from "@/lib/analytics-core";

/** 8 KPI cards — current + previous comparable period + % change + hướng tốt/xấu. */

const CARDS: {
  key: keyof DashboardAnalytics["kpis"];
  label: string;
  icon: React.ReactNode;
  tone: string;
  note?: string;
}[] = [
  { key: "applications", label: "Đăng ký", icon: <ClipboardList className="h-4 w-4" aria-hidden />, tone: "bg-primary-tint text-primary" },
  { key: "uniqueWorkers", label: "Unique Workers", icon: <Users className="h-4 w-4" aria-hidden />, tone: "bg-info-tint text-info" },
  { key: "newWorkers", label: "Người mới", icon: <UserPlus2 className="h-4 w-4" aria-hidden />, tone: "bg-accent-tint text-accent" },
  { key: "returningWorkers", label: "Người quay lại", icon: <RefreshCcw className="h-4 w-4" aria-hidden />, tone: "bg-success-tint text-success" },
  { key: "approved", label: "Đã nhận việc", icon: <CheckCircle2 className="h-4 w-4" aria-hidden />, tone: "bg-success-tint text-success" },
  { key: "started", label: "Bắt đầu làm", icon: <PlayCircle className="h-4 w-4" aria-hidden />, tone: "bg-primary-tint text-primary" },
  { key: "demand", label: "Nhu cầu tuyển", icon: <Target className="h-4 w-4" aria-hidden />, tone: "bg-info-tint text-info", note: "Planning ACTIVE" },
  { key: "shortage", label: "Còn thiếu", icon: <TrendingDown className="h-4 w-4" aria-hidden />, tone: "bg-warning-tint text-warning", note: "Planning ACTIVE" },
];

export default function KpiStrip({ kpis, loading }: { kpis: DashboardAnalytics["kpis"] | null; loading: boolean }) {
  if (loading || !kpis) {
    return (
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="rounded-[16px] border border-border bg-surface p-3.5">
            <Skeleton className="h-7 w-7 rounded-[8px]" />
            <Skeleton className="mt-3 h-7 w-14" />
            <Skeleton className="mt-2 h-3 w-20" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8" role="list" aria-label="Các chỉ số chính">
      {CARDS.map((c) => {
        const k: KpiValue = kpis[c.key];
        return (
          <div key={c.key} role="listitem" className="rounded-[16px] border border-border bg-surface p-3.5 shadow-[0_1px_2px_rgba(23,32,18,0.04)]">
            <div className="flex items-start justify-between gap-1">
              <div className={`flex h-7 w-7 items-center justify-center rounded-[8px] ring-1 ring-black/[0.03] ${c.tone}`}>{c.icon}</div>
              <DeltaBadge changePct={k.changePct} direction={k.direction} goodWhen={k.goodWhen} />
            </div>
            <p className="mt-2.5 text-[24px] font-bold leading-none tracking-tight tabular-nums text-fg">{fmtNum(k.current)}</p>
            <p className="mt-1.5 truncate text-[11.5px] font-semibold text-fg-secondary" title={c.label}>
              {c.label}
            </p>
            <p className="mt-0.5 text-[10.5px] text-fg-muted">
              {k.previous !== null ? `Kỳ trước: ${fmtNum(k.previous)}` : c.note ?? "Không so sánh kỳ trước"}
            </p>
          </div>
        );
      })}
    </div>
  );
}
