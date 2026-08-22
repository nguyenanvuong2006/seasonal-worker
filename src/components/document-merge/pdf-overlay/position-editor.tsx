"use client";
/**
 * PDF Overlay — Position Editor (PR3).
 * Chỉnh sửa số chính xác cho position đang chọn: x/y/width/height (pt), page,
 * font size, min font size, align, valign, multiline, maxLines, rotation,
 * renderOrder, required, whiteout, overflowPolicy, checkboxStyle/optionValue,
 * staticText. Kèm duplicate + delete.
 */

import { useEffect, useState } from "react";
import { Copy, Trash2 } from "lucide-react";
import { CHECKBOX_POSITION_TYPES } from "@/lib/document-merge/pdf-overlay/types";
import type { EditorPosition } from "@/lib/document-merge/pdf-overlay/mapper/serialization";

interface PositionEditorProps {
  pos: EditorPosition | null;
  pageCount: number;
  readOnly: boolean;
  onUpdate: (clientId: string, patch: Partial<EditorPosition>) => void;
  onDuplicate: (clientId: string) => void;
  onDelete: (clientId: string) => void;
}

function NumField({
  label,
  value,
  step,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  step?: number;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[10px] font-semibold text-slate-500">{label}</span>
      <input
        type="number"
        step={step ?? 1}
        value={Number.isFinite(value) ? value : 0}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full rounded-md border border-slate-200 bg-white px-2 py-1 text-xs outline-none focus:border-emerald-600 disabled:bg-slate-50"
      />
    </label>
  );
}

const SELECT_CLS =
  "w-full rounded-md border border-slate-200 bg-white px-2 py-1 text-xs outline-none focus:border-emerald-600 disabled:bg-slate-50";

