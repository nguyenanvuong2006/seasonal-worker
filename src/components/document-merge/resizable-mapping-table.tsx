"use client";

import { useState } from "react";
import { CheckCircle2 } from "lucide-react";

type Mapping = {
  id: string;
  placeholder: string;
  sourceType: string;
  sourceEntity: string | null;
  sourceField: string | null;
  sourcePath: string | null;
  optionValue: string | null;
  formatType: string | null;
  fallbackValue: string | null;
  isRequired: boolean;
  isOrphaned: boolean;
  isSuggested: boolean;
};

type ColumnKey =
  | "sourceType"
  | "entity"
  | "field"
  | "path"
  | "formatter"
  | "option"
  | "required"
  | "status";

type ColumnWidths = Record<ColumnKey, number>;

const PLACEHOLDER_WIDTH = 280;
const MIN_COLUMN_WIDTH = 96;

const DEFAULT_WIDTHS: ColumnWidths = {
  sourceType: 180,
  entity: 170,
  field: 180,
  path: 260,
  formatter: 210,
  option: 140,
  required: 120,
  status: 130,
};

const COLUMN_LABELS: Array<{ key: ColumnKey; label: string }> = [
  { key: "sourceType", label: "Source Type" },
  { key: "entity", label: "Entity" },
  { key: "field", label: "Field" },
  { key: "path", label: "Path" },
  { key: "formatter", label: "Formatter" },
  { key: "option", label: "Option" },
  { key: "required", label: "Bắt buộc" },
  { key: "status", label: "Trạng thái" },
];

