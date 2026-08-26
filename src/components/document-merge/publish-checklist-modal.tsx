"use client";

/**
 * PUBLISH CHECKLIST MODAL — the explicit, manual gate required before a
 * template version is published (Admin Template Version Workflow, Phase 7).
 *
 * Replaces the previous plain `window.confirm("Xuất bản...?")` on both the
 * "Xuất bản phiên bản" and "Xuất bản lại" / "Khôi phục" actions. Reuses the
 * EXISTING, already-tested POST /api/document-merge/templates/:id/ai-analyze
 * endpoint (zero backend changes) to run the machine checks — HTML/CSS
 * validity, security blockers, placeholder + mapping diff vs the currently
 * PUBLISHED version — then requires all 5 operator checkboxes before the
 * actual publish/rollback call (also unchanged, still
 * POST .../versions/:vid/publish|rollback) is allowed to fire.
 *
 * This modal never publishes anything itself — it only gates the caller's
 * onConfirmed(), which the caller wires to the existing publish/rollback fetch.
 */

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, X } from "lucide-react";
import {
  PUBLISH_CHECKLIST_ITEMS,
  canConfirmPublish,
  emptyPublishChecklistState,
  type PublishChecklistKey,
  type PublishChecklistState,
  type PublishMachineChecks,
} from "@/lib/document-merge/publish-checklist";
import type { TemplateAnalyzeResult } from "./template-change-analyzer";

export type PublishChecklistTarget = {
  id: string;
  version: number;
  htmlBody: string | null;
  printCss: string | null;
};