export function PositionEditor({ pos, pageCount, readOnly, onUpdate, onDuplicate, onDelete }: PositionEditorProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  useEffect(() => setConfirmDelete(false), [pos?.clientId]);

  if (!pos) {
    return (
      <div className="px-2 py-6 text-center text-xs text-slate-400">
        Chọn một field box trên PDF để chỉnh sửa.
        <div className="mt-2 text-[10px] text-slate-300">Kéo placeholder từ panel trái vào trang để thêm vị trí mới.</div>
      </div>
    );
  }

  const isCheckbox = CHECKBOX_POSITION_TYPES.includes(pos.type as any);
  const set = (patch: Partial<EditorPosition>) => onUpdate(pos.clientId, patch);

  return (
    <div className="space-y-3">
      {readOnly && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[10px] font-semibold text-amber-700">
          Chế độ chỉ-đọc — version không phải DRAFT.
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-mono text-xs font-bold text-slate-800">{pos.placeholder}</div>
          <div className="text-[10px] text-slate-400">{pos.type}</div>
        </div>
        <div className="flex shrink-0 gap-1">
          <button
            onClick={() => onDuplicate(pos.clientId)}
            disabled={readOnly}
            title="Duplicate position"
            className="rounded-md border border-slate-200 p-1.5 text-slate-500 hover:bg-slate-100 disabled:opacity-40"
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => {
              if (confirmDelete) {
                onDelete(pos.clientId);
              } else {
                setConfirmDelete(true);
                setTimeout(() => setConfirmDelete(false), 2500);
              }
            }}
            disabled={readOnly}
            title={confirmDelete ? "Bấm lần nữa để xoá" : "Xoá position"}
            className={`rounded-md border p-1.5 disabled:opacity-40 ${confirmDelete ? "border-red-400 bg-red-50 text-red-600" : "border-slate-200 text-slate-500 hover:bg-red-50"}`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <NumField label="x (pt, trái)" value={pos.x} step={1} disabled={readOnly} onChange={(v) => set({ x: v })} />
        <NumField label="y (pt, dưới)" value={pos.y} step={1} disabled={readOnly} onChange={(v) => set({ y: v })} />
        <NumField label="width (pt)" value={pos.width} step={1} disabled={readOnly} onChange={(v) => set({ width: v })} />
        <NumField label="height (pt)" value={pos.height} step={1} disabled={readOnly} onChange={(v) => set({ height: v })} />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] font-semibold text-slate-500">Page</span>
          <select
            value={pos.pageNumber}
            disabled={readOnly}
            onChange={(e) => set({ pageNumber: Number(e.target.value) })}
            className={SELECT_CLS}
          >
            {Array.from({ length: pageCount }, (_, i) => i + 1).map((p) => (
              <option key={p} value={p}>Page {p}</option>
            ))}
          </select>
        </label>
        <NumField label="Font size (pt)" value={pos.fontSize} step={0.5} disabled={readOnly} onChange={(v) => set({ fontSize: v })} />
        <NumField label="Min font size" value={pos.minFontSize ?? 0} step={0.5} disabled={readOnly} onChange={(v) => set({ minFontSize: v > 0 ? v : null })} />
        <NumField label="Rotation (°)" value={pos.rotation} step={90} disabled={readOnly} onChange={(v) => set({ rotation: v })} />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] font-semibold text-slate-500">Align</span>
          <select value={pos.align} disabled={readOnly} onChange={(e) => set({ align: e.target.value as any })} className={SELECT_CLS}>
            <option value="left">Trái</option>
            <option value="center">Giữa</option>
            <option value="right">Phải</option>
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] font-semibold text-slate-500">Valign</span>
          <select value={pos.valign} disabled={readOnly} onChange={(e) => set({ valign: e.target.value as any })} className={SELECT_CLS}>
            <option value="top">Trên</option>
            <option value="middle">Giữa</option>
            <option value="bottom">Dưới</option>
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[10px] font-semibold text-slate-500">Overflow</span>
          <select value={pos.overflowPolicy} disabled={readOnly} onChange={(e) => set({ overflowPolicy: e.target.value as any })} className={SELECT_CLS}>
            <option value="FAIL">FAIL</option>
            <option value="ELLIPSIZE">ELLIPSIZE</option>
          </select>
        </label>
        <NumField label="Max lines" value={pos.maxLines ?? 0} step={1} disabled={readOnly} onChange={(v) => set({ maxLines: v > 0 ? v : null })} />
      </div>

      <div className="flex flex-wrap gap-2">
        <label className="flex items-center gap-1.5 text-[11px] text-slate-600">
          <input type="checkbox" checked={pos.isRequired} disabled={readOnly} onChange={(e) => set({ isRequired: e.target.checked })} /> Required
        </label>
        <label className="flex items-center gap-1.5 text-[11px] text-slate-600">
          <input type="checkbox" checked={pos.whiteout} disabled={readOnly} onChange={(e) => set({ whiteout: e.target.checked })} /> Whiteout
        </label>
        <label className="flex items-center gap-1.5 text-[11px] text-slate-600">
          <input type="checkbox" checked={pos.multiline} disabled={readOnly || pos.type === "STATIC_TEXT"} onChange={(e) => set({ multiline: e.target.checked })} /> Multiline
        </label>
      </div>

      {isCheckbox && (
        <div className="grid grid-cols-1 gap-2 rounded-lg border border-emerald-100 bg-emerald-50/40 p-2">
          <label className="flex flex-col gap-0.5">
            <span className="text-[10px] font-semibold text-slate-500">Checkbox style</span>
            <select value={pos.checkboxStyle ?? "SQUARE_X"} disabled={readOnly} onChange={(e) => set({ checkboxStyle: e.target.value as any })} className={SELECT_CLS}>
              <option value="SQUARE_X">☒ Square X</option>
              <option value="SQUARE_TICK">✓ Square tick</option>
              <option value="SQUARE_FILLED">■ Square filled</option>
              <option value="CIRCLE_DOT">● Circle dot</option>
            </select>
          </label>
          <div className="flex flex-col gap-0.5">
            <span className="text-[10px] font-semibold text-slate-500">Option value</span>
            <input
              value={pos.optionValue ?? ""}
              disabled={readOnly}
              onChange={(e) => set({ optionValue: e.target.value })}
              className="w-full rounded-md border border-slate-200 bg-white px-2 py-1 text-xs outline-none focus:border-emerald-600 disabled:bg-slate-50"
            />
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-[10px] font-semibold text-slate-500">Source key</span>
            <input
              value={pos.sourceKey ?? ""}
              disabled={readOnly}
              onChange={(e) => set({ sourceKey: e.target.value })}
              className="w-full rounded-md border border-slate-200 bg-white px-2 py-1 text-xs outline-none focus:border-emerald-600 disabled:bg-slate-50"
            />
          </div>
        </div>
      )}

      {pos.type === "STATIC_TEXT" && (
        <div className="flex flex-col gap-0.5 rounded-lg border border-amber-100 bg-amber-50/40 p-2">
          <span className="text-[10px] font-semibold text-slate-500">Static text</span>
          <textarea
            value={pos.staticText ?? ""}
            disabled={readOnly}
            onChange={(e) => set({ staticText: e.target.value })}
            rows={3}
            className="w-full rounded-md border border-slate-200 bg-white px-2 py-1 text-xs outline-none focus:border-emerald-600 disabled:bg-slate-50"
          />
        </div>
      )}
    </div>
  );
}
