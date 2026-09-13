"use client";

import { Button, Input, cn } from "@/components/ui";
import { buildDateRangePreset, type DateRange, type DateRangePreset } from "@/lib/date-range";

/**
 * GLOBAL OPERATIONAL DATE RANGE STANDARDIZATION — shared "Từ ngày / Đến
 * ngày" filter control. Pure UI: renders the two date inputs + quick presets
 * and reports the chosen range back to the caller — it never queries data
 * itself (mission section 23), so every screen stays in control of what a
 * range change actually does (reload rows, clear stale selection, sync the
 * URL, etc).
 *
 * Responsive: stacks label-above-input on narrow screens; sits inline on
 * desktop/tablet (mission section 9) — a plain flex-col that switches to
 * flex-row at `sm`, same breakpoint convention already used elsewhere in
 * this codebase's filter bars.
 */
export type DateRangeFilterProps = {
  value: DateRange;
  onChange: (range: DateRange) => void;
  className?: string;
  /** Hide the quick-preset buttons for screens that don't want them. */
  hidePresets?: boolean;
};

const PRESETS: { key: DateRangePreset; label: string }[] = [
  { key: "TODAY", label: "Hôm nay" },
  { key: "LAST_7_DAYS", label: "7 ngày gần nhất" },
  { key: "THIS_MONTH", label: "Tháng này" },
];

export function DateRangeFilter({ value, onChange, className, hidePresets }: DateRangeFilterProps) {
  return (
    <div className={cn("flex flex-col gap-2.5 sm:flex-row sm:flex-wrap sm:items-end", className)}>
      <div>
        <p className="mb-1 text-[11px] font-semibold text-fg-muted">Từ ngày</p>
        <Input
          type="date"
          value={value.from}
          max={value.to}
          onChange={(e) => e.target.value && onChange({ from: e.target.value, to: value.to })}
          className="h-10 w-full sm:w-40"
        />
      </div>
      <div>
        <p className="mb-1 text-[11px] font-semibold text-fg-muted">Đến ngày</p>
        <Input
          type="date"
          value={value.to}
          min={value.from}
          onChange={(e) => e.target.value && onChange({ from: value.from, to: e.target.value })}
          className="h-10 w-full sm:w-40"
        />
      </div>
      {hidePresets ? null : (
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((p) => (
            <Button key={p.key} type="button" variant="outline" size="sm" className="h-10" onClick={() => onChange(buildDateRangePreset(p.key))}>
              {p.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
