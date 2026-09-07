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
 * 2. DraftVersionEditorModal — "Sửa HTML/CSS" cho version DRAFT. Luôn nạp
 *    đúng nội dung của versionId tường minh đang sửa (KHÔNG BAO GIỜ đọc
 *    current_published_version, KHÔNG tạo version mới) — workflow tối giản
 *    cho operator: HTML hiện tại + Print CSS hiện tại → Lưu bản nháp →
 *    Xem trước A4 → sửa tiếp → Lưu lại NHIỀU LẦN trong cùng một phiên mở
 *    (Lưu thành công KHÔNG đóng modal — baseline được nâng lên đúng nội dung
 *    vừa ghi) — H1 mode ("HTML / CSS nâng cao", MẶC ĐỊNH
 *    khi mở): 2 textarea HTML body + Print CSS, useState khởi tạo thẳng từ
 *    version.htmlBody/printCss, PATCH về endpoint version detail ("Lưu bản
 *    nháp", không revalidate). H2 mode ("Dán HTML hoàn chỉnh", dành cho
 *    người dùng không rành kỹ thuật, đổi tab bằng nút bấm) khởi đầu RỖNG (là
 *    một paste TARGET) nhưng có nút "Nạp HTML hiện tại" — composeFullHtmlDocument()
 *    trong draft-editor-preload.ts — để nạp sẵn html_body+print_css hiện có
 *    của bản nháp vào ô dán, sửa tiếp thay vì dán mới từ đầu: dán/nạp MỘT tài
 *    liệu HTML hoàn chỉnh -> Phân tích (POST ai-analyze, đã mở rộng
 *    normalize+hash) -> Xem trước CHƯA LƯU với ứng viên thật (POST
 *    unsaved-preview, zero DB writes) -> mở bản in TEST (POST unsaved-print,
 *    hidden-form-submit-to-new-tab) -> Áp dụng vào bản nháp (POST apply-html:
 *    revalidate lại toàn bộ server-side, ghi ĐÚNG MỘT version DRAFT, không
 *    đổi mapping/publish). Server reject (409) nếu version đã rời DRAFT hoặc
 *    nội dung đã đổi sau lần Phân tích gần nhất. Nút "Khôi phục nội dung đã
 *    lưu" (chỉ local, KHÔNG gọi API) bỏ mọi sửa đổi CHƯA LƯU ở cả hai mode và
 *    nạp lại đúng nội dung DRAFT lúc mở editor; đóng editor (nút X hoặc Hủy)
 *    khi có sửa đổi CHƯA LƯU sẽ hỏi xác nhận trước (isDraftEditorDirty()).
 *    "Xem trước A4" LUÔN khả dụng (không cần Phân tích trước): render ĐÚNG
 *    HTML/CSS đang soạn — kể cả CHƯA Lưu, CHƯA Publish — với dữ liệu một ứng
 *    viên thật (unsaved-preview, zero DB writes), đóng khung trang A4; ghi rõ
 *    preview chỉ GẦN ĐÚNG, "In / Lưu PDF TEST" mới là kết quả chuẩn.
 *
 * 2b. VersionHtmlViewerModal — "Xem HTML/CSS" CHỈ ĐỌC cho version
 *    PUBLISHED/ARCHIVED (những version không bao giờ có nút sửa). Hiển thị
 *    đúng html_body/print_css ĐÃ LƯU của versionId được chọn — dữ liệu đã có
 *    sẵn trong danh sách phiên bản nên viewer KHÔNG gọi API, KHÔNG ghi DB.
 *    Muốn sửa: "Tạo bản nháp từ phiên bản này" rồi mở editor trên bản DRAFT.
 *
 * 3. ApplyToDraftConfirmModal — xác nhận trước khi Áp dụng, văn bản cố định
 *    nhắc rõ: đang sửa BẢN NHÁP, phiên bản đang xuất bản KHÔNG đổi, thao tác
 *    KHÔNG xuất bản.
 *
 * 4. VersionDeleteConfirmModal — xác nhận "Xóa bản nháp" (xoá VĨNH VIỄN một
 *    version DRAFT). Hiển thị rõ tên mẫu + số version + cảnh báo không thể
 *    hoàn tác; liệt kê các bất biến (PUBLISHED không đổi, mapping dùng chung
 *    không mất, PDF/job/history của version khác không bị xoá).
 *    API gọi: DELETE /api/document-merge/templates/:id/versions/:vid
 *    (server re-read trong transaction + guard status='DRAFT' trong WHERE —
 *    PUBLISHED/ARCHIVED bị từ chối kể cả khi gọi API trực tiếp).
 *
 * Không dialog nào ở đây publish bất cứ gì — publishing vẫn đi qua workflow
 * hiện có ([Xuất bản phiên bản] → publishTemplateVersion freeze mapping
 * snapshot).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { decoratePreviewForA4Sheets } from "@/lib/document-merge/preview-a4-decoration";
import { composeFullHtmlDocument, isDraftEditorDirty } from "@/lib/document-merge/draft-editor-preload";
import { normalizeFullHtmlDocument } from "@/lib/document-merge/full-document-normalizer";
import {
  AlertTriangle,
  CheckCircle2,
  CheckSquare,
  ClipboardPaste,
  Code2,
  Copy,
  Eye,
  ExternalLink,
  FileCode2,
  FileDown,
  Printer,
  RotateCcw,
  Save,
  Search,
  Trash2,
  X,
} from "lucide-react";

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
 * 1b. DELETE DRAFT CONFIRM — "Xóa bản nháp" (xoá vĩnh viễn)
 * ------------------------------------------------------------------ */

export type VersionDeleteTarget = {
  id: string;
  version: number;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
};

