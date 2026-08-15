"use client";

import * as React from "react";
import { RotateCcw } from "lucide-react";
import { FilterSelect, cn } from "@/components/ui";
import { addDays, UNKNOWN_REFERRAL, UNKNOWN_REFERRAL_LABEL, type AnalyticsMeta } from "@/lib/analytics-core";
import { todayStr } from "@/lib/helpers";

/**
 * Global filter bar (sticky) — mọi widget Analytics dùng CHUNG bộ filter này.
 * State được cha (analytics-dashboard) giữ và persist vào query string.
 * Hierarchy: Location → Division → Department → Section → Group — option cấp dưới
 * được thu hẹp theo cấp trên, và CHỈ hiển thị department trong Data Scope
 * (meta.departments do server trả về đã lọc theo scope).
 */

export type FilterState = {
  from: string;
  to: string;
  location: string;
  division: string;
  departmentId: string;
  section: string;
  groupName: string;
  workerType: string;
  gender: string;
  referralChannel: string;
  status: string;
};

export const DEFAULT_FILTERS = (): FilterState => {
  const today = todayStr();
  return {
    from: addDays(today, -29),
    to: today,
    location: "ALL",
    division: "ALL",
    departmentId: "ALL",
    section: "ALL",
    groupName: "ALL",
    workerType: "ALL",
    gender: "ALL",
    referralChannel: "ALL",
    status: "ALL",
  };
};

type PresetKey = "today" | "7d" | "30d" | "month" | "quarter" | "year" | "custom";

const PRESETS: { key: PresetKey; label: string }[] = [
  { key: "today", label: "Hôm nay" },
  { key: "7d", label: "7 ngày" },
  { key: "30d", label: "30 ngày" },
  { key: "month", label: "Tháng này" },
  { key: "quarter", label: "Quý này" },
  { key: "year", label: "Năm nay" },
  { key: "custom", label: "Tùy chọn" },
];

export function presetRange(key: PresetKey): { from: string; to: string } | null {
  const today = todayStr();
  const [y, m] = today.split("-").map(Number);
  switch (key) {
    case "today":
      return { from: today, to: today };
    case "7d":
      return { from: addDays(today, -6), to: today };
    case "30d":
      return { from: addDays(today, -29), to: today };
    case "month":
      return { from: `${today.slice(0, 8)}01`, to: today };
    case "quarter": {
      const qStartMonth = Math.floor((m - 1) / 3) * 3 + 1;
      return { from: `${y}-${String(qStartMonth).padStart(2, "0")}-01`, to: today };
    }
    case "year":
      return { from: `${y}-01-01`, to: today };
    default:
      return null;
  }
}

function detectPreset(from: string, to: string): PresetKey {
  for (const p of PRESETS) {
    if (p.key === "custom") continue;
    const r = presetRange(p.key);
    if (r && r.from === from && r.to === to) return p.key;
  }
  return "custom";
}

