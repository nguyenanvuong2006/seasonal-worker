"use client";

/**
 * VERSION CLONE + DRAFT EDIT MODALS — "Tạo bản nháp từ phiên bản này".
 *
 * Opened from: Trộn tài liệu → Sửa Template → Phiên bản Template.
 *
 * 1. VersionCloneConfirmModal — confirmation dialog trước khi clone:
 *    giải thích rõ version nguồn không bị thay đổi, hệ thống tạo DRAFT mới,
 *    HTML/CSS được sao chép, và có thể Preview trước khi Publish.
 *    API gọi: POST /api/document-merge/templates/:id/versions/:vid/clone
 *    (server tự load version nguồn theo URL — client không gửi HTML).
 *
 * 2. DraftVersionEditorModal — "Sửa HTML/CSS" cho version DRAFT:
 *    textarea HTML body + Print CSS, PATCH về endpoint version detail.
 *    Server reject (409) nếu version đã rời DRAFT khi editor đang mở.
 *
 * Neither dialog publishes anything — publishing vẫn đi qua workflow hiện có
 * ([Xuất bản phiên bản] → publishTemplateVersion freeze mapping snapshot).
 */

import { useState } from "react";
import { AlertTriangle, Copy, FileCode2, Save, X } from "lucide-react";

export type CloneVersionTarget = {
  id: string;
  version: number;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
};

/* ------------------------------------------------------------------ *
 * 1. CLONE CONFIRM
 * ------------------------------------------------------------------ */

export function VersionCloneConfirmModal({
  templateName,
  version,
  onCancel,
  onConfirm,
  cloning,
}: {
  templateName: string;
  version: CloneVersionTarget;
  onCancel: () => void;
  onConfirm: () => void;
  cloning: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="rounded-lg bg-emerald-50 p-2 text-emerald-700">
              <Copy className="h-4 w-4" />
            </span>
            <h3 className="text-sm font-bold text-slate-900">
              Tạo bản nháp mới từ phiên bản v{version.version}?
            </h3>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={cloning}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-50"
            aria-label="Đóng"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="mt-3 text-[11px] text-slate-500">
          Mẫu <span className="font-semibold text-slate-700">{templateName}</span> · nguồn là phiên
 bản v{version.version} ({version.status}).
        </p>

        <ul className="mt-3 space-y-1.5 rounded-xl bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-600">
          <li>• Phiên bản v{version.version} sẽ <b>không bị thay đổi</b>.</li>
          <li>
            • Hệ thống sẽ tạo một phiên bản <b>DRAFT mới</b>.
          </li>
          <li>
            • <b>HTML và CSS</b> sẽ được sao chép sang bản mới.
          </li>
          <li>
            • Bạn có thể chỉnh sửa bản DRAFT rồi <b>Preview trước khi Publish</b>.
          </li>
        </ul>

        <p className="mt-2 text-[10px] text-slate-400">
          Số phiên bản mới (v{version.version + 1} hoặc cao hơn) do hệ thống tự tính. Version đã
          PUBLISHED dùng để merge production sẽ giữ nguyên cho tới khi bạn chủ động Publish bản DRAFT
          mới.
        </p>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={cloning}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Hủy
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={cloning}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-4 py-2 text-xs font-bold text-white hover:bg-emerald-800 disabled:opacity-50"
          >
            <Copy className="h-3.5 w-3.5" />
            {cloning ? "Đang tạo bản nháp..." : "Tạo bản nháp"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 2. DRAFT HTML/CSS EDITOR
 * ------------------------------------------------------------------ */

export type DraftEditTarget = {
  id: string;
  version: number;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  htmlBody: string | null;
  printCss: string | null;
};

export function DraftVersionEditorModal({
  templateName,
  version,
  templateId,
  onCancel,
  onSaved,
}: {
  templateName: string;
  version: DraftEditTarget;
  templateId: string;
  onCancel: () => void;
  onSaved: (versionId: string) => void;
}) {
  const [html, setHtml] = useState(version.htmlBody ?? "");
  const [css, setCss] = useState(version.printCss ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  const save = async () => {
    if (!html.trim()) {
      setError("HTML body không được để trống — version DRAFT phải có nội dung để Publish sau này.");
      return;
    }
    setSaving(true);
    setError(null);
    setConflict(false);
    try {
      const res = await fetch(
        `/api/document-merge/templates/${templateId}/versions/${version.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ htmlBody: html, printCss: css || null }),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 409) setConflict(true);
        throw new Error(data.error || "Không lưu được bản nháp.");
      }
      onSaved(version.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không lưu được bản nháp.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4">
      <div className="my-6 w-full max-w-4xl rounded-2xl bg-white p-5 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="rounded-lg bg-amber-50 p-2 text-amber-700">
              <FileCode2 className="h-4 w-4" />
            </span>
            <div>
              <h3 className="text-sm font-bold text-slate-900">
                Sửa HTML/CSS — phiên bản v{version.version} (DRAFT)
              </h3>
              <p className="text-[11px] font-bold text-amber-600">
                BẢN NHÁP — CHƯA XUẤT BẢN
              </p>
              <p className="text-[11px] text-slate-500">
                Mẫu {templateName}. Chỉ version DRAFT được sửa — version đã PUBLISHED/ARCHIVED là
                bất biến.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-50"
            aria-label="Đóng"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {error && (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-[11px] text-red-700">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-semibold">{error}</p>
              {conflict && (
                <p className="mt-1">
                  Phiên bản này đã không còn là DRAFT trên server (có thể vừa được ai đó
                  publish/archive). Hãy đóng editor, tải lại danh sách phiên bản và làm việc trên bản
                  DRAFT khác.
                </p>
              )}
            </div>
          </div>
        )}

        <div className="mt-4 grid gap-3">
          <label className="text-[11px] font-semibold text-slate-600">
            HTML body (print template A4, chứa placeholder {"<<...>>"})
            <textarea
              value={html}
              onChange={(e) => setHtml(e.target.value)}
              rows={16}
              spellCheck={false}
              disabled={conflict || saving}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-[11px] outline-none focus:border-emerald-600 disabled:bg-slate-50"
            />
          </label>
          <label className="text-[11px] font-semibold text-slate-600">
            Print CSS (CSS A4 chung được tự thêm)
            <textarea
              value={css}
              onChange={(e) => setCss(e.target.value)}
              rows={5}
              spellCheck={false}
              disabled={conflict || saving}
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-[11px] outline-none focus:border-emerald-600 disabled:bg-slate-50"
            />
          </label>
        </div>

        <p className="mt-2 text-[10px] text-slate-400">
          Sau khi lưu, hãy bấm <b>Xem trước</b> trên phiên bản v{version.version} để kiểm tra PDF bằng
          một ứng viên thật trước khi Xuất bản. Mapping snapshot chỉ được freeze khi Publish.
        </p>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Hủy
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || conflict}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-4 py-2 text-xs font-bold text-white hover:bg-emerald-800 disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" />
            {saving ? "Đang lưu..." : "Lưu bản nháp"}
          </button>
        </div>
      </div>
    </div>
  );
}
