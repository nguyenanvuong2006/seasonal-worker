"use client";

/**
 * DRAFT VERSION PREVIEW MODAL — "Xem trước" for a template version.
 *
 * Opened from: Trộn tài liệu → Sửa Template → Phiên bản Template → [Xem trước].
 *
 * This dialog NEVER publishes. It calls only:
 *   GET  /api/document-merge/candidates?q=…                           (search)
 *   POST /api/document-merge/templates/:id/versions/:vid/preview      (Quick Preview, DOM)
 *   POST /api/document-merge/templates/:id/versions/:vid/preview-pdf  (A4 PDF Preview, real PDF)
 * All are read-only, ADMIN-guarded and data-scope filtered server-side.
 *
 * TWO preview modes, both from the SAME canonical renderer/snapshot
 * (renderCanonicalDocument — see preview-render.ts), so neither can drift
 * from what a real merge produces:
 *
 *   - "Xem trước PDF A4" (AUTHORITATIVE): the real Chromium-rendered PDF —
 *     same page.pdf() configuration the HTML_PDF worker uses for a real
 *     merge (see worker/src/index.ts's renderPdfBytes). True A4 physical
 *     pagination, print-media CSS, exact page count. This is the version to
 *     approve a template against.
 *   - "Xem nhanh" (Quick Preview, APPROXIMATE): the SAME rendered HTML shown
 *     in a sandboxed iframe on ordinary screen media, decorated with
 *     visual "Trang N" sheet boundaries. Fast (no Chromium round trip) but
 *     CANNOT reproduce true print-media pagination — a `.paper` section
 *     whose content overflows one physical A4 page renders here as a
 *     single tall box, while the real PDF continues it onto additional
 *     physical pages (see preview-a4-decoration.ts). Useful for a quick
 *     look while editing; never the basis for approving a template.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Eye, ExternalLink, FileText, FileWarning, Printer, Search, X } from "lucide-react";
import {
  buildPrintViewUrl,
  canOpenPrintView,
  hasRenderedPreview,
} from "@/lib/document-merge/print-preview";
import { decoratePreviewForA4Sheets } from "@/lib/document-merge/preview-a4-decoration";

export type PreviewVersionTarget = {
  id: string;
  version: number;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  mappingSnapshotCount: number;
};

type Candidate = {
  id: string;
  fullName: string;
  cccd: string;
  phone: string;
  regDate: string | null;
  status: string | null;
  deptName: string | null;
};

type PreviewResult = {
  banner: string | null;
  renderedHtml: string;
  version: number;
  versionStatus: string;
  templateName: string;
  mappingSource: string;
  mappingSummary: { total: number; mapped: number; required: number };
  pageCount: number | null;
  fullName: string | null;
  cccd: string | null;
  unreplaced: string[];
  missingFields: string[];
  valid: boolean;
  currentPublishedVersion: number | null;
  /** Phase 5 — same margin config the final PDF used (see preview-a4-decoration.ts). */
  margins: { topMm: number; bottomMm: number; leftMm: number; rightMm: number } | null;
};

type Problem = { code: string; error: string; action?: string; details?: string };

/**
 * H3 — "Thông tin tạo tài liệu" (Signing Context, Phase 16). Operator sets
 * these ONCE per Preview call; the same values are echoed back by the API
 * and reused for the print view, so COMPUTED placeholders (Ngay_ky_day,
 * Dia_diem_ky, Nam_thue, ...) never drift between screen and print.
 */
type SigningContextInput = {
  signingDate: string;
  signingLocation: string;
  documentDate: string;
  receivedDate: string;
  receivedBy: string;
};

const EMPTY_SIGNING_CONTEXT_INPUT: SigningContextInput = {
  signingDate: "",
  signingLocation: "",
  documentDate: "",
  receivedDate: "",
  receivedBy: "",
};

function signingContextBody(input: SigningContextInput): Record<string, string> {
  const body: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value.trim()) body[key] = value.trim();
  }
  return body;
}

