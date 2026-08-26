"use client";

/**
 * H1 — TEMPLATE CHANGE ANALYZER (operator-facing, READ-ONLY).
 *
 * Panel hiển thị CỐT LÕI trong Trộn tài liệu → Sửa Template → Phiên bản
 * Template, tiêu đề "HỖ TRỢ CẬP NHẬT TEMPLATE BẰNG AI". KHÔNG bị giấu sau
 * feature flag, KHÔNG yêu cầu version DRAFT — hiện ngay khi template có ít
 * nhất một phiên bản (chọn phiên bản gốc trong dropdown).
 *
 * Workflow (nguyên văn README-AI.md trong gói xuất):
 *   1. [Xuất Template cho AI]  — GET  /api/document-merge/templates/{id}/versions/{versionId}/ai-export
 *                               (ZIP: template.html + print.css + template-manifest.json + README-AI.md).
 *   2. Đưa gói ZIP cho AI chỉnh sửa (ngoài hệ thống).
 *   3. Dán HTML/CSS AI trả về vào hai ô dưới đây.
 *   4. [Phân tích thay đổi]    — POST /api/document-merge/templates/{id}/ai-analyze
 *                               (SELECT-only, zero DB writes — đã được test khóa chặt ở
 *                               ai-analyze-route.test.ts; tái dùng PR #102 buildTemplateDiff).
 *
 * RÀNG BUỘC AN TOÀN (H1 scope — không hơn):
 *   - KHÔNG Apply, KHÔNG lưu, KHÔNG unsaved-preview, KHÔNG publish,
 *     KHÔNG sửa mapping, KHÔNG ghi DB dưới bất kỳ hình thức nào.
 *   - Muốn áp dụng nội dung: dùng flow DRAFT "Sửa HTML/CSS" sẵn có
 *     (version-clone-modals.tsx) — panel này chỉ PHÂN TÍCH.
 *   - Kết quả phân tích được render dạng văn bản thuần — không bao giờ gắn
 *     HTML thô từ response vào DOM.
 */

import { useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, Search } from "lucide-react";

export type TemplateAnalyzerVersion = {
  id: string;
  version: number;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
};

/** Shape of POST .../ai-analyze's JSON response — READ-ONLY, never mutates anything. */
export type TemplateAnalyzeResult = {
  baseVersion: number;
  baseVersionStatus: string;
  htmlValid: boolean;
  htmlIssues: { message: string }[];
  cssValid: boolean;
  cssIssues: { message: string }[];
  placeholders: { total: number; unchanged: number; added: number; removed: number };
  mappingsAffected: number;
  security: { errors: { code: string; message: string }[]; warnings: { code: string; message: string }[] };
  layoutWarnings: { code: string; message: string }[];
  /** H2 fields (có sẵn trong response của route đã merge) — chỉ hiển thị khi có. */
  normalizationWarnings?: { code: string; message: string; href?: string }[];
  externalResourceWarnings?: { code: string; message: string; href?: string }[];
};