export function ResizableMappingTable({
  mappings,
  sourceTypes,
  formatTypes,
  updateMapping,
}: {
  mappings: Mapping[];
  sourceTypes: string[];
  formatTypes: string[];
  updateMapping: (id: string, patch: Partial<Mapping>) => void;
}) {
  const [columnWidths, setColumnWidths] = useState<ColumnWidths>(DEFAULT_WIDTHS);

  const resizeColumn = (key: ColumnKey, clientX: number, startWidth: number) => {
    setColumnWidths((current) => ({
      ...current,
      [key]: Math.max(MIN_COLUMN_WIDTH, startWidth + clientX),
    }));
  };

  const beginResize = (key: ColumnKey, event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = columnWidths[key];
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);

    const handleMove = (moveEvent: PointerEvent) => {
      resizeColumn(key, moveEvent.clientX - startX, startWidth);
    };

    const handleEnd = (endEvent: PointerEvent) => {
      target.releasePointerCapture(endEvent.pointerId);
      target.removeEventListener("pointermove", handleMove);
      target.removeEventListener("pointerup", handleEnd);
      target.removeEventListener("pointercancel", handleEnd);
    };

    target.addEventListener("pointermove", handleMove);
    target.addEventListener("pointerup", handleEnd);
    target.addEventListener("pointercancel", handleEnd);
  };

  const totalWidth =
    PLACEHOLDER_WIDTH + Object.values(columnWidths).reduce((sum, width) => sum + width, 0);

  const columnStyle = (key: ColumnKey) => ({
    width: columnWidths[key],
    minWidth: columnWidths[key],
    maxWidth: columnWidths[key],
  });

  return (
    <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200">
      <table className="table-fixed text-[11px]" style={{ width: totalWidth, minWidth: totalWidth }}>
        <colgroup>
          <col style={{ width: PLACEHOLDER_WIDTH }} />
          {COLUMN_LABELS.map(({ key }) => (
            <col key={key} style={{ width: columnWidths[key] }} />
          ))}
        </colgroup>
        <thead className="bg-slate-50 text-left text-slate-500">
          <tr>
            <th
              className="sticky left-0 z-30 border-r border-slate-200 bg-slate-50 p-2.5 shadow-[4px_0_8px_-6px_rgba(15,23,42,0.45)]"
              style={{ width: PLACEHOLDER_WIDTH, minWidth: PLACEHOLDER_WIDTH, maxWidth: PLACEHOLDER_WIDTH }}
            >
              Placeholder
            </th>
            {COLUMN_LABELS.map(({ key, label }) => (
              <th key={key} className="relative p-2.5" style={columnStyle(key)}>
                <span className="block truncate pr-2">{label}</span>
                <button
                  type="button"
                  aria-label={`Kéo để thay đổi độ rộng cột ${label}`}
                  title="Kéo để thay đổi độ rộng cột"
                  onPointerDown={(event) => beginResize(key, event)}
                  className="absolute -right-1 top-0 z-20 h-full w-3 cursor-col-resize touch-none select-none after:absolute after:left-1/2 after:top-1/4 after:h-1/2 after:w-px after:-translate-x-1/2 after:bg-slate-300 hover:after:bg-emerald-600"
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {mappings.map((row) => {
            const matched = Boolean(row.sourceField || row.sourcePath || row.fallbackValue);
            const stickyBackground = row.isOrphaned ? "bg-red-50" : "bg-white";

            return (
              <tr key={row.id} className={row.isOrphaned ? "bg-red-50/50" : "bg-white"}>
                <td
                  className={`sticky left-0 z-20 border-r border-slate-200 p-2.5 font-mono font-semibold text-emerald-800 shadow-[4px_0_8px_-6px_rgba(15,23,42,0.45)] ${stickyBackground}`}
                  style={{ width: PLACEHOLDER_WIDTH, minWidth: PLACEHOLDER_WIDTH, maxWidth: PLACEHOLDER_WIDTH }}
                  title={`<<${row.placeholder.replace(/^<<|>>$/g, "")}>>`}
                >
                  <span className="block truncate">{`<<${row.placeholder.replace(/^<<|>>$/g, "")}>>`}</span>
                </td>
                <td className="p-2" style={columnStyle("sourceType")}>
                  <select
                    value={row.sourceType}
                    onChange={(e) => updateMapping(row.id, { sourceType: e.target.value })}
                    className="w-full rounded border border-slate-200 bg-white px-2 py-1.5"
                  >
                    {sourceTypes.map((value) => <option key={value}>{value}</option>)}
                  </select>
                </td>
                <td className="p-2" style={columnStyle("entity")}>
                  <input
                    value={row.sourceEntity || ""}
                    onChange={(e) => updateMapping(row.id, { sourceEntity: e.target.value || null })}
                    className="w-full rounded border border-slate-200 px-2 py-1.5"
                  />
                </td>
                <td className="p-2" style={columnStyle("field")}>
                  <input
                    value={row.sourceField || ""}
                    onChange={(e) => updateMapping(row.id, { sourceField: e.target.value || null })}
                    className="w-full rounded border border-slate-200 px-2 py-1.5"
                  />
                </td>
                <td className="p-2" style={columnStyle("path")}>
                  <input
                    value={row.sourcePath || ""}
                    onChange={(e) => updateMapping(row.id, { sourcePath: e.target.value || null })}
                    className="w-full rounded border border-slate-200 px-2 py-1.5 font-mono"
                  />
                </td>
                <td className="p-2" style={columnStyle("formatter")}>
                  <select
                    value={row.formatType || "RAW"}
                    onChange={(e) => updateMapping(row.id, { formatType: e.target.value })}
                    className="w-full rounded border border-slate-200 bg-white px-2 py-1.5"
                  >
                    {formatTypes.map((value) => <option key={value}>{value}</option>)}
                  </select>
                </td>
                <td className="p-2" style={columnStyle("option")}>
                  <input
                    value={row.optionValue || ""}
                    onChange={(e) => updateMapping(row.id, { optionValue: e.target.value || null })}
                    className="w-full rounded border border-slate-200 px-2 py-1.5"
                  />
                </td>
                <td className="p-2 text-center" style={columnStyle("required")}>
                  <input
                    type="checkbox"
                    checked={row.isRequired}
                    onChange={(e) => updateMapping(row.id, { isRequired: e.target.checked })}
                  />
                </td>
                <td className="p-2.5" style={columnStyle("status")}>
                  {row.isOrphaned ? (
                    <span className="text-red-600">Orphaned</span>
                  ) : matched ? (
                    <span className="inline-flex items-center gap-1 text-emerald-700">
                      <CheckCircle2 className="h-3.5 w-3.5" /> Matched
                    </span>
                  ) : (
                    <span className="text-amber-700">Missing</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