export function VersionDeleteConfirmModal({
  templateName,
  version,
  onCancel,
  onConfirm,
  deleting,
}: {
  templateName: string;
  version: VersionDeleteTarget;
  onCancel: () => void;
  onConfirm: () => void;
  deleting: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="rounded-lg bg-red-50 p-2 text-red-600">
              <Trash2 className="h-4 w-4" />
            </span>
            <h3 className="text-sm font-bold text-slate-900">
              Xóa vĩnh viễn bản nháp v{version.version}?
            </h3>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={deleting}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-50"
            aria-label="Đóng"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="mt-3 text-[11px] text-slate-500">
          Mẫu <span className="font-semibold text-slate-700">{templateName}</span> · phiên bản{" "}
          <b>v{version.version}</b> ({version.status}).
        </p>

        <div className="mt-3 flex gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-[11px] font-semibold leading-relaxed text-red-700">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          Thao tác này xóa vĩnh viễn bản nháp và không thể hoàn tác.
        </div>

        <ul className="mt-3 space-y-1.5 rounded-xl bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-600">
          <li>• Phiên bản <b>PUBLISHED hiện tại không bị thay đổi</b> — merge production vẫn chạy bình thường.</li>
          <li>• <b>Mapping dùng chung</b> của mẫu (mọi phiên bản) được giữ nguyên.</li>
          <li>• PDF / merge job / lịch sử và <b>mapping snapshot của các phiên bản khác</b> không bị xoá hay thay đổi.</li>
          <li>• Chỉ version DRAFT mới xoá được — server từ chối nếu version đã đổi trạng thái.</li>
        </ul>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={deleting}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Hủy
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={deleting}
            className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-4 py-2 text-xs font-bold text-white hover:bg-red-700 disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {deleting ? "Đang xoá..." : "Xóa vĩnh viễn"}
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
  /** A4 print margins (mm, Phase 4) — DRAFT-editable, frozen once published. */
  marginTopMm: number;
  marginBottomMm: number;
  marginLeftMm: number;
  marginRightMm: number;
};

/** Shape of POST .../ai-analyze's JSON response — READ-ONLY, never mutates anything. */
type AnalyzeResult = {
  htmlValid: boolean;
  htmlIssues: { message: string }[];
  cssValid: boolean;
  cssIssues: { message: string }[];
  placeholders: { total: number; unchanged: number; added: number; removed: number };
  mappingsAffected: number;
  security: { errors: { code: string; message: string }[]; warnings: { code: string; message: string }[] };
  layoutWarnings: { code: string; message: string }[];
  baseVersion: number;
  baseVersionStatus: string;
  // H2 — full-document paste additions.
  normalizationWarnings: { code: string; message: string; href?: string }[];
  externalResourceWarnings: { code: string; message: string; href?: string }[];
  analysisHash: string;
};

/** H2 — "Dán HTML hoàn chỉnh" cho phép dán CẢ tài liệu; "HTML / CSS nâng cao" là editor tách sẵn có (H1). */
type PasteMode = "paste" | "advanced";

type PreviewCandidate = { id: string; fullName: string; cccd: string; phone: string; deptName: string | null };

/** Shape of POST .../unsaved-preview's JSON response — CHƯA LƯU, zero DB writes. */
type UnsavedPreviewResult = {
  renderedHtml: string;
  pageCount: number | null;
  mappingSummary: { total: number; mapped: number; required: number };
  fullName: string | null;
  cccd: string | null;
  unreplaced: string[];
  missingFields: string[];
  valid: boolean;
  /** H2 fix (Defect A): clear, non-null when >=1 placeholder has no mapping at all. */
  unresolvedPlaceholderWarning: string | null;
  /** Phase 5 — same margin config the final PDF used (see preview-a4-decoration.ts). */
  margins: { topMm: number; bottomMm: number; leftMm: number; rightMm: number } | null;
};

const asPreviewString = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);
const asPreviewArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const asPreviewNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

function normalizeUnsavedPreview(raw: unknown): UnsavedPreviewResult {
  const data = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const mappingSummary = data.mappingSummary as Record<string, unknown> | undefined;
  return {
    renderedHtml: asPreviewString(data.renderedHtml),
    pageCount: asPreviewNumber(data.pageCount),
    mappingSummary: {
      total: asPreviewNumber(mappingSummary?.total) ?? 0,
      mapped: asPreviewNumber(mappingSummary?.mapped) ?? 0,
      required: asPreviewNumber(mappingSummary?.required) ?? 0,
    },
    fullName: typeof data.fullName === "string" ? data.fullName : null,
    cccd: typeof data.cccd === "string" ? data.cccd : null,
    unreplaced: [...new Set([...asPreviewArray(data.unreplaced), ...asPreviewArray(data.unresolved)])],
    missingFields: asPreviewArray(data.missingFields),
    valid: data.valid === true,
    unresolvedPlaceholderWarning: typeof data.unresolvedPlaceholderWarning === "string" ? data.unresolvedPlaceholderWarning : null,
    margins: (() => {
      const m = data.margins as Record<string, unknown> | undefined;
      const topMm = asPreviewNumber(m?.topMm);
      const bottomMm = asPreviewNumber(m?.bottomMm);
      const leftMm = asPreviewNumber(m?.leftMm);
      const rightMm = asPreviewNumber(m?.rightMm);
      return topMm !== null && bottomMm !== null && leftMm !== null && rightMm !== null
        ? { topMm, bottomMm, leftMm, rightMm }
        : null;
    })(),
  };
}

/**
 * H3 — "Thông tin tạo tài liệu" (Signing Context, Phase 16). Same shape and
 * once-per-render-call contract as draft-version-preview-modal.tsx.
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

/**
 * Hidden-form-submit-to-new-tab (Phase 8): a top-level `window.print()` opens
 * the native dialog reliably (desktop + Chrome Android); `iframe.contentWindow
 * .print()` on a sandboxed iframe throws (opaque cross-origin). Pasted HTML
 * can be too large for a GET query string, so this POSTs a real <form> —
 * never persists anything, never a fetch+blob download.
 */