export function PublishChecklistModal({
  templateId,
  templateName,
  target,
  currentPublishedVersionId,
  currentPublishedVersionNumber,
  action,
  onClose,
  onConfirmed,
}: {
  templateId: string;
  templateName: string;
  target: PublishChecklistTarget;
  /** id of the version currently PUBLISHED, if any — used as the diff baseline. */
  currentPublishedVersionId: string | null;
  currentPublishedVersionNumber: number | null;
  action: "publish" | "rollback";
  onClose: () => void;
  /** Caller performs the actual POST .../publish|rollback and closes on success. */
  onConfirmed: () => Promise<void>;
}) {
  const [analyzing, setAnalyzing] = useState(true);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [result, setResult] = useState<TemplateAnalyzeResult | null>(null);
  const [checks, setChecks] = useState<PublishChecklistState>(emptyPublishChecklistState());
  const [confirming, setConfirming] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const mySeq = ++seq.current;
    setAnalyzing(true);
    setAnalyzeError(null);
    setResult(null);
    (async () => {
      try {
        // Diff against the currently PUBLISHED version when one exists and is
        // not the version being published itself (e.g. republishing/rollback
        // of the current PUBLISHED version — nothing meaningful to diff);
        // otherwise self-diff (baseVersionId = target's own id), which still
        // yields htmlValid/cssValid/security/layout checks with a zero diff.
        const baseVersionId =
          currentPublishedVersionId && currentPublishedVersionId !== target.id ? currentPublishedVersionId : target.id;
        const res = await fetch(`/api/document-merge/templates/${templateId}/ai-analyze`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ html: target.htmlBody ?? "", printCss: target.printCss ?? null, baseVersionId }),
        });
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (mySeq !== seq.current) return;
        if (!res.ok) {
          throw new Error(typeof data.error === "string" ? data.error : "Không phân tích được phiên bản trước khi xuất bản.");
        }
        setResult(data as unknown as TemplateAnalyzeResult);
      } catch (err) {
        if (mySeq !== seq.current) return;
        setAnalyzeError(err instanceof Error ? err.message : "Không phân tích được phiên bản trước khi xuất bản.");
      } finally {
        if (mySeq === seq.current) setAnalyzing(false);
      }
    })();
    return () => {
      seq.current += 1;
    };
  }, [templateId, target.id, target.htmlBody, target.printCss, currentPublishedVersionId]);

  const machine: PublishMachineChecks | null = result
    ? { htmlValid: result.htmlValid, cssValid: result.cssValid, securityBlockerCount: result.security.errors.length }
    : null;
  const canConfirm = canConfirmPublish(machine, checks) && !confirming && !analyzing;

  const toggle = (key: PublishChecklistKey) => setChecks((prev) => ({ ...prev, [key]: !prev[key] }));

  const confirm = async () => {
    if (!canConfirm) return;
    setConfirming(true);
    try {
      await onConfirmed();
    } finally {
      setConfirming(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/50 p-4">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-5 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-slate-900">
              {action === "publish" ? "Xác nhận xuất bản" : "Xác nhận xuất bản lại"} v{target.version}
            </h3>
            <p className="mt-1 text-xs text-slate-600">
              Bạn sắp xuất bản v{target.version}
              {currentPublishedVersionNumber != null && currentPublishedVersionNumber !== target.version
                ? ` và thay thế v${currentPublishedVersionNumber} hiện đang PUBLISHED`
                : ""}{" "}
              của &quot;{templateName}&quot;.
            </p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100" aria-label="Đóng">
            <X className="h-4 w-4" />
          </button>
        </div>

        {analyzing && <p className="mt-4 text-xs text-slate-500">Đang phân tích phiên bản trước khi xuất bản...</p>}
        {analyzeError && (
          <div className="mt-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p>{analyzeError}</p>
          </div>
        )}

        {result && (
          <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs">
            <p className="font-bold text-slate-800">Kiểm tra tự động</p>
            <ul className="mt-2 space-y-1">
              <ChecklistLine ok={result.htmlValid} label={`HTML ${result.htmlValid ? "hợp lệ" : `— ${result.htmlIssues.length} lỗi cấu trúc`}`} />
              <ChecklistLine ok={result.cssValid} label={`CSS ${result.cssValid ? "hợp lệ" : `— ${result.cssIssues.length} lỗi cấu trúc`}`} />
              <ChecklistLine
                ok={result.security.errors.length === 0}
                label={result.security.errors.length === 0 ? "Không có mã nguy hiểm" : `${result.security.errors.length} mã nguy hiểm bị chặn`}
              />
            </ul>
            <p className="mt-3 text-slate-700">
              Placeholder: {result.placeholders.unchanged} không đổi · {result.placeholders.added} mới · {result.placeholders.removed} bị xóa
            </p>
            <p className={result.mappingsAffected > 0 ? "mt-1 font-semibold text-amber-700" : "mt-1 text-slate-500"}>
              {result.mappingsAffected} trường mapping bị ảnh hưởng
              {result.mappingsAffected === 0 ? " — không cần remapping gì cả." : " — kiểm tra mapping trước khi xuất bản."}
            </p>
            {result.layoutWarnings.length > 0 && (
              <p className="mt-1 font-semibold text-amber-700">{result.layoutWarnings.length} cảnh báo bố cục bản in (tràn/đè khi dữ liệu dài).</p>
            )}
            {!(result.htmlValid && result.cssValid && result.security.errors.length === 0) && (
              <p className="mt-2 font-bold text-red-700">Còn lỗi cấu trúc/bảo mật chưa xử lý — không thể xuất bản cho tới khi khắc phục.</p>
            )}
          </div>
        )}

        <div className="mt-4 rounded-xl border border-slate-200 p-3">
          <p className="text-xs font-bold text-slate-800">Xác nhận của người vận hành</p>
          <div className="mt-2 space-y-2">
            {PUBLISH_CHECKLIST_ITEMS.map((item) => (
              <label key={item.key} className="flex items-center gap-2 text-xs text-slate-700">
                <input type="checkbox" checked={checks[item.key]} onChange={() => toggle(item.key)} className="accent-emerald-700" />
                {item.label}
              </label>
            ))}
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-slate-300 px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">
            Hủy
          </button>
          <button
            type="button"
            onClick={() => void confirm()}
            disabled={!canConfirm}
            className="rounded-lg bg-emerald-700 px-3.5 py-2 text-xs font-bold text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {confirming ? "Đang xuất bản..." : action === "publish" ? "Xuất bản phiên bản" : "Xuất bản lại"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ChecklistLine({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li className={`flex items-center gap-1.5 ${ok ? "text-emerald-700" : "text-red-700"}`}>
      {ok ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> : <AlertTriangle className="h-3.5 w-3.5 shrink-0" />}
      {label}
    </li>
  );
}
