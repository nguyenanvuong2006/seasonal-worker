"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ExternalLink,
  FileText,
  FileUp,
  Layers,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  ScanSearch,
  Trash2,
  X,
} from "lucide-react";
import { documentKindLabel, extractGoogleDocId } from "@/lib/document-merge/template-routing";
import { ResizableMappingTable } from "@/components/document-merge/resizable-mapping-table";
import { TemplateChangeAnalyzer } from "@/components/document-merge/template-change-analyzer";
import {
  DraftVersionPreviewModal,
  type PreviewVersionTarget,
} from "@/components/document-merge/draft-version-preview-modal";
import { PublishChecklistModal } from "@/components/document-merge/publish-checklist-modal";
import {
  DraftVersionEditorModal,
  VersionCloneConfirmModal,
  VersionDeleteConfirmModal,
  VersionHtmlViewerModal,
  type CloneVersionTarget,
  type DraftEditTarget,
  type VersionDeleteTarget,
  type VersionHtmlViewTarget,
} from "@/components/document-merge/version-clone-modals";

type Template = {
  id: string;
  name: string;
  description: string | null;
  googleDocId: string;
  outputFolderId: string | null;
  outputFileNamePattern: string | null;
  defaultMergeMode: "ONE_DOCUMENT" | "INDIVIDUAL_DOCUMENTS";
  documentKind?: "A" | "B" | "GENERIC";
  dataSources: string[];
  isActive: boolean;
  placeholderCount?: number;
  currentPublishedVersion?: number | null;
  retentionYears?: number | null;
};

type TemplateVersion = {
  id: string;
  templateId: string;
  version: number;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  htmlBody: string | null;
  printCss: string | null;
  sourceDocxName: string | null;
  retentionYears: number | null;
  mappingSnapshot: Record<string, unknown>[];
  createdBy: string;
  publishedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
};

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

type FormState = {
  name: string;
  description: string;
  googleDocId: string;
  outputFolderId: string;
  outputFileNamePattern: string;
  defaultMergeMode: "ONE_DOCUMENT" | "INDIVIDUAL_DOCUMENTS";
  documentKind: "A" | "B" | "GENERIC";
};

const EMPTY_FORM: FormState = {
  name: "",
  description: "",
  googleDocId: "",
  outputFolderId: "",
  outputFileNamePattern: "",
  defaultMergeMode: "ONE_DOCUMENT",
  documentKind: "GENERIC",
};

const SOURCE_TYPES = [
  "CORE_FIELD",
  "DYNAMIC_ANSWER",
  "RELATED_FIELD",
  "COMPUTED_FIELD",
  "SYSTEM_FIELD",
  "STATIC_TEXT",
  "CHECKBOX_OPTION",
];

const FORMAT_TYPES = [
  "RAW",
  "DATE_DDMMYYYY",
  "DATE_DD_MM_YYYY",
  "DATE_DDMMYYYY_HHMM",
  "UPPERCASE",
  "LOWERCASE",
  "TITLE_CASE",
  "NUMBER",
  "CURRENCY_VND",
  "VIETNAMESE_NUMBER_WORDS",
  "BOOLEAN_CHECKBOX",
];

