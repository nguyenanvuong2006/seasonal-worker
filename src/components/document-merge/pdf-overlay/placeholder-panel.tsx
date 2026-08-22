"use client";
/**
 * PDF Overlay — Placeholder Panel (PR3).
 * Danh sách placeholder (mapping active của template — KHÔNG rewrite GOOGLE_DOCS).
 * Cung cấp: tìm kiếm, tên field, source key, type đề xuất, required, mapped/unmapped.
 * Kéo thả chip xuống viewer (HTML5 drag) hoặc bấm "+" để thêm vào trang hiện tại.
 * Cùng placeholder có thể map nhiều vị trí / nhiều trang.
 */

import { useMemo, useState } from "react";
import { Plus, Search } from "lucide-react";
import { inferPositionType, fieldSourceKey } from "@/lib/document-merge/pdf-overlay/mapper/field-type";
import { makeNewPosition } from "@/lib/document-merge/pdf-overlay/mapper/serialization";
import type { EditorPosition } from "@/lib/document-merge/pdf-overlay/mapper/serialization";

export interface PlaceholderField {
  id: string;
  placeholder: string;
  sourceType: string | null;
  sourceEntity: string | null;
  sourceField: string | null;
  sourcePath: string | null;
  optionValue: string | null;
  formatType: string | null;
  fallbackValue: string | null;
  isRequired: boolean;
  isOrphaned: boolean;
  isSuggested: boolean;
}

interface PlaceholderPanelProps {
  fields: PlaceholderField[];
  positions: EditorPosition[];
  currentPage: number;
  onAdd: (pos: EditorPosition) => void;
}

export function PlaceholderPanel({ fields, positions, currentPage, onAdd }: PlaceholderPanelProps) {
  const [query, setQuery] = useState("");

  const mappedCount = useMemo(
    () => new Set(positions.map((p) => p.placeholder)).size,
    [positions],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const active = fields.filter((f) => !f.isOrphaned);
    if (!q) return active;
    return active.filter((f) =>
      f.placeholder.toLowerCase().includes(q) ||
      String(f.sourceField ?? "").toLowerCase().includes(q) ||
      String(f.sourcePath ?? "").toLowerCase().includes(q) ||
      String(f.formatType ?? "").toLowerCase().includes(q),
    );
  }, [fields, query]);

  const handleAdd = (field: PlaceholderField) => {
    const type = inferPositionType(field.formatType, field.sourceType);
    const isCheckbox = type === "CHECKBOX" || type === "RADIO_OPTION";
    const pos = makeNewPosition(field.placeholder, currentPage, {
      type,
      sourceKey: isCheckbox ? fieldSourceKey(field) || field.placeholder : null,
      optionValue: field.optionValue ?? null,
    });
    onAdd(pos);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-1 pb-2">
        <div className="text-xs font-bold text-slate-800">Placeholders</div>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600">
          {mappedCount}/{fields.filter((f) => !f.isOrphaned).length} đã map
        </span>
      </div>

      <div className="relative mb-2">
        <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Tìm placeholder / field..."
          className="w-full rounded-lg border border-slate-200 bg-white py-1.5 pl-8 pr-3 text-xs outline-none focus:border-emerald-600"
        />
      </div>

      <div className="flex-1 space-y-1 overflow-y-auto pr-1">
        {filtered.length === 0 && (
          <div className="px-2 py-6 text-center text-xs text-slate-400">Không tìm thấy placeholder.</div>
        )}
        {filtered.map((f) => {
          const mapped = positions.some((p) => p.placeholder === f.placeholder);
          const type = inferPositionType(f.formatType, f.sourceType);
          const sourceKey = fieldSourceKey(f);
          return (
            <div
              key={f.id}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData("text/plain", f.placeholder);
                e.dataTransfer.effectAllowed = "copy";
              }}
              className={`group flex cursor-grab flex-col gap-0.5 rounded-lg border px-2 py-1.5 text-left transition hover:border-emerald-400 ${
                mapped ? "border-slate-200 bg-slate-50" : "border-dashed border-emerald-300 bg-emerald-50/50"
              }`}
            >
              <div className="flex items-center gap-1.5">
                <span className={`h-2 w-2 shrink-0 rounded-full ${mapped ? "bg-slate-300" : "bg-emerald-500"}`} />
                <span className="truncate font-mono text-[11px] font-semibold text-slate-800">{f.placeholder}</span>
                {f.isRequired && <span className="shrink-0 text-[10px] font-bold text-red-500">*</span>}
              </div>
              <div className="flex items-center justify-between gap-1">
                <span className="truncate text-[10px] text-slate-400">{sourceKey || "—"}</span>
                <span className="shrink-0 rounded bg-slate-100 px-1 text-[9px] font-bold text-slate-500">{type}</span>
              </div>
              <button
                onClick={() => handleAdd(f)}
                className="mt-0.5 hidden w-fit items-center gap-1 rounded-md bg-emerald-600 px-1.5 py-0.5 text-[9px] font-semibold text-white group-hover:flex"
                title="Thêm vào trang hiện tại"
              >
                <Plus className="h-3 w-3" /> Thêm
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