export function TemplateChangeAnalyzer({
  templateId,
  versions,
}: {
  templateId: string;
  versions: TemplateAnalyzerVersion[];
}) {
  const [baseVersionId, setBaseVersionId] = useState<string | null>(null);
  const [html, setHtml] = useState("");
  const [css, setCss] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [analyzeResult, setAnalyzeResult] = useState<TemplateAnalyzeResult | null>(null);
  // Race guard: chỉ response của lần bấm [Phân tích thay đổi] MỚI NHẤT được
  // chạm state (cùng khuôn mẫu merge-workspace.tsx).
  const analyzeSeq = useRef(0);

  // Phiên bản gốc mặc định: version PUBLISHED đang dùng cho production, nếu
  // không có thì lấy version mới nhất. Operator đổi được qua dropdown.
  const published = versions.find((v) => v.status === "PUBLISHED");
  const fallbackBase =
    published ??
    [...versions].sort((a, b) => b.version - a.version)[0] ??
    null;
  const effectiveBaseId = baseVersionId && versions.some((v) => v.id === baseVersionId) ? baseVersionId : fallbackBase?.id ?? null;
  const effectiveBase = versions.find((v) => v.id === effectiveBaseId) ?? null;

  if (versions.length === 0) {
    return (
      <div className="mt-4 rounded-2xl border border-violet-200 bg-violet-50/40 p-4">
        <h5 className="text-xs font-bold text-violet-900">HỖ TRỢ CẬP NHẬT TEMPLATE BẰNG AI</h5>
        <p className="mt-1 text-[11px] text-slate-500">
          Chưa có phiên bản nào — tạo version đầu tiên để bật xuất gói AI &amp; phân tích thay đổi.
        </p>
      </div>
    );
  }

  const analyze = async () => {
    if (!effectiveBaseId) {
      setAnalyzeError("Chọn phiên bản gốc trước khi phân tích.");
      return;
    }
    if (!html.trim()) {
      setAnalyzeError("Dán nội dung HTML do AI trả về vào ô HTML trước khi phân tích.");
      return;
    }
    const seq = ++analyzeSeq.current;
    setAnalyzing(true);
    setAnalyzeError(null);
    try {
      const res = await fetch(`/api/document-merge/templates/${templateId}/ai-analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ html, printCss: css || null, baseVersionId: effectiveBaseId }),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (seq !== analyzeSeq.current) return; // response cũ — bỏ qua.
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "Không phân tích được nội dung.");
      setAnalyzeResult(data as unknown as TemplateAnalyzeResult);
    } catch (err) {
      if (seq !== analyzeSeq.current) return;
      setAnalyzeError(err instanceof Error ? err.message : "Không phân tích được nội dung.");
      setAnalyzeResult(null);
    } finally {
      if (seq === analyzeSeq.current) setAnalyzing(false);
    }
  };

  const exportZip = () => {
    if (!effectiveBaseId) return;
    // GET thuần — server đóng gói ZIP, không ghi DB gì cả.
    window.open(
      `/api/document-merge/templates/${templateId}/versions/${effectiveBaseId}/ai-export`,
      "_blank",
      "noopener",
    );
  };

  return (
    <div className="mt-4 rounded-2xl border border-violet-300 bg-violet-50/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h5 className="text-xs font-bold text-violet-900">HỖ TRỢ CẬP NHẬT TEMPLATE BẰNG AI</h5>
        <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-bold text-slate-500">
          chỉ đọc — không lưu, không áp dụng, không publish
        </span>
      </div>
      <p className="mt-1 text-[11px] text-slate-600">
        Bước 1: tải gói ZIP (HTML + CSS + manifest + README-AI) và đưa cho AI chỉnh sửa. Bước 2: dán HTML/CSS AI trả
        về vào hai ô dưới. Bước 3: bấm <b>Phân tích thay đổi</b> để xem ảnh hưởng placeholder/mapping/bảo mật trước
        khi quyết định tạo bản nháp. Muốn áp dụng thật: dùng nút “Tạo bản nháp từ phiên bản này” → “Sửa HTML/CSS”.
      </p>

      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <label className="text-[11px] font-bold text-slate-700" htmlFor="tca-base-version">
          Phiên bản gốc
        </label>
        <select
          id="tca-base-version"
          value={effectiveBaseId ?? ""}
          onChange={(e) => {
            setBaseVersionId(e.target.value || null);
            // Đổi phiên bản gốc → kết quả cũ không còn đúng chuẩn so sánh.
            setAnalyzeResult(null);
            setAnalyzeError(null);
          }}
          className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-[11px] font-semibold text-slate-700 outline-none focus:border-violet-500"
        >
          {versions.map((v) => (
            <option key={v.id} value={v.id}>
              v{v.version} — {v.status}
              {v.status === "PUBLISHED" ? " (đang dùng production)" : ""}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={exportZip}
          disabled={!effectiveBaseId}
          title="Tải gói ZIP template.html + print.css + template-manifest.json + README-AI.md của phiên bản gốc đã chọn. Chỉ đọc — không thay đổi gì trên hệ thống."
          className="inline-flex items-center gap-1.5 rounded-lg border border-violet-300 bg-violet-100 px-3 py-1.5 text-[11px] font-bold text-violet-800 hover:bg-violet-200 disabled:opacity-50"
        >
          <Download className="h-3.5 w-3.5" />
          Xuất Template cho AI
        </button>
      </div>

      <div className="mt-3 grid gap-3">
        <label className="text-[11px] font-semibold text-slate-700">
          HTML
          <textarea
            value={html}
            onChange={(e) => setHtml(e.target.value)}
            rows={10}
            spellCheck={false}
            placeholder="Dán toàn bộ HTML do AI trả về (có thể là cả tài liệu <!DOCTYPE html>… hoặc riêng phần body chứa placeholder <<Ho_ten>>…)"
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-[11px] outline-none focus:border-violet-500"
          />
        </label>
        <label className="text-[11px] font-semibold text-slate-700">
          CSS bản in
          <textarea
            value={css}
            onChange={(e) => setCss(e.target.value)}
            rows={4}
            spellCheck={false}
            placeholder="CSS bản in riêng (nếu AI trả file print.css). Để trống nếu CSS đã nằm trong thẻ <style> của HTML."
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-[11px] outline-none focus:border-violet-500"
          />
        </label>
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <p className="text-[10px] text-slate-400">
          Phân tích so với phiên bản {effectiveBase ? `v${effectiveBase.version} (${effectiveBase.status})` : "—"} đã
          chọn ở trên. Không lưu, không áp dụng gì cả.
        </p>
        <button
          type="button"
          onClick={() => void analyze()}
          disabled={analyzing || !effectiveBaseId}
          className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-300 bg-indigo-50 px-3 py-1.5 text-[11px] font-bold text-indigo-700 hover:bg-indigo-100 disabled:opacity-50"
        >
          <Search className="h-3.5 w-3.5" />
          {analyzing ? "Đang phân tích..." : "Phân tích thay đổi"}
        </button>
      </div>

      {analyzeError && (
        <div className="mt-2 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-2 text-[11px] text-red-700">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <p>{analyzeError}</p>
        </div>
      )}

      {analyzeResult && (
        <div className="mt-3 rounded-xl border border-slate-200 bg-white p-3 text-[11px]">
          <p className="font-bold text-slate-800">
            Kết quả phân tích (chỉ đọc) — so với bản v{analyzeResult.baseVersion} ({analyzeResult.baseVersionStatus})
          </p>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            <span className={`inline-flex items-center gap-1 font-semibold ${analyzeResult.htmlValid ? "text-emerald-700" : "text-red-700"}`}>
              {analyzeResult.htmlValid ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
              HTML: {analyzeResult.htmlValid ? "Hợp lệ" : `${analyzeResult.htmlIssues.length} lỗi cấu trúc`}
            </span>
            <span className={`inline-flex items-center gap-1 font-semibold ${analyzeResult.cssValid ? "text-emerald-700" : "text-red-700"}`}>
              {analyzeResult.cssValid ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
              CSS: {analyzeResult.cssValid ? "Hợp lệ" : `${analyzeResult.cssIssues.length} lỗi cấu trúc`}
            </span>
          </div>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-slate-600">
            {[...analyzeResult.htmlIssues, ...analyzeResult.cssIssues].slice(0, 6).map((issue, i) => (
              <li key={i}>{issue.message}</li>
            ))}
          </ul>

          <p className="mt-2 font-bold text-slate-800">
            Placeholder ({analyzeResult.placeholders.total} tổng cộng, so với v{analyzeResult.baseVersion}):{" "}
            <span className="font-normal">
              {analyzeResult.placeholders.unchanged} không đổi · {analyzeResult.placeholders.added} mới ·{" "}
              {analyzeResult.placeholders.removed} bị xóa
            </span>
          </p>
          <p className={analyzeResult.mappingsAffected > 0 ? "mt-1 font-semibold text-amber-700" : "mt-1 text-slate-500"}>
            {analyzeResult.mappingsAffected} trường bị ảnh hưởng
            {analyzeResult.mappingsAffected === 0 ? " — không cần remapping gì cả." : " — kiểm tra mapping trước khi áp dụng."}
          </p>

          <p className={`mt-2 font-bold ${analyzeResult.security.errors.length > 0 ? "text-red-700" : "text-slate-800"}`}>
            Bảo mật:{" "}
            <span className="font-normal">
              {analyzeResult.security.errors.length > 0
                ? `${analyzeResult.security.errors.length} mã nguy hiểm bị chặn`
                : "không có mã nguy hiểm"}
              {analyzeResult.security.warnings.length > 0 ? ` · ${analyzeResult.security.warnings.length} cảnh báo` : ""}
            </span>
          </p>
          {[...analyzeResult.security.errors, ...analyzeResult.security.warnings].map((s, i) => (
            <p key={i} className="mt-0.5 pl-4 text-slate-600">
              • {s.message}
            </p>
          ))}

          <p className={`mt-2 font-bold ${analyzeResult.layoutWarnings.length > 0 ? "text-amber-700" : "text-slate-800"}`}>
            Bố cục bản in:{" "}
            <span className="font-normal">
              {analyzeResult.layoutWarnings.length > 0
                ? `${analyzeResult.layoutWarnings.length} vị trí có nguy cơ tràn/đè khi dữ liệu dài`
                : "không có cảnh báo bố cục"}
            </span>
          </p>
          {analyzeResult.layoutWarnings.map((w, i) => (
            <p key={i} className="mt-0.5 pl-4 text-slate-600">
              • {w.message}
            </p>
          ))}

          {(analyzeResult.externalResourceWarnings?.length ?? 0) > 0 && (
            <p className="mt-2 font-bold text-amber-700">
              {analyzeResult.externalResourceWarnings!.length} stylesheet ngoài bị bỏ qua (không bao giờ tải về)
            </p>
          )}
          {(analyzeResult.normalizationWarnings?.length ?? 0) > 0 && (
            <p className="mt-1 font-bold text-amber-700">{analyzeResult.normalizationWarnings!.length} lưu ý chuẩn hóa tài liệu</p>
          )}

          <p className="mt-2 text-[10px] text-slate-400">
            Đây là phân tích CHỈ ĐỌC. Để áp dụng nội dung: “Tạo bản nháp từ phiên bản này” → “Sửa HTML/CSS” → dán lại
            → Phân tích → Áp dụng vào bản nháp.
          </p>
        </div>
      )}
    </div>
  );
}
