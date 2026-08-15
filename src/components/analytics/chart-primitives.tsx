"use client";

import * as React from "react";
import { cn } from "@/components/ui";

/**
 * Chart primitives dùng CHUNG cho Analytics Dashboard — SVG/DIV thuần, không thêm
 * chart library mới (giữ bundle nhỏ + đúng visual language Dalat Hasfarm).
 * Mỗi chart có: title (ở component cha), tooltip (hover), empty state, aria label.
 */

export const SERIES_COLORS = {
  primary: "#0f4424",
  accent: "#e26d1c",
  gold: "#d9a327",
  info: "#2563eb",
  muted: "#8b917f",
  danger: "#b91c1c",
} as const;

export function fmtNum(v: number): string {
  return v.toLocaleString("vi-VN");
}

export function fmtPct(v: number | null): string {
  if (v === null) return "—";
  return `${v.toLocaleString("vi-VN")}%`;
}

/* ------------------------------- LINE CHART ------------------------------- */

export type LineSeries = { key: string; label: string; color: string; values: number[] };

export function LineChart({
  labels,
  series,
  height = 200,
  ariaLabel,
}: {
  labels: string[];
  series: LineSeries[];
  height?: number;
  ariaLabel: string;
}) {
  const [hover, setHover] = React.useState<number | null>(null);
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const W = 720;
  const H = height;
  const PAD_L = 40;
  const PAD_R = 12;
  const PAD_T = 12;
  const PAD_B = 26;

  const max = Math.max(1, ...series.flatMap((s) => s.values));
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;
  const nPoints = Math.max(1, labels.length);
  const x = (i: number) => PAD_L + (nPoints === 1 ? innerW / 2 : (i / (nPoints - 1)) * innerW);
  const y = (v: number) => PAD_T + innerH - (v / max) * innerH;

  const gridLines = 4;
  const tickEvery = Math.max(1, Math.ceil(nPoints / 8));

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < nPoints; i++) {
      const d = Math.abs(x(i) - px);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    setHover(best);
  };

  return (
    <div ref={wrapRef} className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={ariaLabel}
        className="w-full"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {Array.from({ length: gridLines + 1 }).map((_, i) => {
          const gy = PAD_T + (i / gridLines) * innerH;
          const val = Math.round(max * (1 - i / gridLines));
          return (
            <g key={i}>
              <line x1={PAD_L} x2={W - PAD_R} y1={gy} y2={gy} stroke="#e8e0ce" strokeWidth={1} />
              <text x={PAD_L - 6} y={gy + 3.5} textAnchor="end" fontSize={10} fill="#8b917f">
                {val >= 1000 ? `${Math.round(val / 100) / 10}k` : val}
              </text>
            </g>
          );
        })}
        {labels.map((l, i) =>
          i % tickEvery === 0 ? (
            <text key={i} x={x(i)} y={H - 8} textAnchor="middle" fontSize={10} fill="#8b917f">
              {l}
            </text>
          ) : null,
        )}
        {series.map((s) => (
          <polyline
            key={s.key}
            fill="none"
            stroke={s.color}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(" ")}
          />
        ))}
        {hover !== null ? (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={PAD_T} y2={PAD_T + innerH} stroke="#d2c8af" strokeWidth={1} strokeDasharray="3 3" />
            {series.map((s) => (
              <circle key={s.key} cx={x(hover)} cy={y(s.values[hover] ?? 0)} r={3.5} fill={s.color} stroke="#fff" strokeWidth={1.5} />
            ))}
          </g>
        ) : null}
      </svg>
      {hover !== null ? (
        <div
          className="pointer-events-none absolute top-1 z-10 rounded-[10px] border border-border bg-surface-raised px-3 py-2 text-[11.5px] shadow-md"
          style={{ left: `${Math.min(78, Math.max(2, (x(hover) / W) * 100))}%` }}
        >
          <p className="font-bold text-fg">{labels[hover]}</p>
          {series.map((s) => (
            <p key={s.key} className="mt-0.5 flex items-center gap-1.5 text-fg-secondary">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: s.color }} aria-hidden />
              {s.label}: <span className="font-bold tabular-nums text-fg">{fmtNum(s.values[hover] ?? 0)}</span>
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ChartLegend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {items.map((i) => (
        <span key={i.label} className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-fg-secondary">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: i.color }} aria-hidden />
          {i.label}
        </span>
      ))}
    </div>
  );
}

/* --------------------------- HORIZONTAL BAR ROW --------------------------- */

export function HBar({
  label,
  sub,
  value,
  max,
  color = SERIES_COLORS.primary,
  valueText,
  onClick,
  title,
}: {
  label: string;
  sub?: string;
  value: number;
  max: number;
  color?: string;
  valueText?: string;
  onClick?: () => void;
  title?: string;
}) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  const Comp: React.ElementType = onClick ? "button" : "div";
  return (
    <Comp
      onClick={onClick}
      title={title ?? `${label}: ${fmtNum(value)}`}
      className={cn(
        "block w-full text-left",
        onClick && "cursor-pointer rounded-[8px] px-1 py-0.5 transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30",
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-fg" title={label}>
          {label}
          {sub ? <span className="ml-1.5 font-normal text-fg-muted">{sub}</span> : null}
        </span>
        <span className="shrink-0 text-[12px] font-bold tabular-nums text-fg">{valueText ?? fmtNum(value)}</span>
      </div>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-surface-hover" role="presentation">
        <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
    </Comp>
  );
}

/* ------------------------------- DELTA BADGE ------------------------------- */

export function DeltaBadge({
  changePct,
  direction,
  goodWhen,
}: {
  changePct: number | null;
  direction: "up" | "down" | "flat";
  goodWhen: "up" | "down" | "neutral";
}) {
  if (changePct === null || direction === "flat") {
    return <span className="inline-flex items-center rounded-full bg-surface-hover px-2 py-0.5 text-[11px] font-bold text-fg-muted">—</span>;
  }
  const arrow = direction === "up" ? "↑" : "↓";
  let tone = "bg-surface-hover text-fg-secondary"; // neutral
  if (goodWhen !== "neutral") {
    const isGood = (direction === "up" && goodWhen === "up") || (direction === "down" && goodWhen === "down");
    tone = isGood ? "bg-success-tint text-success" : "bg-danger-tint text-danger";
  }
  return (
    <span className={cn("inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[11px] font-bold tabular-nums", tone)}>
      {arrow} {Math.abs(changePct).toLocaleString("vi-VN")}%
    </span>
  );
}

/* ------------------------------- EMPTY NOTE ------------------------------- */

export function ChartEmpty({ message }: { message: string }) {
  return (
    <div className="flex items-center justify-center rounded-[14px] border border-dashed border-border-strong bg-surface-hover/50 px-4 py-10 text-center text-[12.5px] text-fg-muted">
      {message}
    </div>
  );
}

/* ------------------------------ SECTION CARD ------------------------------ */

export function AnalyticsCard({
  title,
  subtitle,
  right,
  children,
  className,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-label={title}
      className={cn(
        "rounded-[16px] border border-border bg-surface p-4 shadow-[0_1px_2px_rgba(23,32,18,0.04),0_8px_24px_rgba(23,32,18,0.05)] md:p-5",
        className,
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-[14.5px] font-bold tracking-[-0.01em] text-fg">{title}</h3>
          {subtitle ? <p className="mt-0.5 text-[11.5px] text-fg-muted">{subtitle}</p> : null}
        </div>
        {right ? <div className="shrink-0">{right}</div> : null}
      </div>
      <div className="mt-3.5">{children}</div>
    </section>
  );
}
