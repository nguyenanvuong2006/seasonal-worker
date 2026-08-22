"use client";
/**
 * PDF Overlay — Validation Panel (PR3).
 * Hiển thị tổng kết validation (errors/warnings/infos) trước khi publish.
 * - errors: chặn publish (geometry, out-of-bounds, page invalid, checkbox, overflow, duplicate)
 * - warnings: không chặn (unmapped optional/required, overlap, orphan mapping)
 * Publish thực tế vẫn do PR2 lifecycle API quyết định (gate SHA integrity).
 */

import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import type { ValidationSummary } from "@/lib/document-merge/pdf-overlay/mapper/validation-summary";

interface ValidationPanelProps {
  summary: ValidationSummary | null;
}

export function ValidationPanel({ summary }: ValidationPanelProps) {
  if (!summary) {
    return <div className="px-2 py-4 text-center text-xs text-slate-400">Chưa chạy validation.</div>;
  }

  const hasErrors = summary.errors.length > 0;
  return (
    <div className="space-y-3">
      <div
        className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold ${
          hasErrors
            ? "border-red-200 bg-red-50 text-red-700"
            : "border-emerald-200 bg-emerald-50 text-emerald-700"
        }`}
      >
        {hasErrors ? <XCircle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
        {hasErrors ? `${summary.errors.length} lỗi chặn publish` : "Không có lỗi chặn — sẵn sàng publish"}
      </div>

      {summary.errors.length > 0 && (
        <ul className="space-y-1">
          {summary.errors.map((e, i) => (
            <li key={i} className="flex items-start gap-1.5 rounded-md bg-red-50 px-2 py-1 text-[11px] text-red-700">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> {e}
            </li>
          ))}
        </ul>
      )}

      {summary.warnings.length > 0 && (
        <div>
          <div className="mb-1 text-[10px] font-bold uppercase text-slate-400">Cảnh báo (không chặn)</div>
          <ul className="space-y-1">
            {summary.warnings.map((w, i) => (
              <li key={i} className="flex items-start gap-1.5 rounded-md bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
                <Info className="mt-0.5 h-3 w-3 shrink-0" /> {w}
              </li>
            ))}
          </ul>
        </div>
      )}

      {summary.infos.length > 0 && (
        <div>
          <div className="mb-1 text-[10px] font-bold uppercase text-slate-400">Thông tin</div>
          <ul className="space-y-1">
            {summary.infos.map((i, idx) => (
              <li key={idx} className="text-[11px] text-slate-500">• {i}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