export function TemplateLibrary({ onSelectForMerge }: { onSelectForMerge: (templateId: string) => void }) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Template | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [mappingLoading, setMappingLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [mappingSaving, setMappingSaving] = useState(false);
  const [scanLoading, setScanLoading] = useState(false);
  // --- Template versioning (Phase 3) ---
  const [versions, setVersions] = useState<TemplateVersion[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionAction, setVersionAction] = useState<string | null>(null);
  /** Version đang chờ xác nhận "Tạo bản nháp từ phiên bản này". */
  const [cloneConfirmVersion, setCloneConfirmVersion] = useState<CloneVersionTarget | null>(null);
  const [cloning, setCloning] = useState(false);
  /** Version DRAFT đang chờ xác nhận "Xóa bản nháp" (xoá vĩnh viễn). */
  const [deleteConfirmVersion, setDeleteConfirmVersion] = useState<VersionDeleteTarget | null>(null);
  const [deleting, setDeleting] = useState(false);
  /** Version DRAFT đang mở editor "Sửa HTML/CSS". */
  const [editDraftVersion, setEditDraftVersion] = useState<DraftEditTarget | null>(null);
  /** Version PUBLISHED/ARCHIVED đang mở viewer chỉ đọc "Xem HTML/CSS". */
  const [viewHtmlVersion, setViewHtmlVersion] = useState<VersionHtmlViewTarget | null>(null);
  /** Version vừa clone/lưu — highlight trong danh sách. */
  const [highlightVersionId, setHighlightVersionId] = useState<string | null>(null);
  // DRAFT VERSION PREVIEW — read-only "Xem trước"; never publishes.
  const [previewVersion, setPreviewVersion] = useState<PreviewVersionTarget | null>(null);
  /** Version chờ xác nhận qua PublishChecklistModal trước khi publish/rollback thật. */
  const [publishChecklistTarget, setPublishChecklistTarget] = useState<{ version: TemplateVersion; action: "publish" | "rollback" } | null>(null);
  /**
   * Lỗi hiển thị NGAY TRONG panel "Phiên bản Template" (bên trong modal
   * "Sửa Template"). Bắt buộc phải tách khỏi `error` toàn cục: `error` render
   * ở gốc component, NGOÀI overlay fixed của modal → khi modal đang mở thì
   * operator không nhìn thấy, và một click "thất bại" sẽ trông như im lặng.
   */
  const [versionPanelError, setVersionPanelError] = useState<string | null>(null);
  const [syncingGoogleDoc, setSyncingGoogleDoc] = useState(false);
  const [draftHtml, setDraftHtml] = useState("");
  const [draftCss, setDraftCss] = useState("");
  const [draftRetention, setDraftRetention] = useState<string>("3");
  const [draftSaving, setDraftSaving] = useState(false);

  const loadTemplates = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/document-merge/templates", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Không thể tải thư viện mẫu.");
      setTemplates(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không thể tải thư viện mẫu.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTemplates();
  }, []);

  const mappingSummary = useMemo(() => {
    const active = mappings.filter((m) => !m.isOrphaned);
    return {
      total: active.length,
      matched: active.filter((m) => Boolean(m.sourceField || m.sourcePath || m.fallbackValue)).length,
      missing: active.filter((m) => !(m.sourceField || m.sourcePath || m.fallbackValue)).length,
      orphaned: mappings.filter((m) => m.isOrphaned).length,
    };
  }, [mappings]);

  const openCreate = () => {
    setCreating(true);
    setEditing(null);
    setForm(EMPTY_FORM);
    setMappings([]);
  };

  const loadVersions = async (templateId: string) => {
    setVersionsLoading(true);
    try {
      const res = await fetch(`/api/document-merge/templates/${templateId}/versions`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Không tải được phiên bản.");
      setVersions(Array.isArray(data) ? data : []);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Không tải được phiên bản.");
      setVersions([]);
    } finally {
      setVersionsLoading(false);
    }
  };

  const openEdit = async (template: Template) => {
    setCreating(false);
    setEditing(template);
    setHighlightVersionId(null);
    setForm({
      name: template.name,
      description: template.description || "",
      googleDocId: template.googleDocId,
      outputFolderId: template.outputFolderId || "",
      outputFileNamePattern: template.outputFileNamePattern || "",
      defaultMergeMode: template.defaultMergeMode,
      documentKind: template.documentKind || "GENERIC",
    });
    setMappingLoading(true);
    try {
      const res = await fetch(`/api/document-merge/templates/${template.id}/fields`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Không tải được mapping.");
      setMappings(Array.isArray(data) ? data : []);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Không tải được mapping.");
      setMappings([]);
    } finally {
      setMappingLoading(false);
    }
    setDraftHtml("");
    setDraftCss("");
    await loadVersions(template.id);
  };

  const closeEditor = () => {
    setCreating(false);
    setEditing(null);
    setMappings([]);
    setVersions([]);
    setForm(EMPTY_FORM);
  };

  /**
   * archive: still a plain window.confirm — Lưu trữ never publishes content,
   * so the richer PublishChecklistModal (Phase 7) is not required for it.
   * publish/rollback: NEVER call this with a window.confirm gate anymore —
   * both always go through PublishChecklistModal first (see
   * openPublishChecklist / the modal's onConfirmed below), which itself
   * calls this function with skipConfirm=true after the operator has
   * completed the machine checks + all 5 checkboxes.
   */
  const runVersionAction = async (
    version: TemplateVersion,
    action: "publish" | "archive" | "rollback",
    skipConfirm = false,
  ): Promise<boolean> => {
    if (!editing) return false;
    const label = action === "publish" ? "Xuất bản" : action === "archive" ? "Lưu trữ" : "Khôi phục";
    if (!skipConfirm && !window.confirm(`${label} version ${version.version} của "${editing.name}"?`)) return false;
    setVersionAction(`${action}:${version.id}`);
    try {
      const res = await fetch(
        `/api/document-merge/templates/${editing.id}/versions/${version.id}/${action}`,
        { method: "POST" },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Không ${label.toLowerCase()} được version.`);
      await loadVersions(editing.id);
      await loadTemplates();
      return true;
    } catch (err) {
      alert(err instanceof Error ? err.message : `Không ${label.toLowerCase()} được version.`);
      return false;
    } finally {
      setVersionAction(null);
    }
  };

  /**
   * "Tạo bản nháp từ phiên bản này" — sau khi operator xác nhận trong dialog.
   * Server load version nguồn theo URL (không tin HTML từ client) và CREATE
   * một version DRAFT mới; version nguồn (kể cả PUBLISHED) bất biến.
   * KHÔNG tự publish, KHÔNG đổi current_published_version.
   */
  const confirmCloneVersion = async () => {
    if (!editing || !cloneConfirmVersion) return;
    const sourceVersionNumber = cloneConfirmVersion.version;
    setCloning(true);
    try {
      const res = await fetch(
        `/api/document-merge/templates/${editing.id}/versions/${cloneConfirmVersion.id}/clone`,
        { method: "POST" },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Không tạo được bản nháp.");
      setCloneConfirmVersion(null);
      setHighlightVersionId(data.versionId ?? null);
      await loadVersions(editing.id);
      alert(
        `Đã tạo phiên bản v${data.version} (DRAFT) từ v${data.sourceVersion ?? sourceVersionNumber}.\n\n` +
          "Phiên bản nguồn không bị thay đổi. Hãy dùng [Sửa HTML/CSS] rồi [Xem trước] với ứng viên thật trước khi Xuất bản.",
      );
    } catch (err) {
      alert(err instanceof Error ? err.message : "Không tạo được bản nháp.");
    } finally {
      setCloning(false);
    }
  };

  /**
   * MỞ PUBLISH CHECKLIST — điểm vào DUY NHẤT của nút "Xuất bản phiên bản"
   * (DRAFT) và "Khôi phục" (ARCHIVED).
   *
   * BUG PRODUCTION ĐÃ SỬA (v16 DRAFT: nút hiện ra, bấm KHÔNG có gì xảy ra —
   * không modal, không lỗi, không request):
   *   Nút trước đây có `disabled={versionAction !== null}`. `versionAction`
   *   là latch dùng chung cho MỌI version action (publish/archive/rollback/
   *   delete). Chỉ cần MỘT request trước đó chưa kết thúc (mạng treo, tab
   *   ngủ, request bị huỷ giữa chừng...) là latch còn nguyên → nút publish
   *   bị disabled. Mà style disabled duy nhất là `disabled:opacity-50` trên
   *   nền emerald-700 đậm → mắt thường KHÔNG phân biệt được, nên operator
   *   thấy nút "bình thường" nhưng trình duyệt nuốt click: đúng triệu chứng
   *   "bấm không có gì xảy ra, im lặng tuyệt đối".
   *
   * QUY TẮC MỚI (Phase 4): nút card KHÔNG BAO GIỜ bị pre-disable bởi
   * validation hay bởi latch — click LUÔN cho phản hồi nhìn thấy được:
   *   A. mở PublishChecklistModal (đường đi bình thường), HOẶC
   *   B. hiện lỗi rõ ràng nếu thật sự chưa mở được lúc này.
   * Việc quyết định có được publish hay không thuộc về checklist (và cuối
   * cùng là backend) — chỉ nút Confirm trong checklist mới bị disable bởi
   * machine blockers.
   */
  const openPublishChecklist = (version: TemplateVersion, action: "publish" | "rollback") => {
    setHighlightVersionId(null);
    if (versionAction !== null) {
      // KHÔNG im lặng: nói rõ vì sao chưa mở được và đang vướng thao tác nào.
      // Dùng versionPanelError (hiển thị NGAY trong panel phiên bản, bên
      // trong modal "Sửa Template") — `error` toàn cục nằm NGOÀI overlay
      // fixed nên sẽ bị modal che, tức là vẫn "im lặng" với operator.
      setVersionPanelError(
        `Chưa mở được checklist vì đang có thao tác khác chạy trên phiên bản (${versionAction}). ` +
          "Đợi thao tác đó xong rồi bấm lại — chưa có gì bị thay đổi.",
      );
      return;
    }
    setVersionPanelError(null);
    setPublishChecklistTarget({ version, action });
  };

  /**
   * "Xóa bản nháp" — xoá VĨNH VIỄN một version DRAFT sau khi operator xác nhận
   * trong dialog. Server re-read version trong transaction ngay trước DELETE
   * và guard status='DRAFT' trong WHERE → PUBLISHED/ARCHIVED/stale đều bị từ
   * chối (409) kể cả khi gọi API trực tiếp. Sau khi xoá: refresh danh sách
   * version; không tự publish, không đổi current_published_version, không
   * đụng mapping dùng chung hay PDF/job/history của version khác.
   */
  const confirmDeleteVersion = async () => {
    if (!editing || !deleteConfirmVersion) return;
    const target = deleteConfirmVersion;
    setDeleting(true);
    setVersionAction(`delete:${target.id}`);
    try {
      const res = await fetch(
        `/api/document-merge/templates/${editing.id}/versions/${target.id}`,
        { method: "DELETE" },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Không xoá được bản nháp.");
      setDeleteConfirmVersion(null);
      if (highlightVersionId === target.id) setHighlightVersionId(null);
      // Refresh danh sách version — nếu trước đó có 2 DRAFT thì giờ còn đúng
      // 1 DRAFT làm việc và guard SINGLE_DRAFT_AMBIGUOUS tự hết block.
      await loadVersions(editing.id);
      alert(
        `Đã xoá vĩnh viễn bản nháp v${target.version} của "${editing.name}".\n\n` +
          "Phiên bản đang xuất bản và mapping của mẫu không thay đổi.",
      );
    } catch (err) {
      alert(err instanceof Error ? err.message : "Không xoá được bản nháp.");
    } finally {
      setDeleting(false);
      setVersionAction(null);
    }
  };

  const [docxImporting, setDocxImporting] = useState(false);
  const docxInputRef = useRef<HTMLInputElement>(null);

  const importDocx = async (file: File) => {
    if (!editing) return;
    setDocxImporting(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`/api/document-merge/templates/${editing.id}/import-docx`, {
        method: "POST",
        body: form,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Không import được DOCX.");
      await loadVersions(editing.id);
      await loadTemplates();
      const warningNote = data.hasWarnings ? "\n\nCó cảnh báo layout — hãy kiểm tra Preview kỹ trước khi Publish." : "";
      alert(
        `Đã tạo version ${data.version.version} (DRAFT) từ "${file.name}": ${data.placeholderCount} placeholder.` +
          warningNote,
      );
    } catch (err) {
      alert(err instanceof Error ? err.message : "Không import được DOCX.");
    } finally {
      setDocxImporting(false);
      if (docxInputRef.current) docxInputRef.current.value = "";
    }
  };

  /**
   * "Đồng bộ Google Doc → phiên bản HTML mới".
   * Tạo DRAFT mới — KHÔNG tự publish, KHÔNG ghi đè phiên bản cũ.
   */
  const syncFromGoogleDoc = async () => {
    if (!editing) return;
    if (
      !window.confirm(
        `Đồng bộ Google Doc của "${editing.name}" thành MỘT PHIÊN BẢN HTML MỚI (DRAFT)?\n\n` +
          "• KHÔNG tự động xuất bản.\n" +
          "• KHÔNG ghi đè phiên bản cũ.\n" +
          "• Bạn phải Preview kiểm tra rồi bấm Xuất bản.",
      )
    ) {
      return;
    }
    setSyncingGoogleDoc(true);
    try {
      const res = await fetch(`/api/document-merge/templates/${editing.id}/sync-google-doc`, {
        method: "POST",
      });
      const data = await res.json();
      if (!res.ok) {
        const limitations = Array.isArray(data.limitations) && data.limitations.length > 0
          ? `\n\nGiới hạn:\n- ${data.limitations.join("\n- ")}`
          : "";
        throw new Error(`${data.error || "Không đồng bộ được Google Doc."}${limitations}`);
      }
      await loadVersions(editing.id);
      const warnings = Array.isArray(data.warnings) && data.warnings.length > 0
        ? `\n\nCảnh báo cần kiểm tra:\n- ${data.warnings.join("\n- ")}`
        : "";
      alert(
        `Đã tạo phiên bản ${data.version.version} (DRAFT) từ Google Doc — ${data.logicalPageCount} trang, ` +
          `${data.placeholders?.length ?? 0} placeholder.\n\nHãy Preview bản nháp rồi bấm Xuất bản.${warnings}`,
      );
    } catch (err) {
      alert(err instanceof Error ? err.message : "Không đồng bộ được Google Doc.");
    } finally {
      setSyncingGoogleDoc(false);
    }
  };

  const createDraftVersion = async () => {
    if (!editing) return;
    if (!draftHtml.trim()) {
      alert("Dán nội dung HTML (template in A4) cho version DRAFT.");
      return;
    }
    setDraftSaving(true);
    try {
      const res = await fetch(`/api/document-merge/templates/${editing.id}/versions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          htmlBody: draftHtml,
          printCss: draftCss || null,
          retentionYears: draftRetention === "none" ? null : Number(draftRetention),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Không tạo được version DRAFT.");
      await loadVersions(editing.id);
      setDraftHtml("");
      setDraftCss("");
      setDraftRetention("3");
      alert(`Đã tạo version ${data.version} (DRAFT). Quét placeholder và Preview trước khi Publish.`);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Không tạo được version DRAFT.");
    } finally {
      setDraftSaving(false);
    }
  };

  const saveTemplate = async () => {
    const docId = extractGoogleDocId(form.googleDocId) || form.googleDocId.trim();
    if (!form.name.trim() || !docId) {
      alert("Tên mẫu và Google Docs ID/URL là bắt buộc.");
      return;
    }
    setSaving(true);
    try {
      const target = editing ? `/api/document-merge/templates/${editing.id}` : "/api/document-merge/templates";
      const res = await fetch(target, {
        method: editing ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, googleDocId: docId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Không lưu được template.");
      await loadTemplates();
      if (editing) {
        const refreshed = { ...editing, ...data, googleDocId: docId } as Template;
        setEditing(refreshed);
        setForm((current) => ({ ...current, googleDocId: docId }));
      } else {
        closeEditor();
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : "Không lưu được template.");
    } finally {
      setSaving(false);
    }
  };

  const saveMappings = async () => {
    if (!editing) return;
    setMappingSaving(true);
    try {
      const res = await fetch(`/api/document-merge/templates/${editing.id}/fields`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields: mappings }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Không lưu được mapping.");
      setMappings(Array.isArray(data) ? data : mappings);
      alert("Đã lưu mapping của template.");
    } catch (err) {
      alert(err instanceof Error ? err.message : "Không lưu được mapping.");
    } finally {
      setMappingSaving(false);
    }
  };

  const scanTemplate = async (template: Template) => {
    setScanLoading(true);
    try {
      const res = await fetch(`/api/document-merge/templates/${template.id}/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ googleDocId: template.googleDocId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Không quét được placeholder.");
      if (editing?.id === template.id) await openEdit(template);
      await loadTemplates();
      alert(`Đã quét ${data.placeholders?.length ?? data.activeFields ?? 0} placeholder.`);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Không quét được placeholder.");
    } finally {
      setScanLoading(false);
    }
  };

  const toggleActive = async (template: Template) => {
    const res = await fetch(`/api/document-merge/templates/${template.id}/activate`, { method: "POST" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || "Không thay đổi được trạng thái template.");
      return;
    }
    await loadTemplates();
  };

  const deleteTemplate = async (template: Template) => {
    const typed = window.prompt(`Nhập chính xác tên mẫu để xác nhận xoá:\n${template.name}`);
    if (typed !== template.name) return;
    const res = await fetch(`/api/document-merge/templates/${template.id}`, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      alert(data.error || "Không thể xoá template. Có thể template đã được dùng trong lịch sử merge.");
      return;
    }
    if (editing?.id === template.id) closeEditor();
    await loadTemplates();
  };

  const updateMapping = (id: string, patch: Partial<Mapping>) => {
    setMappings((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-base font-bold text-slate-900">Danh sách Mẫu tài liệu</h2>
          <p className="text-xs text-slate-500">Tạo, sửa, phân loại A/B, quét placeholder và kiểm soát mapping ngay trong thư viện.</p>
        </div>
        <button onClick={openCreate} className="inline-flex items-center gap-2 rounded-lg bg-emerald-700 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-800">
          <Plus className="h-4 w-4" /> Tạo Template mới
        </button>
      </div>

      {error && <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-xs text-red-700">{error}</div>}

      {loading ? (
        <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">Đang tải thư viện mẫu...</div>
      ) : templates.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center">
          <FileText className="mx-auto h-8 w-8 text-emerald-700" />
          <p className="mt-3 text-sm font-semibold text-slate-800">Chưa có mẫu tài liệu.</p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {templates.map((template) => (
            <article key={template.id} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-bold text-slate-900">{template.name}</h3>
                  <p className="mt-1 line-clamp-2 text-xs text-slate-500">{template.description || "Chưa có mô tả"}</p>
                </div>
                <button onClick={() => toggleActive(template)} className={`shrink-0 rounded-full px-2.5 py-1 text-[10px] font-bold ${template.isActive ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>
                  {template.isActive ? "HOẠT ĐỘNG" : "TẮT"}
                </button>
              </div>

              <div className="mt-4 space-y-2 rounded-xl bg-slate-50 p-3 text-[11px]">
                <div className="flex justify-between gap-3"><span className="text-slate-400">Phân loại</span><span className={`font-semibold ${(template.documentKind || "GENERIC") === "GENERIC" ? "text-amber-700" : "text-emerald-700"}`}>{documentKindLabel(template.documentKind)}</span></div>
                <div className="flex justify-between gap-3"><span className="text-slate-400">Placeholders</span><span className="font-semibold text-slate-700">{template.placeholderCount || 0} trường</span></div>
                <div className="flex justify-between gap-3"><span className="text-slate-400">Chế độ</span><span className="text-slate-700">{template.defaultMergeMode === "ONE_DOCUMENT" ? "1 file gộp" : "File riêng"}</span></div>
                <div className="flex justify-between gap-3"><span className="text-slate-400">Doc ID</span><span className="max-w-[160px] truncate font-mono text-slate-700">{template.googleDocId}</span></div>
              </div>

              {(template.documentKind || "GENERIC") === "GENERIC" && (
                <div className="mt-3 flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-[11px] text-amber-800">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  Auto-route DW Cũ/Mới sẽ không dùng mẫu này như Tài liệu A/B cho tới khi bạn bấm Sửa và chọn đúng phân loại.
                </div>
              )}

              <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-100 pt-3">
                <a href={`https://docs.google.com/document/d/${template.googleDocId}/edit`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50">
                  <ExternalLink className="h-3.5 w-3.5" /> Mẫu gốc
                </a>
                <button onClick={() => openEdit(template)} className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-100">
                  <Pencil className="h-3.5 w-3.5" /> Sửa
                </button>
                <button disabled={scanLoading} onClick={() => scanTemplate(template)} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50">
                  <ScanSearch className="h-3.5 w-3.5" /> Scan
                </button>
                <button onClick={() => onSelectForMerge(template.id)} className="inline-flex items-center gap-1 rounded-lg bg-emerald-700 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-800">
                  <Layers className="h-3.5 w-3.5" /> Merge
                </button>
                <button onClick={() => deleteTemplate(template)} className="ml-auto inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50">
                  <Trash2 className="h-3.5 w-3.5" /> Xoá
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      {(creating || editing) && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/45 p-3 sm:p-6">
          <div className="mx-auto w-full max-w-[96vw] rounded-2xl bg-white shadow-2xl xl:max-w-[1600px]">
            <div className="sticky top-0 z-10 flex items-center justify-between rounded-t-2xl border-b border-slate-200 bg-white px-4 py-3 sm:px-6">
              <div>
                <h3 className="text-base font-bold text-slate-900">{editing ? "Sửa Template" : "Tạo Template mới"}</h3>
                <p className="text-[11px] text-slate-500">Thông tin mẫu + routing A/B + mapping placeholder.</p>
              </div>
              <button onClick={closeEditor} className="rounded-lg p-2 text-slate-400 hover:bg-slate-100"><X className="h-5 w-5" /></button>
            </div>

            <div className="space-y-6 p-4 sm:p-6">
              <section className="grid gap-4 md:grid-cols-2">
                <label className="text-xs font-semibold text-slate-700">Tên Template *
                  <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal outline-none focus:border-emerald-600" />
                </label>
                <label className="text-xs font-semibold text-slate-700">Phân loại mẫu *
                  <select value={form.documentKind} onChange={(e) => setForm({ ...form, documentKind: e.target.value as FormState["documentKind"] })} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-normal outline-none focus:border-emerald-600">
                    <option value="GENERIC">Mẫu chung (fallback)</option>
                    <option value="A">Tài liệu A — DW Cũ / Cam kết / Tái ký</option>
                    <option value="B">Tài liệu B — DW Mới / Hồ sơ đào tạo nghề</option>
                  </select>
                </label>
                <label className="text-xs font-semibold text-slate-700 md:col-span-2">Mô tả
                  <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal outline-none focus:border-emerald-600" />
                </label>
                <label className="text-xs font-semibold text-slate-700 md:col-span-2">Google Docs URL / ID *
                  <input value={form.googleDocId} onChange={(e) => setForm({ ...form, googleDocId: e.target.value })} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono font-normal outline-none focus:border-emerald-600" />
                </label>
                <label className="text-xs font-semibold text-slate-700">Google Drive Output Folder ID
                  <input value={form.outputFolderId} onChange={(e) => setForm({ ...form, outputFolderId: e.target.value })} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono font-normal outline-none focus:border-emerald-600" />
                </label>
                <label className="text-xs font-semibold text-slate-700">Tên file đầu ra
                  <input value={form.outputFileNamePattern} onChange={(e) => setForm({ ...form, outputFileNamePattern: e.target.value })} className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal outline-none focus:border-emerald-600" />
                </label>
                <label className="text-xs font-semibold text-slate-700">Chế độ merge mặc định
                  <select value={form.defaultMergeMode} onChange={(e) => setForm({ ...form, defaultMergeMode: e.target.value as FormState["defaultMergeMode"] })} className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-normal outline-none focus:border-emerald-600">
                    <option value="ONE_DOCUMENT">1 file gộp + Page Break</option>
                    <option value="INDIVIDUAL_DOCUMENTS">File riêng từng người</option>
                  </select>
                </label>
              </section>

              <div className="flex flex-wrap items-center gap-2 border-y border-slate-100 py-4">
                <button onClick={saveTemplate} disabled={saving} className="inline-flex items-center gap-2 rounded-lg bg-emerald-700 px-4 py-2 text-xs font-bold text-white hover:bg-emerald-800 disabled:opacity-50"><Save className="h-4 w-4" /> {saving ? "Đang lưu..." : "Lưu thông tin mẫu"}</button>
                {editing && <button onClick={() => scanTemplate(editing)} disabled={scanLoading} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"><RefreshCw className="h-4 w-4" /> Quét lại Google Docs</button>}
                {editing && <a href={`https://docs.google.com/document/d/${editing.googleDocId}/edit`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"><ExternalLink className="h-4 w-4" /> Mở mẫu gốc</a>}
              </div>

              {editing && (
                <section>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                    <div>
                      <h4 className="text-sm font-bold text-slate-900">Placeholder Mapping</h4>
                      <p className="text-[11px] text-slate-500">Kiểm soát 1:1 giữa placeholder trong Google Docs và nguồn dữ liệu hệ thống. Giữ cố định cột Placeholder; kéo mép phải tiêu đề các cột còn lại để thay đổi độ rộng.</p>
                    </div>
                    <div className="flex flex-wrap gap-2 text-[11px]">
                      <span className="rounded-full bg-slate-100 px-2.5 py-1">Tổng {mappingSummary.total}</span>
                      <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-emerald-700">Matched {mappingSummary.matched}</span>
                      <span className="rounded-full bg-amber-50 px-2.5 py-1 text-amber-700">Missing {mappingSummary.missing}</span>
                      <span className="rounded-full bg-red-50 px-2.5 py-1 text-red-700">Orphaned {mappingSummary.orphaned}</span>
                    </div>
                  </div>

                  {mappingLoading ? (
                    <div className="mt-4 rounded-xl bg-slate-50 p-8 text-center text-xs text-slate-500">Đang tải mapping...</div>
                  ) : (
                    <ResizableMappingTable
                      mappings={mappings}
                      sourceTypes={SOURCE_TYPES}
                      formatTypes={FORMAT_TYPES}
                      updateMapping={updateMapping}
                    />
                  )}

                  <div className="mt-4 flex justify-end">
                    <button onClick={saveMappings} disabled={mappingSaving} className="inline-flex items-center gap-2 rounded-lg bg-emerald-700 px-4 py-2 text-xs font-bold text-white hover:bg-emerald-800 disabled:opacity-50"><Save className="h-4 w-4" /> {mappingSaving ? "Đang lưu mapping..." : "Lưu Mapping"}</button>
                  </div>
                </section>
              )}

              {editing && (
                <section className="rounded-2xl border border-slate-200 bg-slate-50/60 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h4 className="text-sm font-bold text-slate-900">Phiên bản Template (HTML/PDF Engine)</h4>
                      <p className="text-[11px] text-slate-500">
                        Quy trình: Upload DOCX hoặc dán HTML → tạo version DRAFT → Preview → Xuất bản phiên bản.
                        Mỗi version: DRAFT → PUBLISHED → ARCHIVED. PDF snapshot template_version lúc tạo;
                        chỉ version PUBLISHED được dùng cho batch HTML/PDF.{" "}
                        {editing.currentPublishedVersion
                          ? `Đang publish: v${editing.currentPublishedVersion}`
                          : "Chưa có version HTML được publish (batch vẫn dùng Google Docs)."}
                      </p>
                      <p className="mt-1 text-[11px] text-slate-400">
                        Bản nháp (DRAFT): bấm <b>Sửa HTML/CSS</b> (cạnh Xem trước) → sửa <b>HTML hiện tại</b> +{" "}
                        <b>Print CSS hiện tại</b> → <b>Lưu bản nháp</b> (PATCH trực tiếp, editor không đóng) →{" "}
                        <b>Xem trước A4</b> với dữ liệu thật → Lưu lại nhiều lần nếu cần. PUBLISHED/ARCHIVED là bất
                        biến — chỉ xem được ở chế độ chỉ đọc (Xem HTML/CSS).
                      </p>
                      <p className="mt-1 text-[11px] text-slate-400">
                        Xuất bản sẽ bị chặn nếu có placeholder chưa từng mapping, hoặc placeholder đang bật
                        &quot;bắt buộc&quot; mà chưa có nguồn dữ liệu/giá trị mặc định. Placeholder không bắt buộc
                        luôn được phép để trống (không cần gán dữ liệu giả) — vào tab Mapping để đổi trạng thái
                        &quot;bắt buộc&quot; của từng placeholder.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void syncFromGoogleDoc()}
                      disabled={syncingGoogleDoc || versionAction !== null}
                      className="shrink-0 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                      title="Đọc Google Doc hiện tại và tạo một phiên bản HTML DRAFT mới. Không tự xuất bản."
                    >
                      {syncingGoogleDoc ? "Đang đồng bộ..." : "Đồng bộ Google Doc → phiên bản HTML mới"}
                    </button>
                  </div>

                  {/* PHẢN HỒI LUÔN NHÌN THẤY ĐƯỢC — nằm trong panel phiên bản
                      (bên trong modal "Sửa Template"), không bị overlay che.
                      Mọi click "Xuất bản phiên bản"/"Khôi phục" không mở được
                      checklist đều phải để lại thông báo ở đây, không im lặng. */}
                  {versionPanelError && (
                    <div
                      role="alert"
                      className="mt-3 flex items-start justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs font-semibold text-amber-800"
                    >
                      <span>{versionPanelError}</span>
                      <button
                        type="button"
                        onClick={() => setVersionPanelError(null)}
                        className="shrink-0 rounded-md px-2 py-0.5 text-amber-700 hover:bg-amber-100"
                        aria-label="Đóng thông báo"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}

                  {versionsLoading ? (
                    <div className="mt-3 rounded-xl bg-white p-6 text-center text-xs text-slate-500">Đang tải phiên bản...</div>
                  ) : (
                    <div className="mt-3 space-y-2">
                      {versions.length === 0 && (
                        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-4 text-center text-xs text-slate-500">
                          Chưa có version nào. Tạo version DRAFT đầu tiên bên dưới.
                        </div>
                      )}
                      {versions.map((version) => (
                        <div
                          key={version.id}
                          className={`flex flex-col gap-2 rounded-xl border p-3 sm:flex-row sm:items-center ${
                            highlightVersionId === version.id
                              ? "border-emerald-400 bg-emerald-50/50 ring-2 ring-emerald-300"
                              : "border-slate-200 bg-white"
                          }`}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-xs font-bold text-slate-800">v{version.version}</span>
                              {highlightVersionId === version.id && (
                                <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700">
                                  vừa tạo
                                </span>
                              )}
                              <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                                version.status === "PUBLISHED"
                                  ? "bg-emerald-100 text-emerald-700"
                                  : version.status === "DRAFT"
                                    ? "bg-amber-100 text-amber-700"
                                    : "bg-slate-100 text-slate-500"
                              }`}>
                                {version.status}
                              </span>
                              {version.retentionYears !== null && version.retentionYears !== undefined && (
                                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-600">
                                  Retention {version.retentionYears} năm
                                </span>
                              )}
                              {version.retentionYears === null && (
                                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-600">
                                  Không tự xoá
                                </span>
                              )}
                              <span className="text-[10px] text-slate-400">
                                {version.mappingSnapshot?.length ?? 0} placeholder snapshot
                              </span>
                            </div>
                            <p className="mt-1 line-clamp-1 font-mono text-[10px] text-slate-400">
                              {version.sourceDocxName || `Tạo bởi ${version.createdBy}`}
                              {version.publishedAt ? ` · Publish ${new Date(version.publishedAt).toLocaleString("vi-VN")}` : ""}
                            </p>
                          </div>
                          <div className="flex shrink-0 flex-wrap gap-1.5">
                            {/* XEM TRƯỚC — chỉ đọc. KHÔNG publish, không đổi
                                current_published_version, không tạo job. */}
                            <button
                              type="button"
                              disabled={versionAction !== null}
                              onClick={() =>
                                setPreviewVersion({
                                  id: version.id,
                                  version: version.version,
                                  status: version.status,
                                  mappingSnapshotCount: version.mappingSnapshot?.length ?? 0,
                                })
                              }
                              title="Xem trước phiên bản này với một ứng viên có thật. KHÔNG xuất bản, không tạo job, không sửa dữ liệu."
                              className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-[10px] font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                            >
                              Xem trước
                            </button>
                            {/* SỬA HTML/CSS — NGAY CẠNH "Xem trước", CHỈ DRAFT.
                                Mở DraftVersionEditorModal nạp thẳng
                                html_body/print_css của ĐÚNG versionId này
                                (không qua current_published_version, không tạo
                                version mới); Lưu = PATCH, editor không đóng. */}
                            {version.status === "DRAFT" && (
                              <button
                                type="button"
                                disabled={versionAction !== null}
                                onClick={() => {
                                  setHighlightVersionId(null);
                                  setEditDraftVersion({
                                    id: version.id,
                                    version: version.version,
                                    status: version.status,
                                    htmlBody: version.htmlBody,
                                    printCss: version.printCss,
                                  });
                                }}
                                title="Sửa HTML/CSS của bản DRAFT này: nạp HTML + Print CSS hiện tại, Lưu bản nháp (PATCH), Xem trước A4 rồi Lưu lại nhiều lần. Server chỉ cho phép UPDATE khi version còn là DRAFT."
                                className="rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-[10px] font-bold text-amber-700 hover:bg-amber-100 disabled:opacity-50"
                              >
                                Sửa HTML/CSS
                              </button>
                            )}
                            {/* XEM HTML/CSS — CHỈ ĐỌC cho PUBLISHED/ARCHIVED
                                (những version KHÔNG có nút sửa). Viewer thuần
                                presentational: hiển thị html_body/print_css đã
                                lưu của chính versionId này, không gọi API,
                                không ghi DB. Muốn sửa → "Tạo bản nháp". */}
                            {version.status !== "DRAFT" && (
                              <button
                                type="button"
                                disabled={versionAction !== null}
                                onClick={() => {
                                  setViewHtmlVersion({
                                    id: version.id,
                                    version: version.version,
                                    status: version.status,
                                    htmlBody: version.htmlBody,
                                    printCss: version.printCss,
                                  });
                                }}
                                title="Xem HTML/CSS đã lưu của phiên bản này ở chế độ chỉ đọc. PUBLISHED/ARCHIVED là bất biến — muốn sửa hãy tạo bản nháp từ phiên bản này."
                                className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-[10px] font-bold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                              >
                                Xem HTML/CSS
                              </button>
                            )}
                            {/* TẢI GÓI AI (H1) — export template.html + print.css +
                                template-manifest.json + README-AI.md dạng ZIP, để đưa
                                cho AI chỉnh sửa. READ-ONLY — chỉ GET, không ghi DB. */}
                            <button
                              type="button"
                              disabled={versionAction !== null}
                              onClick={() =>
                                window.open(
                                  `/api/document-merge/templates/${editing?.id}/versions/${version.id}/ai-export`,
                                  "_blank",
                                  "noopener",
                                )
                              }
                              title="Tải gói HTML/CSS + manifest + README-AI của phiên bản này để đưa cho AI chỉnh sửa. Không thay đổi gì trên hệ thống."
                              className="rounded-lg border border-violet-300 bg-violet-50 px-2.5 py-1.5 text-[10px] font-bold text-violet-700 hover:bg-violet-100 disabled:opacity-50"
                            >
                              Tải gói AI
                            </button>
                            {/* TẠO BẢN NHÁP TỪ PHIÊN BẢN NÀY — clone sang version
                                DRAFT mới; version nguồn bất biến, không publish. */}
                            <button
                              type="button"
                              disabled={versionAction !== null || cloning}
                              onClick={() => {
                                setHighlightVersionId(null);
                                setCloneConfirmVersion({
                                  id: version.id,
                                  version: version.version,
                                  status: version.status,
                                });
                              }}
                              title="Tạo một phiên bản DRAFT mới sao chép HTML/CSS từ phiên bản này. Phiên bản nguồn không bị thay đổi."
                              className="rounded-lg border border-sky-300 bg-sky-50 px-2.5 py-1.5 text-[10px] font-bold text-sky-700 hover:bg-sky-100 disabled:opacity-50"
                            >
                              Tạo bản nháp từ phiên bản này
                            </button>
                            {/* XUẤT BẢN PHIÊN BẢN — CHỈ DRAFT. Nút này KHÔNG
                                tự validate gì (KHÔNG gate bằng analyzeResult /
                                mapping snapshot / current_published_version):
                                disabled duy nhất khi một version action khác
                                đang chạy (versionAction !== null). Mọi kiểm
                                tra (HTML/CSS, placeholder/mapping, A4/PDF,
                                trạng thái) đều nằm TRONG PublishChecklistModal
                                — mở checklist xong checklist mới quyết định
                                có cho confirm hay không (hiện rõ lý do cụ thể
                                khi FAIL). PUBLISHED KHÔNG có nút (re)publish
                                (backend là no-op — tránh thao tác vô nghĩa);
                                ARCHIVED đi qua nút "Khôi phục" bên dưới. */}
                            {version.status === "DRAFT" && (
                              <button
                                type="button"
                                onClick={() => openPublishChecklist(version, "publish")}
                                title="Xuất bản version DRAFT này — version PUBLISHED trở thành bản render cho batch HTML/PDF (chỉ 1 version PUBLISHED/template). Mở checklist xác nhận (HTML/CSS, placeholder/mapping, A4/PDF, trạng thái) trước khi xuất bản."
                                className="rounded-lg bg-emerald-700 px-2.5 py-1.5 text-[10px] font-bold text-white hover:bg-emerald-800"
                              >
                                Xuất bản phiên bản
                              </button>
                            )}
                            {version.status !== "PUBLISHED" && version.status !== "ARCHIVED" && (
                              <button
                                disabled={versionAction !== null}
                                onClick={() => runVersionAction(version, "archive")}
                                title="Lưu trữ version này (không được archive version đang PUBLISHED)."
                                className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-[10px] font-semibold text-slate-500 hover:bg-slate-50 disabled:opacity-50"
                              >
                                Lưu trữ
                              </button>
                            )}
                            {version.status === "ARCHIVED" && (
                              <button
                                type="button"
                                onClick={() => openPublishChecklist(version, "rollback")}
                                title="Khôi phục: publish lại version ARCHIVED này làm bản hiện hành. Mở checklist xác nhận trước khi xuất bản lại."
                                className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-[10px] font-semibold text-slate-600 hover:bg-slate-50"
                              >
                                Khôi phục
                              </button>
                            )}
                            {/* XÓA BẢN NHÁP — chỉ DRAFT. Mở confirmation modal;
                                server re-check DRAFT trong transaction trước
                                khi DELETE, nên UI chỉ là lớp bảo vệ thứ nhất. */}
                            {version.status === "DRAFT" && (
                              <button
                                type="button"
                                disabled={versionAction !== null || cloning || deleting}
                                onClick={() => {
                                  setHighlightVersionId(null);
                                  setDeleteConfirmVersion({
                                    id: version.id,
                                    version: version.version,
                                    status: version.status,
                                  });
                                }}
                                title="Xoá vĩnh viễn bản nháp này (chỉ version DRAFT). Không thể hoàn tác. Server sẽ từ chối nếu version đã đổi trạng thái."
                                className="rounded-lg border border-red-200 bg-red-50 px-2.5 py-1.5 text-[10px] font-bold text-red-700 hover:bg-red-100 disabled:opacity-50"
                              >
                                Xóa bản nháp
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* H1 — HỖ TRỢ CẬP NHẬT TEMPLATE BẰNG AI (TemplateChangeAnalyzer).
                      READ-ONLY: xuất gói AI + phân tích thay đổi. Hiện ngay khi có
                      bất kỳ version nào (DRAFT/PUBLISHED/ARCHIVED) — KHÔNG giấu
                      sau feature flag, KHÔNG yêu cầu DRAFT, KHÔNG ghi DB. */}
                  <TemplateChangeAnalyzer templateId={editing.id} versions={versions} />

                  <div className="mt-4 rounded-xl border border-slate-200 bg-white p-3">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <p className="text-xs font-bold text-slate-800">Tạo version DRAFT mới</p>
                      <div className="flex items-center gap-2">
                        <input
                          ref={docxInputRef}
                          type="file"
                          accept=".docx"
                          className="hidden"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) importDocx(file);
                          }}
                        />
                        <button
                          onClick={() => docxInputRef.current?.click()}
                          disabled={docxImporting}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                        >
                          <FileUp className="h-3.5 w-3.5" /> {docxImporting ? "Đang import DOCX..." : "Upload DOCX"}
                        </button>
                      </div>
                    </div>
                    <p className="mt-1 text-[11px] text-amber-700">
                      Import DOCX tạo version DRAFT — conversion không giữ layout 100%, hãy Preview và kiểm tra trước khi Publish.
                    </p>
                    <div className="mt-2 grid gap-3">
                      <label className="text-[11px] font-semibold text-slate-600">
                        {"HTML body (print template A4, chứa placeholder <<...>>) *"}
                        <textarea
                          value={draftHtml}
                          onChange={(e) => setDraftHtml(e.target.value)}
                          rows={10}
                          spellCheck={false}
                          placeholder={'<div class="page">\n  <p>Họ tên: <<Ho_ten>></p>\n</div>'}
                          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-[11px] outline-none focus:border-emerald-600"
                        />
                      </label>
                      <label className="text-[11px] font-semibold text-slate-600">
                        Print CSS (tuỳ chọn — CSS A4 chung được tự thêm)
                        <textarea
                          value={draftCss}
                          onChange={(e) => setDraftCss(e.target.value)}
                          rows={4}
                          spellCheck={false}
                          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-[11px] outline-none focus:border-emerald-600"
                        />
                      </label>
                      <label className="text-[11px] font-semibold text-slate-600">
                        Retention (snapshot vào từng PDF khi tạo)
                        <select
                          value={draftRetention}
                          onChange={(e) => setDraftRetention(e.target.value)}
                          className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-[11px] outline-none focus:border-emerald-600 sm:w-56"
                        >
                          <option value="1">1 năm</option>
                          <option value="2">2 năm</option>
                          <option value="3">3 năm (mặc định)</option>
                          <option value="5">5 năm</option>
                          <option value="10">10 năm</option>
                          <option value="none">Không tự động xóa</option>
                        </select>
                      </label>
                      <div className="flex justify-end">
                        <button
                          onClick={createDraftVersion}
                          disabled={draftSaving}
                          className="inline-flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-xs font-bold text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
                        >
                          <Plus className="h-3.5 w-3.5" /> {draftSaving ? "Đang tạo..." : "Tạo version DRAFT"}
                        </button>
                      </div>
                    </div>
                  </div>
                </section>
              )}
            </div>
          </div>
        </div>
      )}

      {editing && previewVersion && (
        <DraftVersionPreviewModal
          templateId={editing.id}
          templateName={editing.name}
          version={previewVersion}
          onClose={() => setPreviewVersion(null)}
        />
      )}

      {editing && publishChecklistTarget && (
        <PublishChecklistModal
          templateId={editing.id}
          templateName={editing.name}
          target={publishChecklistTarget.version}
          currentPublishedVersionId={versions.find((v) => v.status === "PUBLISHED")?.id ?? null}
          currentPublishedVersionNumber={versions.find((v) => v.status === "PUBLISHED")?.version ?? null}
          action={publishChecklistTarget.action}
          onClose={() => setPublishChecklistTarget(null)}
          onConfirmed={async () => {
            const ok = await runVersionAction(publishChecklistTarget.version, publishChecklistTarget.action, true);
            if (ok) setPublishChecklistTarget(null);
          }}
        />
      )}

      {editing && cloneConfirmVersion && (
        <VersionCloneConfirmModal
          templateName={editing.name}
          version={cloneConfirmVersion}
          cloning={cloning}
          onCancel={() => setCloneConfirmVersion(null)}
          onConfirm={() => void confirmCloneVersion()}
        />
      )}

      {editing && deleteConfirmVersion && (
        <VersionDeleteConfirmModal
          templateName={editing.name}
          version={deleteConfirmVersion}
          deleting={deleting}
          onCancel={() => setDeleteConfirmVersion(null)}
          onConfirm={() => void confirmDeleteVersion()}
        />
      )}

      {editing && editDraftVersion && (
        <DraftVersionEditorModal
          templateId={editing.id}
          templateName={editing.name}
          version={editDraftVersion}
          onCancel={() => setEditDraftVersion(null)}
          onSaved={(versionId) => {
            // LƯU THÀNH CÔNG → KHÔNG ĐÓNG EDITOR: giữ DraftVersionEditorModal
            // mở để operator tiếp tục vòng sửa → Xem trước A4 → Lưu nhiều lần
            // trên cùng versionId DRAFT. Chỉ refresh danh sách phiên bản phía
            // sau (danh sách mới có nội dung vừa lưu) + highlight card.
            setHighlightVersionId(versionId);
            void loadVersions(editing.id);
          }}
        />
      )}

      {editing && viewHtmlVersion && (
        <VersionHtmlViewerModal
          templateName={editing.name}
          version={viewHtmlVersion}
          onClose={() => setViewHtmlVersion(null)}
        />
      )}
    </div>
  );
}