export default function AnalyticsFilterBar({
  meta,
  value,
  onChange,
  onReset,
}: {
  meta: AnalyticsMeta | null;
  value: FilterState;
  onChange: (patch: Partial<FilterState>) => void;
  onReset: () => void;
}) {
  const depts = meta?.departments ?? [];
  const eqi = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

  // Hierarchy cascade: option cấp dưới thu hẹp theo cấp trên.
  const inLocation = value.location === "ALL" ? depts : depts.filter((d) => eqi(d.location, value.location));
  const inDivision = value.division === "ALL" ? inLocation : inLocation.filter((d) => eqi(d.division, value.division));
  const deptOptions = inDivision;
  const chosenDept = value.departmentId === "ALL" ? null : depts.find((d) => d.id === value.departmentId) ?? null;
  const inDept = chosenDept ? [chosenDept] : deptOptions;
  const sectionOptions = [...new Set(inDept.map((d) => d.section).filter(Boolean))].sort((a, b) => a.localeCompare(b, "vi"));
  const inSection = value.section === "ALL" ? inDept : inDept.filter((d) => eqi(d.section, value.section));
  const groupOptions = [...new Set(inSection.map((d) => d.groupName).filter(Boolean))].sort((a, b) => a.localeCompare(b, "vi"));

  const preset = detectPreset(value.from, value.to);

  const opt = (vals: string[], allLabel: string) => [
    { value: "ALL", label: allLabel },
    ...vals.map((v) => ({ value: v, label: v })),
  ];

  return (
    <div className="sticky top-0 z-30 -mx-1 rounded-[16px] border border-border bg-surface/95 p-3 shadow-[0_4px_16px_rgba(23,32,18,0.06)] backdrop-blur md:p-4">
      {/* Date presets */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Chọn nhanh khoảng thời gian">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => {
                const r = presetRange(p.key);
                if (r) onChange({ from: r.from, to: r.to });
              }}
              className={cn(
                "rounded-full px-2.5 py-1 text-[11.5px] font-bold transition-colors",
                preset === p.key
                  ? "bg-primary text-white"
                  : "bg-surface-hover text-fg-secondary hover:bg-primary-tint hover:text-primary",
                p.key === "custom" && "pointer-events-none",
              )}
              aria-pressed={preset === p.key}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <label className="sr-only" htmlFor="af-from">Từ ngày</label>
          <input
            id="af-from"
            type="date"
            value={value.from}
            max={value.to}
            onChange={(e) => e.target.value && onChange({ from: e.target.value })}
            className="h-9 rounded-[9px] border border-border-strong bg-surface-raised px-2 text-[12.5px] font-medium text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent/15"
          />
          <span className="text-[12px] text-fg-muted">→</span>
          <label className="sr-only" htmlFor="af-to">Đến ngày</label>
          <input
            id="af-to"
            type="date"
            value={value.to}
            min={value.from}
            onChange={(e) => e.target.value && onChange({ to: e.target.value })}
            className="h-9 rounded-[9px] border border-border-strong bg-surface-raised px-2 text-[12.5px] font-medium text-fg outline-none focus:border-accent focus:ring-2 focus:ring-accent/15"
          />
        </div>
        <button
          type="button"
          onClick={onReset}
          className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-border-strong bg-surface-raised px-3 py-1.5 text-[11.5px] font-bold text-fg-secondary transition-colors hover:border-accent/40 hover:text-accent"
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Đặt lại bộ lọc
        </button>
      </div>

      {/* Dimension filters */}
      <div className="mt-2.5 grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-9">
        <FilterSelect
          value={value.location}
          onChange={(v) => onChange({ location: v, division: "ALL", departmentId: "ALL", section: "ALL", groupName: "ALL" })}
          options={opt(meta?.locations ?? [], "Location: Tất cả")}
        />
        <FilterSelect
          value={value.division}
          onChange={(v) => onChange({ division: v, departmentId: "ALL", section: "ALL", groupName: "ALL" })}
          options={opt([...new Set(inLocation.map((d) => d.division).filter(Boolean))].sort((a, b) => a.localeCompare(b, "vi")), "Division: Tất cả")}
        />
        <FilterSelect
          value={value.departmentId}
          onChange={(v) => onChange({ departmentId: v, section: "ALL", groupName: "ALL" })}
          options={[
            { value: "ALL", label: "Bộ phận: Tất cả" },
            ...deptOptions.map((d) => ({ value: d.id, label: d.groupName ? `${d.deptName} — ${d.groupName}` : d.deptName })),
          ]}
        />
        <FilterSelect
          value={value.section}
          onChange={(v) => onChange({ section: v, groupName: "ALL" })}
          options={opt(sectionOptions, "Section: Tất cả")}
        />
        <FilterSelect
          value={value.groupName}
          onChange={(v) => onChange({ groupName: v })}
          options={opt(groupOptions, "Group: Tất cả")}
        />
        <FilterSelect
          value={value.workerType}
          onChange={(v) => onChange({ workerType: v })}
          options={[
            { value: "ALL", label: "Lao động: Tất cả" },
            { value: "NEW", label: "Người mới" },
            { value: "RETURNING", label: "Người quay lại" },
          ]}
        />
        <FilterSelect
          value={value.gender}
          onChange={(v) => onChange({ gender: v })}
          options={[
            { value: "ALL", label: "Giới tính: Tất cả" },
            { value: "MALE", label: "Nam" },
            { value: "FEMALE", label: "Nữ" },
            { value: "OTHER", label: "Khác / Không rõ" },
          ]}
        />
        <FilterSelect
          value={value.referralChannel}
          onChange={(v) => onChange({ referralChannel: v })}
          options={[
            { value: "ALL", label: "Kênh GT: Tất cả" },
            { value: UNKNOWN_REFERRAL, label: UNKNOWN_REFERRAL_LABEL },
            ...(meta?.referralChannels ?? []).map((c) => ({ value: c, label: c })),
          ]}
        />
        <FilterSelect
          value={value.status}
          onChange={(v) => onChange({ status: v })}
          options={[
            { value: "ALL", label: "Trạng thái: Tất cả" },
            ...(meta?.statuses ?? []).map((s) => ({ value: s.key, label: s.label })),
          ]}
        />
      </div>
    </div>
  );
}