const asString = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);
const asArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** Never put a raw API payload into render state (see preview-response.ts). */
function normalize(raw: unknown): PreviewResult {
  const data = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    banner: typeof data.banner === "string" ? data.banner : null,
    renderedHtml: asString(data.renderedHtml),
    version: asNumber(data.version) ?? 0,
    versionStatus: asString(data.versionStatus, "DRAFT"),
    templateName: asString(data.templateName),
    mappingSource: asString(data.mappingSource),
    mappingSummary: {
      total: asNumber((data.mappingSummary as Record<string, unknown> | undefined)?.total) ?? 0,
      mapped: asNumber((data.mappingSummary as Record<string, unknown> | undefined)?.mapped) ?? 0,
      required: asNumber((data.mappingSummary as Record<string, unknown> | undefined)?.required) ?? 0,
    },
    pageCount: asNumber(data.pageCount),
    fullName: typeof data.fullName === "string" ? data.fullName : null,
    cccd: typeof data.cccd === "string" ? data.cccd : null,
    unreplaced: [...new Set([...asArray(data.unreplaced), ...asArray(data.unresolved)])],
    missingFields: asArray(data.missingFields),
    valid: data.valid === true,
    currentPublishedVersion: asNumber(data.currentPublishedVersion),
    margins: (() => {
      const m = data.margins as Record<string, unknown> | undefined;
      const topMm = asNumber(m?.topMm);
      const bottomMm = asNumber(m?.bottomMm);
      const leftMm = asNumber(m?.leftMm);
      const rightMm = asNumber(m?.rightMm);
      return topMm !== null && bottomMm !== null && leftMm !== null && rightMm !== null
        ? { topMm, bottomMm, leftMm, rightMm }
        : null;
    })(),
  };
}

