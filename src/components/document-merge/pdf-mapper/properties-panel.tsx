"use client";

/**
 * PDF Overlay Mapper — field properties panel (PR3).
 * Sửa mọi thuộc tính của 1 position (type, font, align, checkbox, overflow, ...).
 * Đọc/ghi qua PositionInput (khớp NewPdfFieldPositionInput của PR2).
 */

import { useState } from "react";
import {
  ALIGN_OPTIONS,
  CHECKBOX_STYLE_OPTIONS,
  OVERFLOW_POLICY_OPTIONS,
  POSITION_TYPES,
  VALIGN_OPTIONS,
  type PdfPosition,
  type PositionInput,
} from "./mapper-types";

interface PropertiesPanelProps {
  position: PdfPosition;
  readOnly: boolean;
  /** Persist (PATCH) bản cập nhật. */
  onSave: (input: PositionInput) => void;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-[11px] font-semibold text-slate-600">{label}</span>
      {children}
    </label>
  );
}

const inputCls =
  "w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs outline-none focus:border-emerald-600 disabled:bg-slate-100 disabled:text-slate-400";

export function PropertiesPanel({ position, readOnly, onSave }: PropertiesPanelProps) {
  // Component được mount lại theo key={position.id} ở parent → draft khởi tạo
  // đúng theo position, không cần sync effect.
  const [draft, setDraft] = useState<PositionInput>(() => toInput(position));

  const patch = (partial: Partial<PositionInput>) => {
    setDraft((prev) => ({ ...prev, ...partial }));
  };

  const isCheckbox = draft.type === "CHECKBOX" || draft.type === "RADIO_OPTION";
  const isStatic = draft.type === "STATIC_TEXT";

  return (
    <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between gap-2 border-b border-slate-100 pb-2">
        <div className="min-w-0">
          <div className="truncate font-mono text-sm font-bold text-slate-900">{position.placeholder}</div>
          <div className="text-[11px] text-slate-500">Trang {position.pageNumber} · x={Math.round(position.x * 100) / 100} y={Math.round(position.y * 100) / 100} w={Math.round(position.width * 100) / 100} h={Math.round(position.height * 100) / 100}pt</div>
        </div>
        {readOnly && <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-bold text-amber-700">READ-ONLY</span>}
      </div>

      <Field label="Type">
        <select value={draft.type} onChange={(e) => patch({ type: e.target.value })} disabled={readOnly} className={inputCls}>
          {POSITION_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Font size (pt)">
          <input type="number" step="0.5" min="1" value={draft.fontSize ?? ""} onChange={(e) => patch({ fontSize: e.target.value === "" ? undefined : Number(e.target.value) })} disabled={readOnly} className={inputCls} />
        </Field>
        <Field label="Min font size (pt)">
          <input type="number" step="0.5" min="1" value={draft.minFontSize ?? ""} onChange={(e) => patch({ minFontSize: e.target.value === "" ? null : Number(e.target.value) })} disabled={readOnly} className={inputCls} />
        </Field>
        <Field label="Align">
          <select value={draft.align ?? "left"} onChange={(e) => patch({ align: e.target.value })} disabled={readOnly} className={inputCls}>
            {ALIGN_OPTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </Field>
        <Field label="Valign">
          <select value={draft.valign ?? "top"} onChange={(e) => patch({ valign: e.target.value })} disabled={readOnly} className={inputCls}>
            {VALIGN_OPTIONS.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </Field>
        <Field label="Rotation (0/90/180/270)">
          <input type="number" step="90" min="0" max="270" value={draft.rotation ?? 0} onChange={(e) => patch({ rotation: Number(e.target.value) })} disabled={readOnly} className={inputCls} />
        </Field>
        <Field label="Render order">
          <input type="number" step="1" value={draft.renderOrder ?? 0} onChange={(e) => patch({ renderOrder: Number(e.target.value) })} disabled={readOnly} className={inputCls} />
        </Field>
        <Field label="Max lines">
          <input type="number" step="1" min="1" value={draft.maxLines ?? ""} onChange={(e) => patch({ maxLines: e.target.value === "" ? null : Number(e.target.value) })} disabled={readOnly} className={inputCls} />
        </Field>
        <Field label="Overflow policy">
          <select value={draft.overflowPolicy ?? "FAIL"} onChange={(e) => patch({ overflowPolicy: e.target.value })} disabled={readOnly} className={inputCls}>
            {OVERFLOW_POLICY_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className="flex items-center gap-2 text-xs text-slate-700">
          <input type="checkbox" checked={draft.multiline ?? false} onChange={(e) => patch({ multiline: e.target.checked })} disabled={readOnly} /> Multiline
        </label>
        <label className="flex items-center gap-2 text-xs text-slate-700">
          <input type="checkbox" checked={draft.isRequired ?? false} onChange={(e) => patch({ isRequired: e.target.checked })} disabled={readOnly} /> Required
        </label>
        <label className="flex items-center gap-2 text-xs text-slate-700">
          <input type="checkbox" checked={draft.whiteout ?? false} onChange={(e) => patch({ whiteout: e.target.checked })} disabled={readOnly} /> Whiteout
        </label>
      </div>

      {isCheckbox && (
        <div className="grid grid-cols-2 gap-3 rounded-lg bg-slate-50 p-3">
          <Field label="Checkbox style">
            <select value={draft.checkboxStyle ?? ""} onChange={(e) => patch({ checkboxStyle: e.target.value || null })} disabled={readOnly} className={inputCls}>
              <option value="">—</option>
              {CHECKBOX_STYLE_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
          <Field label="Option value">
            <input value={draft.optionValue ?? ""} onChange={(e) => patch({ optionValue: e.target.value || null })} disabled={readOnly} className={inputCls} placeholder="vd: Co / Khong" />
          </Field>
        </div>
      )}

      <Field label="Source key (nhóm nguồn — nhiều position đọc cùng 1 giá trị)">
        <input value={draft.sourceKey ?? ""} onChange={(e) => patch({ sourceKey: e.target.value || null })} disabled={readOnly} className={inputCls} placeholder="vd: Tien_an_tien_su" />
      </Field>

      {isStatic && (
        <Field label="Static text">
          <input value={draft.staticText ?? ""} onChange={(e) => patch({ staticText: e.target.value || null })} disabled={readOnly} className={inputCls} placeholder="Nội dung tĩnh" />
        </Field>
      )}

      {!readOnly && (
        <button
          onClick={() => onSave(draft)}
          className="w-full rounded-lg bg-emerald-700 px-3 py-2 text-xs font-bold text-white hover:bg-emerald-800"
        >
          Lưu thuộc tính
        </button>
      )}
    </div>
  );
}

function toInput(p: PdfPosition): PositionInput {
  return {
    placeholder: p.placeholder,
    pageNumber: p.pageNumber,
    x: p.x,
    y: p.y,
    width: p.width,
    height: p.height,
    type: p.type,
    fontSize: p.fontSize,
    minFontSize: p.minFontSize,
    fontFamily: p.fontFamily,
    align: p.align,
    valign: p.valign,
    multiline: p.multiline,
    maxLines: p.maxLines,
    rotation: p.rotation,
    renderOrder: p.renderOrder,
    isRequired: p.isRequired,
    whiteout: p.whiteout,
    checkboxStyle: p.checkboxStyle,
    optionValue: p.optionValue,
    sourceKey: p.sourceKey,
    overflowPolicy: p.overflowPolicy,
    staticText: p.staticText,
  };
}