function submitUnsavedPrintForm(url: string, fields: Record<string, string>) {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = url;
  form.target = "_blank";
  form.style.display = "none";
  for (const [name, value] of Object.entries(fields)) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
  document.body.removeChild(form);
}

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

  // A4 PRINT MARGINS (Phase 4) — DRAFT-editable, same Save/PATCH flow as
  // html/css. `version.status !== "DRAFT"` disables the inputs entirely
  // (server-side guard is the real enforcement — see updateTemplateVersionDraft).
  const [marginTopMm, setMarginTopMm] = useState(version.marginTopMm);
  const [marginBottomMm, setMarginBottomMm] = useState(version.marginBottomMm);
  const [marginLeftMm, setMarginLeftMm] = useState(version.marginLeftMm);
  const [marginRightMm, setMarginRightMm] = useState(version.marginRightMm);
  const [baselineMarginTopMm, setBaselineMarginTopMm] = useState(version.marginTopMm);
  const [baselineMarginBottomMm, setBaselineMarginBottomMm] = useState(version.marginBottomMm);
  const [baselineMarginLeftMm, setBaselineMarginLeftMm] = useState(version.marginLeftMm);
  const [baselineMarginRightMm, setBaselineMarginRightMm] = useState(version.marginRightMm);
  const marginsDirty =
    marginTopMm !== baselineMarginTopMm ||
    marginBottomMm !== baselineMarginBottomMm ||
    marginLeftMm !== baselineMarginLeftMm ||
    marginRightMm !== baselineMarginRightMm;

  /**
   * Baseline = nội dung DRAFT ĐÃ LƯU mà editor đang dựa vào. Khởi tạo THẲNG
   * từ html_body/print_css của chính versionId được mở (không bao giờ từ
   * current_published_version, không tạo version mới). Nằm trong STATE (không
   * derive từ prop) để sau mỗi lần ghi thành công ("Lưu bản nháp" / "Áp dụng
   * vào bản nháp") baseline được NÂNG lên đúng nội dung vừa ghi mà không cần
   * remount modal — đó chính là cơ chế giữ modal mở sau khi Save để operator
   * tiếp tục sửa → Xem trước A4 → Lưu lại nhiều lần trên cùng một versionId.
   */
  const [baselineHtml, setBaselineHtml] = useState(version.htmlBody ?? "");
  const [baselineCss, setBaselineCss] = useState(version.printCss ?? "");
  /** Thông báo "đã lưu thành công" — chỉ hiện khi KHÔNG còn sửa đổi chưa lưu. */
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  // H2 — "Dán HTML hoàn chỉnh" (paste ONE complete AI-generated document) vs
  // "HTML / CSS nâng cao" (H1's existing split editor, above). Both modes feed
  // the SAME Analyze -> Preview -> Apply pipeline below via `effectiveHtml`/
  // `effectiveCss` — the server normalizer treats a bare fragment (advanced
  // mode) as a pass-through, so nothing about the advanced editor changes.
  // Default to "advanced": html/css are ALREADY preloaded from the explicit
  // DRAFT `version` prop below — opening straight into "paste" (an empty
  // paste TARGET, by design) hid that preloaded content behind a tab click,
  // which is exactly what read as "the editor is empty" to an operator.
  const [mode, setMode] = useState<PasteMode>("advanced");
  const [rawPaste, setRawPaste] = useState("");
  const effectiveHtml = mode === "paste" ? rawPaste : html;
  const effectiveCss = mode === "paste" ? "" : css;

  // Preload / unsaved-changes tracking. "HTML / CSS nâng cao" is preloaded
  // from the explicit DRAFT `version` prop (html/css + baselines seeded via
  // useState above — never from current_published_version). Baselines live in
  // state (see comment there) so a successful save advances them in place —
  // save → keep editing → save again, modal never remounts.
  // `baselineRawPaste` tracks the paste box separately: it starts
  // empty (paste mode is a paste TARGET, not auto-filled) and only advances
  // when the operator explicitly loads content into it below, so a load
  // action itself never counts as a dirty edit.
  const [baselineRawPaste, setBaselineRawPaste] = useState("");
  const dirty = isDraftEditorDirty({ html, css, rawPaste, baselineHtml, baselineCss, baselineRawPaste }) || marginsDirty;
  /** "Đã lưu" chỉ đúng khi không còn gì chưa lưu — tự ẩn khi operator gõ tiếp. */
  const savedNoticeVisible = savedNotice !== null && !dirty;

  /** "Nạp HTML hiện tại" — compose one complete document from the DRAFT's
   * currently SAVED html_body + print_css into the paste box, for manual
   * editing. Never reads from the (possibly edited, unsaved) advanced-mode
   * textareas — always from the saved DRAFT content the modal was opened with. */
  const loadCurrentIntoPaste = () => {
    const composed = composeFullHtmlDocument(baselineHtml, baselineCss);
    setRawPaste(composed);
    setBaselineRawPaste(composed);
  };

  /** "Khôi phục nội dung đã lưu" — discard ALL local unsaved edits (both
   * modes) and reload the current DRAFT exactly as it was when this editor
   * opened. Local-only; makes no network request and writes nothing. */
  const restoreSavedContent = () => {
    setHtml(baselineHtml);
    setCss(baselineCss);
    setRawPaste("");
    setBaselineRawPaste("");
    setMarginTopMm(baselineMarginTopMm);
    setMarginBottomMm(baselineMarginBottomMm);
    setMarginLeftMm(baselineMarginLeftMm);
    setMarginRightMm(baselineMarginRightMm);
  };

  const requestClose = () => {
    if (dirty && !window.confirm("Có thay đổi CHƯA LƯU trong bản nháp. Đóng và bỏ các thay đổi này?")) {
      return;
    }
    onCancel();
  };

  // ANALYZE (H1, extended H2) — READ-ONLY: chỉ gọi POST ai-analyze để xem
  // impact, KHÔNG Apply/Save/Preview/Publish nội dung chưa lưu. Không tự chạy
  // lại khi nội dung đổi — operator chủ động bấm "Phân tích thay đổi".
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState<string | null>(null);
  const [analyzeResult, setAnalyzeResult] = useState<AnalyzeResult | null>(null);

  // H2 — UNSAVED Preview với ứng viên thật (Phase 6/7). Zero DB writes.
  const [candidateQuery, setCandidateQuery] = useState("");
  const [candidates, setCandidates] = useState<PreviewCandidate[]>([]);
  const [searchingCandidates, setSearchingCandidates] = useState(false);
  const [selectedCandidate, setSelectedCandidate] = useState<PreviewCandidate | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewResult, setPreviewResult] = useState<UnsavedPreviewResult | null>(null);
  // Preview-only, screen-media A4 sheet boundaries — see preview-a4-decoration.ts.
  const decoratedPreviewHtml = useMemo(
    () => (previewResult ? decoratePreviewForA4Sheets(previewResult.renderedHtml, previewResult.margins) : ""),
    [previewResult],
  );
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [signingContext, setSigningContext] = useState<SigningContextInput>(EMPTY_SIGNING_CONTEXT_INPUT);
  /** The Signing Context that actually produced the CURRENT previewResult (for print parity). */
  const [renderedSigningContext, setRenderedSigningContext] = useState<SigningContextInput>(EMPTY_SIGNING_CONTEXT_INPUT);
  const candidateSearchSeq = useRef(0);

  // H2 — Áp dụng vào bản nháp (Phase 9). Explicit confirmation, never automatic.
  const [showApplyConfirm, setShowApplyConfirm] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);

  useEffect(() => {
    const term = candidateQuery.trim();
    if (term.length < 2) {
      setCandidates([]);
      return;
    }
    const seq = ++candidateSearchSeq.current;
    const timer = setTimeout(() => {
      setSearchingCandidates(true);
      fetch(`/api/document-merge/candidates?q=${encodeURIComponent(term)}`, { cache: "no-store" })
        .then((res) => res.json())
        .then((data: unknown) => {
          if (seq !== candidateSearchSeq.current) return;
          const rows = (data as { rows?: unknown })?.rows;
          setCandidates(Array.isArray(rows) ? (rows as PreviewCandidate[]) : []);
        })
        .catch(() => {
          if (seq === candidateSearchSeq.current) setCandidates([]);
        })
        .finally(() => {
          if (seq === candidateSearchSeq.current) setSearchingCandidates(false);
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [candidateQuery]);

  const analyze = async () => {
    if (!effectiveHtml.trim()) {
      setAnalyzeError("Cần có nội dung HTML để phân tích.");
      return;
    }
    setAnalyzing(true);
    setAnalyzeError(null);
    // A fresh paste invalidates any earlier unsaved preview / apply readiness.
    setPreviewResult(null);
    setApplied(false);
    try {
      const res = await fetch(`/api/document-merge/templates/${templateId}/ai-analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ html: effectiveHtml, printCss: effectiveCss || null, baseVersionId: version.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Không phân tích được nội dung.");
      setAnalyzeResult(data as AnalyzeResult);
    } catch (err) {
      setAnalyzeError(err instanceof Error ? err.message : "Không phân tích được nội dung.");
      setAnalyzeResult(null);
    } finally {
      setAnalyzing(false);
    }
  };

  const runUnsavedPreview = async () => {
    if (!selectedCandidate) {
      setPreviewError("Chọn một ứng viên trước khi xem trước.");
      return;
    }
    if (!effectiveHtml.trim()) {
      setPreviewError("Cần có nội dung HTML để xem trước.");
      return;
    }
    setPreviewing(true);
    setPreviewError(null);
    try {
      const res = await fetch(
        `/api/document-merge/templates/${templateId}/versions/${version.id}/unsaved-preview`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            applicationId: selectedCandidate.id,
            rawHtml: effectiveHtml,
            explicitCss: effectiveCss,
            signingContext: signingContextBody(signingContext),
          }),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        setPreviewResult(null);
        throw new Error(data.error || "Không tạo được bản xem trước.");
      }
      setPreviewResult(normalizeUnsavedPreview(data));
      // Same contract as the persisted preview modal: freeze the Signing
      // Context that actually produced this render, for print parity below.
      setRenderedSigningContext(signingContext);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : "Không tạo được bản xem trước.");
    } finally {
      setPreviewing(false);
    }
  };

  const openUnsavedPrintView = (autoPrint: boolean) => {
    if (!selectedCandidate || !previewResult) return;
    submitUnsavedPrintForm(
      `/api/document-merge/templates/${templateId}/versions/${version.id}/unsaved-print`,
      {
        applicationId: selectedCandidate.id,
        rawHtml: effectiveHtml,
        explicitCss: effectiveCss,
        autoprint: autoPrint ? "1" : "0",
        ...signingContextBody(renderedSigningContext),
      },
    );
  };

  const applyToDraft = async () => {
    if (!analyzeResult) return;
    setApplying(true);
    setApplyError(null);
    try {
      const res = await fetch(
        `/api/document-merge/templates/${templateId}/versions/${version.id}/apply-html`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rawHtml: effectiveHtml, explicitCss: effectiveCss, analysisHash: analyzeResult.analysisHash }),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 409 && data.code === "STALE_ANALYSIS") {
          throw new Error(`${data.error} (bấm "Phân tích thay đổi" lại rồi thử áp dụng.)`);
        }
        // Phase 15/16: explain the SINGLE-DRAFT guard clearly — which
        // versions are ambiguous and what to do — never a bare generic error.
        if (res.status === 409 && data.code === "SINGLE_DRAFT_AMBIGUOUS") {
          const versions = Array.isArray(data.draftVersions) ? data.draftVersions.map((v: unknown) => `v${v}`).join(", ") : "";
          throw new Error(`${data.error}${versions ? ` (${versions})` : ""} ${data.action ?? ""}`.trim());
        }
        throw new Error(data.error || "Không áp dụng được vào bản nháp.");
      }
      // ÁP DỤNG XONG KHÔNG ĐÓNG MODAL — đồng bộ toàn bộ editor về đúng nội
      // dung đã được ghi. Server normalize y hệt (html_body = body tách ra,
      // print_css = explicitCss + <style> trừ ra) nên client tính lại bằng
      // CÙNG hàm normalizeFullHtmlDocument để baseline khớp từng byte; từ đó
      // vòng sửa → Xem trước A4 → Lưu/Áp dụng tiếp diễn trên cùng versionId.
      const normalized = normalizeFullHtmlDocument(effectiveHtml);
      const normalizedPrintCss = [effectiveCss, normalized.extractedCss]
        .filter((chunk): chunk is string => Boolean(chunk && chunk.trim()))
        .join("\n\n");
      setHtml(normalized.htmlBody);
      setCss(normalizedPrintCss);
      setRawPaste(effectiveHtml);
      setBaselineHtml(normalized.htmlBody);
      setBaselineCss(normalizedPrintCss);
      setBaselineRawPaste(effectiveHtml);
      setSavedNotice(`Đã áp dụng vào bản nháp v${version.version} — editor vẫn mở để sửa tiếp.`);
      setApplied(true);
      setShowApplyConfirm(false);
      onSaved(version.id);
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : "Không áp dụng được vào bản nháp.");
    } finally {
      setApplying(false);
    }
  };

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
          body: JSON.stringify({
            htmlBody: html,
            printCss: css || null,
            marginTopMm,
            marginBottomMm,
            marginLeftMm,
            marginRightMm,
          }),
        },
      );
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 409) setConflict(true);
        throw new Error(data.error || "Không lưu được bản nháp.");
      }
      // LƯU XONG KHÔNG ĐÓNG MODAL — chỉ nâng baseline lên đúng nội dung vừa
      // ghi. PATCH chỉ UPDATE html_body/print_css/margin của version DRAFT này
      // (server guard): mapping_snapshot, version number, templateId, status,
      // current_published_version và các version khác KHÔNG đổi. Operator
      // tiếp tục sửa → Xem trước A4 → Lưu lại bao nhiêu lần cũng được.
      setBaselineHtml(html);
      setBaselineCss(css);
      setBaselineMarginTopMm(marginTopMm);
      setBaselineMarginBottomMm(marginBottomMm);
      setBaselineMarginLeftMm(marginLeftMm);
      setBaselineMarginRightMm(marginRightMm);
      setSavedNotice(
        `Đã lưu bản nháp v${version.version} — editor vẫn mở: sửa tiếp, Xem trước A4 rồi Lưu lại khi cần.`,
      );
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
            onClick={requestClose}
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

        {savedNoticeVisible && (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-[11px] text-emerald-700">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            <p>{savedNotice}</p>
          </div>
        )}

        {/* H2 — Cập nhật Template bằng HTML: chọn giữa dán CẢ tài liệu (dành cho
            người dùng không rành kỹ thuật, có nút "Nạp HTML hiện tại" để nạp sẵn
            nội dung đang lưu) và editor tách HTML/CSS (H1, mặc định khi mở —
            đã nạp sẵn html_body/print_css của bản nháp đang sửa). */}
        <div className="mt-4 rounded-xl border border-slate-200 p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] font-bold text-slate-700">Cập nhật Template bằng HTML</p>
            <button
              type="button"
              onClick={restoreSavedContent}
              disabled={!dirty || conflict || saving}
              title="Bỏ mọi thay đổi CHƯA LƯU ở cả hai chế độ và tải lại đúng nội dung bản nháp hiện có trên server."
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-2.5 py-1 text-[10px] font-bold text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <RotateCcw className="h-3 w-3" /> Khôi phục nội dung đã lưu
            </button>
          </div>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => setMode("paste")}
              disabled={conflict || saving}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-bold ${
                mode === "paste" ? "bg-emerald-700 text-white" : "border border-slate-300 text-slate-600 hover:bg-slate-50"
              }`}
            >
              <ClipboardPaste className="h-3.5 w-3.5" /> Dán HTML hoàn chỉnh
            </button>
            <button
              type="button"
              onClick={() => setMode("advanced")}
              disabled={conflict || saving}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[11px] font-bold ${
                mode === "advanced" ? "bg-emerald-700 text-white" : "border border-slate-300 text-slate-600 hover:bg-slate-50"
              }`}
            >
              <Code2 className="h-3.5 w-3.5" /> HTML / CSS nâng cao
            </button>
          </div>

          {mode === "paste" ? (
            <div className="mt-3">
              <div className="flex items-center justify-between gap-2">
                <label className="text-[11px] font-semibold text-slate-600">
                  Dán toàn bộ nội dung HTML do AI tạo (cả tài liệu — bao gồm {"<html>"}, {"<style>"}, {"<body>"}):
                </label>
                <button
                  type="button"
                  onClick={loadCurrentIntoPaste}
                  disabled={conflict}
                  title="Tạo một tài liệu HTML hoàn chỉnh từ html_body + print_css hiện có của bản nháp này, để sửa trực tiếp thay vì dán mới."
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-[10px] font-bold text-emerald-700 hover:bg-emerald-100"
                >
                  <FileDown className="h-3 w-3" /> Nạp HTML hiện tại
                </button>
              </div>
              <textarea
                value={rawPaste}
                onChange={(e) => setRawPaste(e.target.value)}
                rows={16}
                spellCheck={false}
                disabled={conflict}
                placeholder={"<!DOCTYPE html>\n<html>\n<head><style>...</style></head>\n<body>...<<Ho_ten>>...</body>\n</html>"}
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-[11px] outline-none focus:border-emerald-600 disabled:bg-slate-50"
              />
              <span className="mt-1 block font-normal text-[10px] text-slate-400">
                Bấm <b>Nạp HTML hiện tại</b> để nạp sẵn nội dung bản nháp v{version.version} đang lưu (không tự
                nạp khi mở editor). Không cần tự tách HTML/CSS — hệ thống tự nhận diện thẻ {"<body>"} và các thẻ{" "}
                {"<style>"}. Stylesheet ngoài (link href) sẽ bị bỏ qua và báo trong kết quả phân tích, không bao giờ
                được tải về. Mặc định mọi bảng (table) có đường viền — nếu cần một bảng chỉ để canh layout (ví dụ
                khối chữ ký/ngày ký) KHÔNG hiển thị viền, thêm <code>class=&quot;no-border&quot;</code> vào thẻ{" "}
                {"<table>"} đó.
              </span>
            </div>
          ) : (
            <div className="mt-3 grid gap-3">
              <label className="text-[11px] font-semibold text-slate-600">
                HTML hiện tại (html_body của bản nháp v{version.version} — template in A4, chứa placeholder {"<<...>>"})
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
                Print CSS hiện tại (print_css — CSS A4 dùng chung khi in/PDF)
                <textarea
                  value={css}
                  onChange={(e) => setCss(e.target.value)}
                  rows={5}
                  spellCheck={false}
                  disabled={conflict || saving}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-[11px] outline-none focus:border-emerald-600 disabled:bg-slate-50"
                />
              </label>
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <p className="text-[11px] font-semibold text-slate-600">
                  Canh lề A4 (mm) — áp dụng cho cả Xem trước và PDF cuối cùng
                </p>
                <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <label className="text-[11px] font-medium text-slate-500">
                    Trên
                    <input
                      type="number"
                      min={0}
                      max={60}
                      step={1}
                      value={marginTopMm}
                      onChange={(e) => setMarginTopMm(Number(e.target.value))}
                      disabled={conflict || saving}
                      className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-[12px] outline-none focus:border-emerald-600 disabled:bg-slate-100"
                    />
                  </label>
                  <label className="text-[11px] font-medium text-slate-500">
                    Dưới
                    <input
                      type="number"
                      min={0}
                      max={60}
                      step={1}
                      value={marginBottomMm}
                      onChange={(e) => setMarginBottomMm(Number(e.target.value))}
                      disabled={conflict || saving}
                      className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-[12px] outline-none focus:border-emerald-600 disabled:bg-slate-100"
                    />
                  </label>
                  <label className="text-[11px] font-medium text-slate-500">
                    Trái
                    <input
                      type="number"
                      min={0}
                      max={60}
                      step={1}
                      value={marginLeftMm}
                      onChange={(e) => setMarginLeftMm(Number(e.target.value))}
                      disabled={conflict || saving}
                      className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-[12px] outline-none focus:border-emerald-600 disabled:bg-slate-100"
                    />
                  </label>
                  <label className="text-[11px] font-medium text-slate-500">
                    Phải
                    <input
                      type="number"
                      min={0}
                      max={60}
                      step={1}
                      value={marginRightMm}
                      onChange={(e) => setMarginRightMm(Number(e.target.value))}
                      disabled={conflict || saving}
                      className="mt-1 w-full rounded-lg border border-slate-300 px-2 py-1.5 text-[12px] outline-none focus:border-emerald-600 disabled:bg-slate-100"
                    />
                  </label>
                </div>
                <p className="mt-1.5 text-[10px] text-slate-400">
                  Mặc định 10/10/12/12mm. Chỉ áp dụng cho phiên bản DRAFT — sau khi Xuất bản, giá trị này bị khóa vĩnh viễn theo phiên bản.
                </p>
              </div>
              <div>
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={saving || conflict}
                  title="Lưu trực tiếp (PATCH) html_body + print_css + canh lề A4 của version DRAFT này. Không qua Phân tích/Áp dụng, KHÔNG tạo version mới, KHÔNG publish, KHÔNG đổi mapping. Sau khi lưu, editor vẫn mở để sửa tiếp."
                  className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-[11px] font-bold text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
                >
                  <Save className="h-3.5 w-3.5" />
                  {saving ? "Đang lưu..." : "Lưu bản nháp"}
                </button>
                <span className="ml-2 text-[10px] text-slate-400">
                  Lưu xong editor KHÔNG đóng — sửa tiếp → Xem trước A4 → Lưu lại nhiều lần.
                </span>
              </div>
            </div>
          )}
        </div>

        {/* XEM TRƯỚC A4 — LUÔN KHẢ DỤNG, không cần Phân tích trước (workflow
            tối giản: sửa → Lưu bản nháp → Xem trước A4 → sửa tiếp → Lưu lại).
            Render ĐÚNG HTML/CSS đang soạn ở trên — kể cả CHƯA Lưu, CHƯA Publish
            — với dữ liệu một ứng viên thật (unsaved-preview: zero DB writes,
            không tạo job, không publish, không đổi current_published_version),
            đóng khung trang A4 chỉ để MÔ PHỎNG trên màn hình. */}
        <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3">
          <p className="text-[11px] font-bold text-slate-700">Xem trước A4 (chưa lưu)</p>
          <p className="mt-1 text-[10px] text-slate-400">
            Dùng ĐÚNG HTML/CSS đang soạn ở trên — kể cả khi CHƯA bấm Lưu bản nháp và CHƯA Publish — render với
            dữ liệu thật của một ứng viên để kiểm tra xuống dòng/bảng/chữ ký. Preview chỉ MÔ PHỎNG trang A4, là
            bản <b>GẦN ĐÚNG</b>; <b>In / Lưu PDF TEST</b> (sau khi preview) mới là <b>KẾT QUẢ CHUẨN</b>.
          </p>

            <div className="relative mt-2">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input
                value={candidateQuery}
                onChange={(e) => setCandidateQuery(e.target.value)}
                placeholder="Tìm ứng viên: tên, CCCD hoặc số điện thoại"
                className="w-full rounded-lg border border-slate-300 py-2 pl-9 pr-3 text-xs outline-none focus:border-emerald-600"
              />
            </div>
            {searchingCandidates && <p className="mt-1 text-[11px] text-slate-400">Đang tìm...</p>}
            {candidates.length > 0 && (
              <ul className="mt-2 max-h-36 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200 bg-white">
                {candidates.map((row) => (
                  <li key={row.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedCandidate(row)}
                      className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs hover:bg-emerald-50 ${
                        selectedCandidate?.id === row.id ? "bg-emerald-50" : "bg-white"
                      }`}
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-semibold text-slate-800">{row.fullName}</span>
                        <span className="block truncate font-mono text-[10px] text-slate-500">
                          {row.cccd}
                          {row.deptName ? ` · ${row.deptName}` : ""}
                        </span>
                      </span>
                      {selectedCandidate?.id === row.id && (
                        <span className="shrink-0 rounded-full bg-emerald-600 px-2 py-0.5 text-[10px] font-bold text-white">Đã chọn</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-3 rounded-lg border border-slate-200 bg-white p-2.5">
              <p className="text-[11px] font-semibold text-slate-600">Thông tin tạo tài liệu (Signing Context)</p>
              <p className="mt-0.5 text-[10px] text-slate-400">
                Dùng cho các placeholder tính toán (Ngay_ky_day/month/year, Dia_diem_ky, Nam_thue, Ngay_tiep_nhan...).
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

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void runUnsavedPreview()}
                disabled={previewing || !selectedCandidate || conflict}
                className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-700 px-3 py-1.5 text-[11px] font-bold text-white hover:bg-indigo-800 disabled:opacity-50"
              >
                <Eye className="h-3.5 w-3.5" /> {previewing ? "Đang dựng..." : "Xem trước A4"}
              </button>
              {previewResult && (
                <>
                  <button
                    type="button"
                    onClick={() => openUnsavedPrintView(true)}
                    title="Mở hộp thoại in của trình duyệt trên bản xem trước CHƯA LƯU (In / Lưu PDF TEST). Không tạo file trên máy chủ, không lưu, không publish."
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    <Printer className="h-3.5 w-3.5" /> In / Lưu PDF TEST
                  </button>
                  <button
                    type="button"
                    onClick={() => openUnsavedPrintView(false)}
                    title="Mở bản in (print-only view) trong tab riêng rồi dùng Print / Save as PDF của trình duyệt."
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-[11px] font-semibold text-slate-600 hover:bg-slate-50"
                  >
                    <ExternalLink className="h-3.5 w-3.5" /> Mở bản in
                  </button>
                </>
              )}
            </div>

            {previewError && (
              <div className="mt-2 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-2 text-[11px] text-red-700">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <p>{previewError}</p>
              </div>
            )}

            {previewResult && (
              <div className="mt-3 space-y-2">
                {/* DEFECT A FIX — a literal <<placeholder>> can only survive rendering
                    when it has NO mapping at all (never "optional and blank", which
                    already resolves to an empty string). Never silently show this as
                    if it were a successful, complete preview. */}
                {previewResult.unresolvedPlaceholderWarning && (
                  <div className="flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 p-2.5 text-[11px] font-semibold text-red-800">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <p>{previewResult.unresolvedPlaceholderWarning}</p>
                  </div>
                )}
                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg bg-white p-2 text-[11px] sm:grid-cols-4">
                  <dt className="text-slate-400">Ứng viên</dt>
                  <dd className="truncate font-semibold text-slate-800">{previewResult.fullName ?? "—"}</dd>
                  <dt className="text-slate-400">Số trang</dt>
                  <dd className="font-semibold text-slate-800">{previewResult.pageCount ?? "—"}</dd>
                  <dt className="text-slate-400">Mapping</dt>
                  <dd className="font-semibold text-slate-800">
                    {previewResult.mappingSummary.mapped}/{previewResult.mappingSummary.total}
                  </dd>
                </dl>
                {previewResult.missingFields.length > 0 && (
                  <p className="rounded-lg bg-amber-50 p-2 text-[11px] text-amber-800">
                    Trường bắt buộc còn thiếu dữ liệu (ứng viên chưa có giá trị): {previewResult.missingFields.join(", ")}
                  </p>
                )}
                <p className="text-[10px] text-slate-400">
                  Đóng khung theo tỉ lệ A4 để dễ phân biệt trang — Preview chỉ <b>GẦN ĐÚNG</b> (trình duyệt không
                  phân trang trên màn hình như khi in thật). <b>In / Lưu PDF TEST</b> bên dưới mới là{" "}
                  <b>KẾT QUẢ CHUẨN</b> — hãy kiểm tra PDF TEST trước khi Publish.
                </p>
                <iframe
                  title="Bản xem trước chưa lưu"
                  sandbox="allow-modals"
                  srcDoc={decoratedPreviewHtml}
                  className="h-[500px] w-full rounded-lg border border-slate-200 bg-slate-500"
                />
              </div>
            )}
          </div>

        {/* PHÂN TÍCH THAY ĐỔI (H1, mở rộng H2) — READ-ONLY. So sánh nội dung ĐANG GÕ (chưa lưu)
            với phiên bản v{version.version} hiện có trên server. KHÔNG lưu, KHÔNG
            Apply, KHÔNG Preview PDF, KHÔNG đổi mapping — chỉ đọc + báo cáo. */}
        <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] font-bold text-slate-700">Phân tích thay đổi (chỉ đọc)</p>
            <button
              type="button"
              onClick={() => void analyze()}
              disabled={analyzing || conflict}
              className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-300 bg-indigo-50 px-3 py-1.5 text-[10px] font-bold text-indigo-700 hover:bg-indigo-100 disabled:opacity-50"
            >
              <Search className="h-3.5 w-3.5" />
              {analyzing ? "Đang phân tích..." : "Phân tích thay đổi"}
            </button>
          </div>
          <p className="mt-1 text-[10px] text-slate-400">
            So sánh HTML/CSS đang gõ ở trên với phiên bản v{version.version} hiện có — không lưu,
            không áp dụng gì cả. Bấm lại nút này bất cứ lúc nào sau khi sửa để xem kết quả mới.
          </p>

          {analyzeError && (
            <div className="mt-2 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-2 text-[11px] text-red-700">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <p>{analyzeError}</p>
            </div>
          )}

          {analyzeResult && (
            <div className="mt-3 grid gap-2 text-[11px]">
              {/* PHASE 14 UI FIX: make the comparison base explicit and unmistakable
                  — "removed" means "present in THIS base version, absent from what
                  you just pasted", not an error in what you pasted. */}
              <p className="rounded-lg border border-indigo-200 bg-indigo-50 px-2 py-1.5 font-semibold text-indigo-800">
                So sánh với: bản v{analyzeResult.baseVersion} ({analyzeResult.baseVersionStatus}) — “bị xóa” nghĩa là có trong v{analyzeResult.baseVersion} nhưng KHÔNG có trong nội dung bạn vừa dán.
              </p>
              <div className="flex flex-wrap gap-3">
                <span className={`inline-flex items-center gap-1 font-semibold ${analyzeResult.htmlValid ? "text-emerald-700" : "text-red-700"}`}>
                  {analyzeResult.htmlValid ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
                  HTML: {analyzeResult.htmlValid ? "Hợp lệ" : `${analyzeResult.htmlIssues.length} lỗi cấu trúc`}
                </span>
                <span className={`inline-flex items-center gap-1 font-semibold ${analyzeResult.cssValid ? "text-emerald-700" : "text-red-700"}`}>
                  {analyzeResult.cssValid ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
                  CSS: {analyzeResult.cssValid ? "Hợp lệ" : `${analyzeResult.cssIssues.length} lỗi cấu trúc`}
                </span>
              </div>

              <div className="rounded-lg bg-white p-2">
                <p className="font-semibold text-slate-600">
                  Placeholder ({analyzeResult.placeholders.total} tổng cộng, so với v{analyzeResult.baseVersion}):
                </p>
                <p className="text-slate-500">
                  {analyzeResult.placeholders.unchanged} không đổi · {analyzeResult.placeholders.added} mới ·{" "}
                  {analyzeResult.placeholders.removed} bị xóa
                </p>
              </div>

              <div className="rounded-lg bg-white p-2">
                <p className="font-semibold text-slate-600">Mapping:</p>
                <p className={analyzeResult.mappingsAffected > 0 ? "text-amber-700" : "text-slate-500"}>
                  {analyzeResult.mappingsAffected} trường bị ảnh hưởng
                </p>
              </div>

              <div className="rounded-lg bg-white p-2">
                <p className="font-semibold text-slate-600">Tình trạng:</p>
                <p className={analyzeResult.security.errors.length > 0 ? "text-red-700" : "text-emerald-700"}>
                  {analyzeResult.security.errors.length > 0
                    ? `⚠ ${analyzeResult.security.errors.length} mã nguy hiểm bị chặn`
                    : "✓ Không phát hiện mã nguy hiểm"}
                  {analyzeResult.security.warnings.length > 0 ? ` · ${analyzeResult.security.warnings.length} cảnh báo` : ""}
                </p>
                {analyzeResult.security.errors.map((e, i) => (
                  <p key={i} className="mt-1 text-red-600">• {e.message}</p>
                ))}
              </div>

              <div className="rounded-lg bg-white p-2">
                <p className="font-semibold text-slate-600">Bố cục:</p>
                <p className={analyzeResult.layoutWarnings.length > 0 ? "text-amber-700" : "text-emerald-700"}>
                  {analyzeResult.layoutWarnings.length > 0
                    ? `⚠ ${analyzeResult.layoutWarnings.length} vị trí có nguy cơ khi dữ liệu dài`
                    : "✓ Không phát hiện nguy cơ bố cục"}
                </p>
                {analyzeResult.layoutWarnings.map((w, i) => (
                  <p key={i} className="mt-1 text-amber-700">• {w.message}</p>
                ))}
              </div>

              <div className="rounded-lg bg-white p-2">
                <p className="font-semibold text-slate-600">Resources:</p>
                <p className={analyzeResult.externalResourceWarnings.length > 0 ? "text-amber-700" : "text-emerald-700"}>
                  {analyzeResult.externalResourceWarnings.length > 0
                    ? `⚠ ${analyzeResult.externalResourceWarnings.length} stylesheet ngoài bị bỏ qua`
                    : "✓ Không có tài nguyên ngoài bị bỏ qua"}
                </p>
                {analyzeResult.externalResourceWarnings.map((w, i) => (
                  <p key={i} className="mt-1 text-amber-700">• {w.message}</p>
                ))}
                {analyzeResult.normalizationWarnings.map((w, i) => (
                  <p key={i} className="mt-1 text-amber-700">• {w.message}</p>
                ))}
              </div>
            </div>
          )}
        </div>

        {applyError && (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-[11px] text-red-700">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <p>{applyError}</p>
          </div>
        )}
        {applied && (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-[11px] text-emerald-700">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            <p>Đã áp dụng vào bản nháp v{version.version}. Phiên bản đang xuất bản KHÔNG thay đổi.</p>
          </div>
        )}

        <p className="mt-3 text-[10px] text-slate-400">
          Workflow tối giản: <b>HTML/Print CSS hiện tại</b> → <b>Lưu bản nháp</b> (PATCH trực tiếp, editor không
          đóng) → <b>Xem trước A4</b> (gần đúng) → kiểm tra <b>PDF TEST</b> (kết quả chuẩn) → Lưu lại nếu cần.
          Riêng <b>Áp dụng vào bản nháp</b> (mode dán HTML hoàn chỉnh) vẫn yêu cầu <b>Phân tích thay đổi</b> trước.
          Mọi ghi chỉ đụng html_body/print_css của bản DRAFT này — KHÔNG xuất bản; mapping snapshot chỉ được freeze
          khi bạn chủ động Xuất bản.
        </p>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={requestClose}
            disabled={saving || applying}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Hủy
          </button>
          <button
            type="button"
            onClick={() => setShowApplyConfirm(true)}
            disabled={!analyzeResult || analyzeResult.security.errors.length > 0 || applying || conflict}
            title={!analyzeResult ? "Bấm “Phân tích thay đổi” trước khi áp dụng." : undefined}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-4 py-2 text-xs font-bold text-white hover:bg-emerald-800 disabled:opacity-50"
          >
            <CheckSquare className="h-3.5 w-3.5" />
            {applying ? "Đang áp dụng..." : "Áp dụng vào bản nháp"}
          </button>
        </div>

        {showApplyConfirm && (
          <ApplyToDraftConfirmModal
            version={version.version}
            applying={applying}
            onCancel={() => setShowApplyConfirm(false)}
            onConfirm={() => void applyToDraft()}
          />
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 3. APPLY TO DRAFT — CONFIRMATION (Phase 9/15, exact required text)
 * ------------------------------------------------------------------ */

function ApplyToDraftConfirmModal({
  version,
  applying,
  onCancel,
  onConfirm,
}: {
  version: number;
  applying: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/60 p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-2xl">
        <div className="flex items-center gap-2">
          <span className="rounded-lg bg-emerald-50 p-2 text-emerald-700">
            <CheckSquare className="h-4 w-4" />
          </span>
          <h3 className="text-sm font-bold text-slate-900">Áp dụng vào bản nháp?</h3>
        </div>
        <p className="mt-3 whitespace-pre-line text-[12px] leading-relaxed text-slate-700">
          {`Bạn đang cập nhật BẢN NHÁP v${version}.\nPhiên bản đang xuất bản sẽ KHÔNG thay đổi.\nThao tác này KHÔNG xuất bản template.`}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={applying}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            Hủy
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={applying}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-4 py-2 text-xs font-bold text-white hover:bg-emerald-800 disabled:opacity-50"
          >
            <CheckSquare className="h-3.5 w-3.5" />
            {applying ? "Đang áp dụng..." : "Áp dụng vào bản nháp"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 5. READ-ONLY HTML/CSS VIEWER — "Xem HTML/CSS" (PUBLISHED/ARCHIVED)
 * ------------------------------------------------------------------ */

export type VersionHtmlViewTarget = {
  id: string;
  version: number;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  htmlBody: string | null;
  printCss: string | null;
  marginTopMm: number;
  marginBottomMm: number;
  marginLeftMm: number;
  marginRightMm: number;
};

/**
 * "Xem HTML/CSS" — CHỈ ĐỌC, dành cho version PUBLISHED/ARCHIVED (những
 * version KHÔNG BAO GIỜ có nút sửa: server trả 409 cho mọi ghi lên chúng).
 *
 * Hiển thị đúng html_body/print_css ĐÃ LƯU của versionId được chọn — dữ liệu
 * đã có sẵn trong danh sách phiên bản nên modal này KHÔNG gọi API nào, KHÔNG
 * ghi DB, KHÔNG publish (thuần presentational). Muốn sửa nội dung: bấm
 * "Tạo bản nháp từ phiên bản này" rồi mở "Sửa HTML/CSS" trên bản DRAFT mới.
 */
export function VersionHtmlViewerModal({
  templateName,
  version,
  onClose,
}: {
  templateName: string;
  version: VersionHtmlViewTarget;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4">
      <div className="my-6 w-full max-w-3xl rounded-2xl bg-white p-5 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="rounded-lg bg-slate-100 p-2 text-slate-600">
              <FileCode2 className="h-4 w-4" />
            </span>
            <div>
              <h3 className="text-sm font-bold text-slate-900">
                Xem HTML/CSS — phiên bản v{version.version} ({version.status})
              </h3>
              <p className="text-[11px] text-slate-500">
                Chỉ ĐỌC — {templateName}. Version {version.status} là bất biến; muốn sửa hãy bấm{" "}
                <b>Tạo bản nháp từ phiên bản này</b> rồi mở <b>Sửa HTML/CSS</b> trên bản DRAFT mới.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            aria-label="Đóng"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <label className="mt-4 block text-[11px] font-semibold text-slate-600">
          HTML hiện tại (html_body — chỉ đọc)
          <textarea
            readOnly
            value={version.htmlBody ?? ""}
            rows={14}
            spellCheck={false}
            className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-[11px] text-slate-700 outline-none"
          />
        </label>
        <label className="mt-3 block text-[11px] font-semibold text-slate-600">
          Print CSS hiện tại (print_css — chỉ đọc)
          <textarea
            readOnly
            value={version.printCss ?? ""}
            rows={6}
            spellCheck={false}
            className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-[11px] text-slate-700 outline-none"
          />
        </label>
        <p className="mt-3 text-[11px] font-semibold text-slate-600">
          Canh lề A4 (mm, đã khóa cùng phiên bản này): Trên {version.marginTopMm} · Dưới {version.marginBottomMm} · Trái{" "}
          {version.marginLeftMm} · Phải {version.marginRightMm}
        </p>

        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          >
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
}