export function DraftVersionPreviewModal({
  templateId,
  templateName,
  version,
  onClose,
}: {
  templateId: string;
  templateName: string;
  version: PreviewVersionTarget;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<Candidate | null>(null);
  const [rendering, setRendering] = useState(false);
  const [result, setResult] = useState<PreviewResult | null>(null);
  // Preview-only, screen-media A4 sheet boundaries ("Trang N" labels) — never
  // fed back into the renderer; the canonical HTML used for the real merge/PDF
  // is untouched. See preview-a4-decoration.ts for why this is an approximation.
  const decoratedPreviewHtml = useMemo(
    () => (result ? decoratePreviewForA4Sheets(result.renderedHtml, result.margins) : ""),
    [result],
  );
  const [problem, setProblem] = useState<Problem | null>(null);
  // A4 PDF Preview (authoritative) — real Chromium-rendered PDF, shown via a
  // blob: URL. Independent of the Quick Preview's `result`/`problem` state
  // above so either mode can be used without needing the other first.
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfProblem, setPdfProblem] = useState<Problem | null>(null);
  const pdfUrlRef = useRef<string | null>(null);
  /** The candidate id that produced the CURRENT renderedHtml (so the print view
   *  never drifts if the operator picks another candidate without re-rendering). */
  const [previewApplicationId, setPreviewApplicationId] = useState<string | null>(null);
  const [signingContext, setSigningContext] = useState<SigningContextInput>(EMPTY_SIGNING_CONTEXT_INPUT);
  /** The Signing Context that actually produced the CURRENT renderedHtml (for the print view). */
  const [renderedSigningContext, setRenderedSigningContext] = useState<SigningContextInput>(EMPTY_SIGNING_CONTEXT_INPUT);
  const searchSeq = useRef(0);

  const isDraft = version.status !== "PUBLISHED";

  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) {
      setCandidates([]);
      return;
    }
    const seq = ++searchSeq.current;
    const timer = setTimeout(() => {
      setSearching(true);
      fetch(`/api/document-merge/candidates?q=${encodeURIComponent(term)}`, { cache: "no-store" })
        .then((res) => res.json())
        .then((data: unknown) => {
          if (seq !== searchSeq.current) return;
          const rows = (data as { rows?: unknown })?.rows;
          setCandidates(Array.isArray(rows) ? (rows as Candidate[]) : []);
        })
        .catch(() => {
          if (seq === searchSeq.current) setCandidates([]);
        })
        .finally(() => {
          if (seq === searchSeq.current) setSearching(false);
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  const runPreview = async () => {
    if (!selected) {
      setProblem({ code: "APPLICATION_REQUIRED", error: "Chọn một ứng viên trước khi tạo bản xem trước." });
      return;
    }
    setRendering(true);
    setProblem(null);
    try {
      const res = await fetch(
        `/api/document-merge/templates/${templateId}/versions/${version.id}/preview`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ applicationId: selected.id, signingContext: signingContextBody(signingContext) }),
        },
      );
      let data: Record<string, unknown> = {};
      try {
        const parsed: unknown = await res.json();
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          data = parsed as Record<string, unknown>;
        }
      } catch {
        data = {};
      }
      if (!res.ok) {
        setResult(null);
        setPreviewApplicationId(null);
        setProblem({
          code: asString(data.code, `HTTP_${res.status}`),
          error: asString(data.error, "Không tạo được bản xem trước."),
          action: typeof data.action === "string" ? data.action : undefined,
          details: typeof data.details === "string" ? data.details : undefined,
        });
        return;
      }
      setResult(normalize(data));
      // Remember WHICH candidate produced this preview so the print view always
      // targets the document actually on screen, never a later selection.
      setPreviewApplicationId(selected.id);
      // Same for Signing Context — the print view must reuse the EXACT values
      // that produced the on-screen render, not whatever is in the inputs now.
      setRenderedSigningContext(signingContext);
    } catch (error) {
      setResult(null);
      setPreviewApplicationId(null);
      setProblem({
        code: "NETWORK_ERROR",
        error: "Không kết nối được tới API xem trước.",
        details: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setRendering(false);
    }
  };

  // Revoke any blob: URL still held when the modal unmounts, so we never
  // leak memory across repeated opens.
  useEffect(() => {
    return () => {
      if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
    };
  }, []);

  /**
   * "Xem trước PDF A4" — AUTHORITATIVE preview. Calls the SAME
   * renderCanonicalDocument() snapshot resolution as Quick Preview, then
   * hands that HTML to the worker's real Chromium page.pdf() (see
   * preview-pdf/route.ts). Never persists anything — the PDF is only ever
   * held client-side as a blob: URL, discarded on the next render or on
   * unmount.
   */
  const runPdfPreview = async () => {
    if (!selected) {
      setPdfProblem({ code: "APPLICATION_REQUIRED", error: "Chọn một ứng viên trước khi tạo bản xem trước." });
      return;
    }
    setPdfLoading(true);
    setPdfProblem(null);
    try {
      const res = await fetch(
        `/api/document-merge/templates/${templateId}/versions/${version.id}/preview-pdf`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ applicationId: selected.id, signingContext: signingContextBody(signingContext) }),
        },
      );
      if (!res.ok) {
        let data: Record<string, unknown> = {};
        try {
          const parsed: unknown = await res.json();
          if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
        } catch {
          data = {};
        }
        if (pdfUrlRef.current) {
          URL.revokeObjectURL(pdfUrlRef.current);
          pdfUrlRef.current = null;
        }
        setPdfUrl(null);
        setPdfProblem({
          code: asString(data.code, `HTTP_${res.status}`),
          error: asString(data.error, "Không tạo được PDF xem trước."),
          action: typeof data.action === "string" ? data.action : undefined,
          details: typeof data.details === "string" ? data.details : undefined,
        });
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      if (pdfUrlRef.current) URL.revokeObjectURL(pdfUrlRef.current);
      pdfUrlRef.current = url;
      setPdfUrl(url);
    } catch (error) {
      if (pdfUrlRef.current) {
        URL.revokeObjectURL(pdfUrlRef.current);
        pdfUrlRef.current = null;
      }
      setPdfUrl(null);
      setPdfProblem({
        code: "NETWORK_ERROR",
        error: "Không kết nối được tới API xem trước PDF.",
        details: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPdfLoading(false);
    }
  };

  /**
   * TEST PDF / MỞ BẢN IN.
   *
   * The previous implementation called `iframe.contentWindow.print()` on a
   * `sandbox="allow-modals"` iframe. A sandboxed iframe is an OPAQUE origin, so
   * the parent page is cross-origin relative to it and `print()` is NOT a
   * cross-origin-allowed member — the call throws a SecurityError and the button
   * has no effect. Chrome Android also does not reliably print a nested iframe.
   *
   * So both buttons open a TOP-LEVEL print-only view in a new tab: the browser
   * owns that document and `window.print()` opens the native dialog for the
   * Preview document on desktop Chrome AND Chrome Android, never the admin page.
   * The view is the SAME canonical renderer output the iframe displays (the
   * print route re-renders it from the explicit templateId/versionId/applicationId),
   * and it performs no DB write, no job, no publish, no Google Docs fallback.
   *
   * - "In / Lưu PDF TEST" opens the view with autoprint → dialog opens directly.
   * - "Mở bản in" opens the same view without autoprint → operator taps the
   *   in-page "In / Lưu PDF" button (the mobile-safe fallback if the browser
   *   blocks programmatic print on load).
   */
  const openPrintView = (autoPrint: boolean) => {
    if (!canOpenPrintView(result, previewApplicationId, selected?.id)) return;
    const applicationId = previewApplicationId ?? selected?.id;
    if (!applicationId) return;
    const url = buildPrintViewUrl({
      templateId,
      versionId: version.id,
      applicationId,
      autoPrint,
      signingContext: signingContextBody(renderedSigningContext),
    });
    window.open(url, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4">
      <div className="w-full max-w-5xl rounded-2xl bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 p-4">
          <div className="min-w-0">
            <h3 className="flex items-center gap-2 text-sm font-bold text-slate-900">
              <Eye className="h-4 w-4" /> Xem trước phiên bản tài liệu
            </h3>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
              <dt className="text-slate-400">Template</dt>
              <dd className="truncate font-semibold text-slate-800">{templateName}</dd>
              <dt className="text-slate-400">Version</dt>
              <dd className="font-semibold text-slate-800">v{version.version}</dd>
              <dt className="text-slate-400">Status</dt>
              <dd>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                    isDraft ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-700"
                  }`}
                >
                  {version.status}
                </span>
              </dd>
            </dl>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Đóng"
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {isDraft && (
          <p className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-center text-xs font-extrabold tracking-wide text-amber-900">
            BẢN XEM TRƯỚC — CHƯA XUẤT BẢN
          </p>
        )}

        <div className="space-y-4 p-4">
          <p className="rounded-lg bg-slate-50 p-2.5 text-[11px] text-slate-600">
            Thao tác này <b>không xuất bản</b> phiên bản, không đổi phiên bản đang publish, không tạo job
            trộn tài liệu và không sửa dữ liệu ứng viên. Bản nháp lấy mapping từ{" "}
            <b>merge_template_fields hiện tại</b> (mapping_snapshot của DRAFT luôn rỗng cho tới khi Xuất bản);
            phiên bản đã xuất bản vẫn dùng snapshot đóng băng của chính nó.
          </p>

          <div>
            <label className="text-[11px] font-semibold text-slate-600" htmlFor="draft-preview-candidate">
              Chọn / tìm ứng viên có thật (tên, CCCD hoặc số điện thoại)
            </label>
            <div className="relative mt-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input
                id="draft-preview-candidate"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Ví dụ: Trần Văn Dũng"
                className="w-full rounded-lg border border-slate-300 py-2 pl-9 pr-3 text-xs outline-none focus:border-emerald-600"
              />
            </div>
            {searching && <p className="mt-1 text-[11px] text-slate-400">Đang tìm...</p>}
            {candidates.length > 0 && (
              <ul className="mt-2 max-h-44 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
                {candidates.map((row) => (
                  <li key={row.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(row)}
                      className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs hover:bg-emerald-50 ${
                        selected?.id === row.id ? "bg-emerald-50" : "bg-white"
                      }`}
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-semibold text-slate-800">{row.fullName}</span>
                        <span className="block truncate font-mono text-[10px] text-slate-500">
                          {row.cccd}
                          {row.deptName ? ` · ${row.deptName}` : ""}
                        </span>
                      </span>
                      {selected?.id === row.id && (
                        <span className="shrink-0 rounded-full bg-emerald-600 px-2 py-0.5 text-[10px] font-bold text-white">
                          Đã chọn
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {query.trim().length >= 2 && !searching && candidates.length === 0 && (
              <p className="mt-1 text-[11px] text-slate-400">
                Không tìm thấy ứng viên nào trong phạm vi dữ liệu của bạn.
              </p>
            )}
          </div>

          <div className="rounded-lg border border-slate-200 p-3">
            <p className="text-[11px] font-semibold text-slate-600">Thông tin tạo tài liệu (Signing Context)</p>
            <p className="mt-0.5 text-[10px] text-slate-400">
              Dùng cho các placeholder tính toán (Ngay_ky_day/month/year, Dia_diem_ky, Nam_thue, Ngay_tiep_nhan...).
              Chỉ cần điền khi mẫu có mapping COMPUTED.
            </p>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <label className="text-[10px] text-slate-500">
                Ngày ký
                <input
                  type="date"
                  value={signingContext.signingDate}
                  onChange={(e) => setSigningContext((s) => ({ ...s, signingDate: e.target.value }))}
                  className="mt-0.5 w-full rounded border border-slate-200 px-2 py-1.5 text-xs"
                />
              </label>
              <label className="text-[10px] text-slate-500">
                Địa điểm ký
                <input
                  value={signingContext.signingLocation}
                  onChange={(e) => setSigningContext((s) => ({ ...s, signingLocation: e.target.value }))}
                  placeholder="vd: Đà Lạt"
                  className="mt-0.5 w-full rounded border border-slate-200 px-2 py-1.5 text-xs"
                />
              </label>
              <label className="text-[10px] text-slate-500">
                Ngày tiếp nhận
                <input
                  type="date"
                  value={signingContext.receivedDate}
                  onChange={(e) => setSigningContext((s) => ({ ...s, receivedDate: e.target.value }))}
                  className="mt-0.5 w-full rounded border border-slate-200 px-2 py-1.5 text-xs"
                />
              </label>
              <label className="text-[10px] text-slate-500">
                Người tiếp nhận
                <input
                  value={signingContext.receivedBy}
                  onChange={(e) => setSigningContext((s) => ({ ...s, receivedBy: e.target.value }))}
                  className="mt-0.5 w-full rounded border border-slate-200 px-2 py-1.5 text-xs"
                />
              </label>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void runPdfPreview()}
              disabled={pdfLoading || !selected}
              title="Render PDF thật qua Chromium (đúng cấu hình worker HTML_PDF dùng cho merge thật) — phân trang, whitespace, chữ ký đúng như bản merge thật."
              className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-700 px-4 py-2 text-xs font-bold text-white hover:bg-indigo-800 disabled:opacity-50"
            >
              <FileText className="h-3.5 w-3.5" /> {pdfLoading ? "Đang render PDF..." : "Xem trước PDF A4"}
            </button>
            <button
              type="button"
              onClick={() => void runPreview()}
              disabled={rendering || !selected}
              title="Bản xem nhanh, gần đúng (HTML/CSS trên màn hình thường) — không phân trang thật như PDF. Dùng để xem nhanh khi đang sửa mapping, không dùng để duyệt mẫu."
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              <FileWarning className="h-3.5 w-3.5" /> {rendering ? "Đang dựng bản xem nhanh..." : "Xem nhanh (gần đúng)"}
            </button>
            {hasRenderedPreview(result) && (
              <>
                <button
                  type="button"
                  onClick={() => openPrintView(true)}
                  title="Mở hộp thoại in của trình duyệt trên chính bản xem nhanh (In / Lưu thành PDF TEST). Không tạo file trên máy chủ, không tạo job, không publish."
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  <Printer className="h-3.5 w-3.5" /> In / Lưu PDF TEST
                </button>
                <button
                  type="button"
                  onClick={() => openPrintView(false)}
                  title="Mở một bản in (print-only view) của chính bản xem nhanh trong tab riêng, rồi dùng Print / Save as PDF của trình duyệt. Đây là đường chạy tin cậy trên Chrome Android và khi trình duyệt chặn print tự động."
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                >
                  <ExternalLink className="h-3.5 w-3.5" /> Mở bản in
                </button>
              </>
            )}
            {selected && (
              <span className="text-[11px] text-slate-500">
                Ứng viên: <b className="text-slate-700">{selected.fullName}</b>
              </span>
            )}
          </div>

          {pdfProblem && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800">
              <p className="flex items-center gap-1.5 font-bold">
                <AlertTriangle className="h-3.5 w-3.5" /> {pdfProblem.error}
              </p>
              {pdfProblem.action && <p className="mt-1 text-red-700">{pdfProblem.action}</p>}
              <p className="mt-1 font-mono text-[10px] text-red-500">{pdfProblem.code}</p>
            </div>
          )}

          {pdfUrl && (
            <div className="space-y-2">
              <p className="rounded-lg bg-indigo-50 p-2 text-[11px] font-semibold text-indigo-800">
                PDF A4 thật — render qua Chromium bằng đúng cấu hình worker HTML_PDF dùng cho merge thật. Đây là bản
                dùng để duyệt mẫu.
              </p>
              <iframe
                title="Xem trước PDF A4 (chính thức)"
                src={pdfUrl}
                className="h-[700px] w-full rounded-lg border border-indigo-200"
              />
            </div>
          )}

          {problem && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800">
              <p className="flex items-center gap-1.5 font-bold">
                <AlertTriangle className="h-3.5 w-3.5" /> {problem.error}
              </p>
              {problem.action && <p className="mt-1 text-red-700">{problem.action}</p>}
              <p className="mt-1 font-mono text-[10px] text-red-500">{problem.code}</p>
            </div>
          )}

          {result && (
            <div className="space-y-2">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg bg-slate-50 p-3 text-[11px] sm:grid-cols-4">
                <dt className="text-slate-400">Ứng viên</dt>
                <dd className="truncate font-semibold text-slate-800">{result.fullName ?? "—"}</dd>
                <dt className="text-slate-400">Số trang</dt>
                <dd className="font-semibold text-slate-800">{result.pageCount ?? "—"}</dd>
                <dt className="text-slate-400">Mapping</dt>
                <dd className="font-semibold text-slate-800">
                  {result.mappingSummary.mapped}/{result.mappingSummary.total}
                </dd>
                <dt className="text-slate-400">Nguồn mapping</dt>
                <dd className="truncate font-mono text-[10px] text-slate-600">{result.mappingSource}</dd>
              </dl>
              {(result.unreplaced.length > 0 || result.missingFields.length > 0) && (
                <p className="rounded-lg bg-amber-50 p-2 text-[11px] text-amber-800">
                  Placeholder chưa thay / trường thiếu:{" "}
                  {[...new Set([...result.unreplaced, ...result.missingFields])].join(", ")}
                </p>
              )}
              <p className="text-[10px] text-slate-400">
                Xem trước bên dưới đóng khung từng trang theo tỉ lệ A4 để dễ phân biệt — đây là bản{" "}
                <b>GẦN ĐÚNG</b> (trình duyệt không phân trang khi hiển thị màn hình thường như khi in thật). Nếu một
                trang bị tràn nội dung dài hơn 1 trang A4 thật, số trang và vị trí ngắt trang ở đây sẽ khác PDF thật.
                Dùng <b>Xem trước PDF A4</b> ở trên để duyệt mẫu — đó mới là nguồn xác thực cuối cùng.
              </p>
              <iframe
                id="draft-preview-frame"
                title={`Bản xem trước v${result.version}`}
                sandbox="allow-modals"
                srcDoc={decoratedPreviewHtml}
                className="h-[600px] w-full rounded-lg border border-slate-200 bg-slate-500"
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
