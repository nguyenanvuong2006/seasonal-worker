"use client";

import { Component, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertCircle,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Eye,
  FileCheck,
  RefreshCw,
  Save,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import {
  documentKindLabel,
  resolveDocumentKind,
  resolveDwClassification,
} from "@/lib/document-merge/template-routing";
import { JobProgressPanel } from "@/components/document-merge/job-progress-panel";
import { CandidateDocumentsStatusPanel } from "@/components/document-merge/candidate-documents-status-panel";
import {
  normalizePreviewResponse,
  type SafePreviewResult,
} from "@/lib/document-merge/preview-response";
import { ALLOWED_IDENTIFIERS, parseFormula, resolveFormula } from "@/lib/document-merge/formula-dsl";

type MergeTemplate = {
  id: string;
  name: string;
  googleDocId: string;
  defaultMergeMode: "ONE_DOCUMENT" | "INDIVIDUAL_DOCUMENTS";
  documentKind?: string;
  isActive: boolean;
  placeholderCount?: number;
};

type ApplicantRow = {
  id: string;
  fullName: string;
  cccd: string;
  phone?: string | null;
  gender?: string | null;
  declaredType?: string | null;
  dwMatch?: string | null;
  deptName?: string | null;
  groupName?: string | null;
  status?: string | null;
  startingDate?: string | null;
  mergedDocUrl?: string | null;
  documentSentAt?: string | null;
  signatureConfirmedAt?: string | null;
};

// Preview state — LUÔN là kết quả đã qua normalizePreviewResponse().
// INCIDENT FIX: không bao giờ đưa payload API thô vào state; mọi field mà UI
// dereference (missingFields, unreplaced, …) được đảm bảo đúng kiểu.
type PreviewResult = SafePreviewResult;

type Diagnostic = {
  code: string;
  error: string;
  action?: string;
  details?: string;
};

type MergeField = {
  id: string;
  templateId: string;
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

type CatalogField = {
  fieldKey: string;
  label: string;
  category: string;
  databaseSource: string;
  fieldType: string;
  isMergeable: boolean;
};

const SOURCE_TYPES = [
  "CORE_FIELD",
  "DYNAMIC_ANSWER",
  "RELATED_FIELD",
  "COMPUTED_FIELD",
  "COMPUTED",
  "SYSTEM_FIELD",
  "STATIC_TEXT",
  "CHECKBOX_OPTION",
];

// H3 — Safe Formula DSL V1 (COMPUTED source type). Purely client-side,
// dependency-free validation/preview — never sent to a server, never a
// JS eval: parseFormula/resolveFormula only ever tokenize -> parse ->
// validate -> evaluate against the closed 8-function whitelist.
const COMPUTED_FUNCTIONS_HELP =
  "day(x) · month(x) · year(x) · formatDate(x, \"dd/MM/yyyy\") · upper(x) · trim(x) · coalesce(a,b,...) · concat(a,b,...)";

/** Synthetic sample values for "Thử công thức" — never real candidate/PII data. */
const COMPUTED_SAMPLE_CONTEXT: Record<(typeof ALLOWED_IDENTIFIERS)[number], string | null> = {
  SigningDate: "2026-08-26",
  SigningLocation: "Đà Lạt",
  DocumentDate: "2026-08-20",
  ReceivedDate: "2026-08-15",
  ReceivedBy: "Nguyễn Văn A",
  SigningLatitude: null,
  SigningLongitude: null,
  SigningLocationCapturedAt: null,
};

const FORMAT_TYPES = [
  ["RAW", "Nguyên gốc"],
  ["DATE_DDMMYYYY", "Ngày DD/MM/YYYY"],
  ["DATE_DD_MM_YYYY", "Ngày DD-MM-YYYY"],
  ["DATE_DDMMYYYY_HHMM", "Ngày giờ"],
  ["UPPERCASE", "IN HOA"],
  ["LOWERCASE", "in thường"],
  ["TITLE_CASE", "Viết hoa đầu từ"],
  ["NUMBER", "Số"],
  ["CURRENCY_VND", "Tiền VND"],
  ["VIETNAMESE_NUMBER_WORDS", "Số bằng chữ"],
  ["BOOLEAN_CHECKBOX", "Checkbox ☒/☐"],
] as const;

function daysAgo(n: number): string {
  const date = new Date();
  date.setDate(date.getDate() - n);
  return date.toISOString().slice(0, 10);
}

function isMappedField(field: MergeField): boolean {
  if (field.isOrphaned) return false;
  if (field.sourceType === "STATIC_TEXT") return true;
  return Boolean(field.sourceField || field.sourcePath);
}

/**
 * COMPUTED formula validation + "Thử công thức" preview — Phase 22/23.
 * Runs entirely client-side against synthetic Signing Context sample values
 * (never a real candidate's data); never a JS editor, never an eval mode.
 */
function ComputedFormulaStatus({ expression }: { expression: string }) {
  const trimmed = expression.trim();
  if (!trimmed) {
    return <p className="mt-1 text-[10px] text-slate-400">Nhập công thức, ví dụ: year(SigningDate)</p>;
  }
  const parsed = parseFormula(trimmed);
  if (!parsed.ok) {
    return <p className="mt-1 text-[10px] font-semibold text-red-600">✕ {parsed.error.message}</p>;
  }
  const tried = resolveFormula(trimmed, COMPUTED_SAMPLE_CONTEXT);
  return (
    <p className="mt-1 text-[10px] font-semibold text-emerald-700">
      ✓ Công thức hợp lệ{tried.ok ? ` · Kết quả mẫu: "${tried.value}"` : ""}
    </p>
  );
}

function DiagnosticBox({ diagnostic }: { diagnostic: Diagnostic }) {
  const [showDetails, setShowDetails] = useState(false);
  return (
    <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-xs text-red-800">
      <div className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-bold">{diagnostic.error}</span>
            <span className="rounded-full bg-red-100 px-2 py-0.5 font-mono text-[10px] font-bold text-red-700">
              {diagnostic.code}
            </span>
          </div>
          {diagnostic.action && <p className="mt-1 text-red-700">Cách xử lý: {diagnostic.action}</p>}
          {diagnostic.details && (
            <div className="mt-2">
              <button
                type="button"
                onClick={() => setShowDetails((value) => !value)}
                className="inline-flex items-center gap-1 font-semibold text-red-700 underline underline-offset-2"
              >
                {showDetails ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                {showDetails ? "Ẩn chi tiết kỹ thuật" : "Xem chi tiết kỹ thuật"}
              </button>
              {showDetails && (
                <pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap rounded-lg bg-white/80 p-2 font-mono text-[10px] text-red-900">
                  {diagnostic.details}
                </pre>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * PREVIEW ERROR BOUNDARY — incident fix.
 *
 * Sự cố production: một TypeError trong lúc render kết quả Preview đã unmount
 * TOÀN BỘ route /admin/document-merge ("This page couldn't load") vì app
 * không có error boundary nào. Boundary này giam MỌI lỗi render của panel
 * Preview lại bên trong panel, hiển thị thông báo tiếng Việt và cho phép
 * thử lại — phần còn lại của trang (danh sách ứng viên, nút merge) vẫn dùng
 * được bình thường.
 */
class PreviewErrorBoundary extends Component<
  { resetKey: string; onReset: () => void; children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidUpdate(prevProps: { resetKey: string }) {
    // Chọn ứng viên khác / bấm thử lại → cho boundary render lại từ đầu.
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-xs text-red-800">
          <div className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="font-bold">Không hiển thị được bản xem trước.</p>
              <p className="mt-1 text-red-700">
                Đã xảy ra lỗi khi hiển thị Preview. Trang vẫn hoạt động bình thường — chọn lại ứng viên hoặc bấm thử lại.
              </p>
              <pre className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap rounded-lg bg-white/80 p-2 font-mono text-[10px] text-red-900">
                {this.state.error.message}
              </pre>
              <button
                type="button"
                onClick={() => {
                  this.setState({ error: null });
                  this.props.onReset();
                }}
                className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-red-300 bg-white px-3 py-1.5 font-semibold text-red-800"
              >
                <RefreshCw className="h-3.5 w-3.5" /> Thử lại Preview
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function MappingInspector({ template }: { template: MergeTemplate | undefined }) {
  const [open, setOpen] = useState(true);
  const [fields, setFields] = useState<MergeField[]>([]);
  const [catalog, setCatalog] = useState<CatalogField[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("ALL");
  const [message, setMessage] = useState<string | null>(null);

  const load = async () => {
    if (!template?.id) {
      setFields([]);
      return;
    }
    setLoading(true);
    setMessage(null);
    try {
      const [fieldsRes, catalogRes] = await Promise.all([
        fetch(`/api/document-merge/templates/${template.id}/fields`),
        fetch("/api/document-merge/field-catalog"),
      ]);
      const fieldsData = await fieldsRes.json();
      const catalogData = await catalogRes.json();
      if (!fieldsRes.ok) throw new Error(fieldsData.error || "Không tải được mapping");
      setFields(Array.isArray(fieldsData) ? fieldsData : []);
      setCatalog(Array.isArray(catalogData?.catalog) ? catalogData.catalog : []);
      setDirty(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Không tải được Mapping Inspector");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template?.id]);

  const updateField = (id: string, patch: Partial<MergeField>) => {
    setFields((current) => current.map((field) => (field.id === id ? { ...field, ...patch } : field)));
    setDirty(true);
  };

  const save = async () => {
    if (!template?.id || !dirty) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/document-merge/templates/${template.id}/fields`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Lưu mapping thất bại");
      setMessage(`Đã lưu ${Array.isArray(data) ? data.length : fields.length} mapping.`);
      setDirty(false);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Lưu mapping thất bại");
    } finally {
      setSaving(false);
    }
  };

  const scan = async () => {
    if (!template?.id) return;
    setScanning(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/document-merge/templates/${template.id}/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ googleDocId: template.googleDocId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Quét Google Docs thất bại");
      setMessage(
        `Đã quét ${data.placeholders?.length ?? 0} placeholder · ${data.newFields?.length ?? 0} mới · ${data.orphanedFields?.length ?? 0} orphaned.`,
      );
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Quét Google Docs thất bại");
    } finally {
      setScanning(false);
    }
  };

  const active = fields.filter((field) => !field.isOrphaned);
  const mapped = active.filter(isMappedField).length;
  const missing = active.length - mapped;
  const orphaned = fields.filter((field) => field.isOrphaned).length;

  const visibleFields = fields.filter((field) => {
    const q = query.toLowerCase().trim();
    if (q && !`${field.placeholder} ${field.sourceField ?? ""} ${field.sourcePath ?? ""}`.toLowerCase().includes(q)) return false;
    if (status === "MATCHED" && !isMappedField(field)) return false;
    if (status === "MISSING" && (isMappedField(field) || field.isOrphaned)) return false;
    if (status === "ORPHANED" && !field.isOrphaned) return false;
    if (status === "REQUIRED" && !field.isRequired) return false;
    return true;
  });

  if (!template) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-800">
        Chưa xác định được template thực tế. Chọn một template thủ công hoặc bật Auto Route để kiểm tra mapping.
      </div>
    );
  }

  return (
    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xs">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-3 p-4 text-left"
      >
        <div className="flex min-w-0 items-center gap-2">
          <Settings2 className="h-4 w-4 shrink-0 text-emerald-700" />
          <div className="min-w-0">
            <h3 className="truncate text-sm font-bold text-slate-900">Mapping Inspector · {template.name}</h3>
            <p className="truncate text-[11px] text-slate-500">Google Doc: {template.googleDocId}</p>
          </div>
        </div>
        {open ? <ChevronUp className="h-4 w-4 text-slate-400" /> : <ChevronDown className="h-4 w-4 text-slate-400" />}
      </button>

      {open && (
        <div className="border-t border-slate-100 p-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              ["Placeholders", active.length, "text-slate-900"],
              ["Matched", mapped, "text-emerald-700"],
              ["Missing", missing, missing ? "text-red-700" : "text-emerald-700"],
              ["Orphaned", orphaned, orphaned ? "text-amber-700" : "text-slate-500"],
            ].map(([label, value, color]) => (
              <div key={String(label)} className="rounded-lg bg-slate-50 p-2.5">
                <p className="text-[10px] uppercase tracking-wide text-slate-400">{label}</p>
                <p className={`mt-0.5 text-lg font-black ${color}`}>{value}</p>
              </div>
            ))}
          </div>

          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Tìm placeholder / source field"
                className="w-full rounded-lg border border-slate-200 py-2 pl-8 pr-3 text-xs"
              />
            </div>
            <select value={status} onChange={(event) => setStatus(event.target.value)} className="rounded-lg border border-slate-200 px-3 py-2 text-xs">
              <option value="ALL">Tất cả</option>
              <option value="MATCHED">Matched</option>
              <option value="MISSING">Missing</option>
              <option value="ORPHANED">Orphaned</option>
              <option value="REQUIRED">Required</option>
            </select>
            <button
              type="button"
              onClick={() => void scan()}
              disabled={scanning}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${scanning ? "animate-spin" : ""}`} />
              {scanning ? "Đang quét..." : "Quét lại Google Docs"}
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={!dirty || saving}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-emerald-700 px-3 py-2 text-xs font-bold text-white disabled:opacity-40"
            >
              <Save className="h-3.5 w-3.5" /> {saving ? "Đang lưu..." : "Lưu Mapping"}
            </button>
          </div>

          {message && <p className="mt-2 rounded-lg bg-slate-50 p-2 text-[11px] text-slate-600">{message}</p>}
          {dirty && <p className="mt-2 text-[11px] font-semibold text-amber-700">Có thay đổi mapping chưa lưu.</p>}
          {fields.some((field) => field.sourceType === "COMPUTED") && (
            <div className="mt-2 rounded-lg border border-emerald-200 bg-emerald-50/60 p-2 text-[10px] text-emerald-900">
              <p className="font-bold">Source Type = COMPUTED — Công thức (Safe Formula DSL V1)</p>
              <p className="mt-1">Nhập vào ô Source Path. 8 hàm được hỗ trợ: {COMPUTED_FUNCTIONS_HELP}</p>
              <p className="mt-1">Biến Signing Context: {ALLOWED_IDENTIFIERS.join(", ")}</p>
              <p className="mt-1 text-emerald-700/80">Không hỗ trợ JavaScript/eval — công thức chỉ được phép dùng các hàm và biến ở trên.</p>
            </div>
          )}

          <datalist id={`merge-fields-${template.id}`}>
            {catalog.filter((item) => item.isMergeable).map((item) => (
              <option key={`${item.category}-${item.fieldKey}`} value={item.fieldKey}>{item.label} · {item.databaseSource}</option>
            ))}
            <option value="DATE_DAY">Ngày — phần ngày</option>
            <option value="DATE_MONTH">Ngày — phần tháng</option>
            <option value="DATE_YEAR">Ngày — phần năm</option>
            <option value="CURRENT_USER_NAME">Người thực hiện</option>
          </datalist>

          <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200">
            {loading ? (
              <p className="p-6 text-center text-xs text-slate-400">Đang tải mapping...</p>
            ) : (
              <table className="min-w-[1100px] w-full text-left text-[11px]">
                <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-2">Placeholder</th>
                    <th className="px-3 py-2">Trạng thái</th>
                    <th className="px-3 py-2">Source Type</th>
                    <th className="px-3 py-2">Source Field</th>
                    <th className="px-3 py-2">Source Path</th>
                    <th className="px-3 py-2">Formatter</th>
                    <th className="px-3 py-2">Option</th>
                    <th className="px-3 py-2 text-center">Required</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {visibleFields.map((field) => {
                    const matched = isMappedField(field);
                    return (
                      <tr key={field.id} className={field.isOrphaned ? "bg-amber-50/50" : ""}>
                        <td className="px-3 py-2 font-mono font-semibold text-emerald-800">&lt;&lt;{field.placeholder}&gt;&gt;</td>
                        <td className="px-3 py-2">
                          <span className={`rounded-full px-2 py-0.5 text-[9px] font-bold ${
                            field.isOrphaned
                              ? "bg-amber-100 text-amber-800"
                              : matched
                                ? "bg-emerald-100 text-emerald-800"
                                : "bg-red-100 text-red-700"
                          }`}>
                            {field.isOrphaned ? "ORPHANED" : matched ? field.isSuggested ? "SUGGESTED" : "MATCHED" : "MISSING"}
                          </span>
                        </td>
                        <td className="px-2 py-1.5">
                          <select
                            value={field.sourceType}
                            onChange={(event) => updateField(field.id, { sourceType: event.target.value })}
                            className="w-full rounded border border-slate-200 px-2 py-1.5"
                          >
                            {SOURCE_TYPES.map((item) => <option key={item} value={item}>{item}</option>)}
                          </select>
                        </td>
                        <td className="px-2 py-1.5">
                          <input
                            list={`merge-fields-${template.id}`}
                            value={field.sourceField ?? ""}
                            onChange={(event) => updateField(field.id, { sourceField: event.target.value || null })}
                            disabled={field.sourceType === "COMPUTED"}
                            className="w-full rounded border border-slate-200 px-2 py-1.5 font-mono disabled:bg-slate-50 disabled:text-slate-300"
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <input
                            value={field.sourcePath ?? ""}
                            onChange={(event) => updateField(field.id, { sourcePath: event.target.value || null })}
                            placeholder={field.sourceType === "COMPUTED" ? "vd: year(SigningDate)" : "vd: customAnswers.email"}
                            className="w-full rounded border border-slate-200 px-2 py-1.5 font-mono"
                          />
                          {field.sourceType === "COMPUTED" && <ComputedFormulaStatus expression={field.sourcePath ?? ""} />}
                        </td>
                        <td className="px-2 py-1.5">
                          <select
                            value={field.formatType ?? "RAW"}
                            onChange={(event) => updateField(field.id, { formatType: event.target.value })}
                            className="w-full rounded border border-slate-200 px-2 py-1.5"
                          >
                            {FORMAT_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                          </select>
                        </td>
                        <td className="px-2 py-1.5">
                          <input
                            value={field.optionValue ?? ""}
                            onChange={(event) => updateField(field.id, { optionValue: event.target.value || null })}
                            disabled={field.sourceType !== "CHECKBOX_OPTION"}
                            className="w-full rounded border border-slate-200 px-2 py-1.5 disabled:bg-slate-50 disabled:text-slate-300"
                          />
                        </td>
                        <td className="px-3 py-2 text-center">
                          <input
                            type="checkbox"
                            checked={field.isRequired}
                            onChange={(event) => updateField(field.id, { isRequired: event.target.checked })}
                            className="accent-emerald-700"
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

export function MergeWorkspace({
  selectedTemplateId,
  onSelectTemplateId,
  onSwitchToHistory,
}: {
  selectedTemplateId: string;
  onSelectTemplateId: (id: string) => void;
  onSwitchToHistory: () => void;
}) {
  const [templates, setTemplates] = useState<MergeTemplate[]>([]);
  const [templateId, setTemplateId] = useState(selectedTemplateId);
  const [autoRoute, setAutoRoute] = useState(false);
  const [batchPrint, setBatchPrint] = useState(true);
  const [records, setRecords] = useState<ApplicantRow[]>([]);
  const [loadingRecords, setLoadingRecords] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [previewTargetId, setPreviewTargetId] = useState<string>("");
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [isMerging, setIsMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [diagnostic, setDiagnostic] = useState<Diagnostic | null>(null);
  // --- Async engines — Phase 11 + GOOGLE_DOCS async worker (sự cố 28–29/08) ---
  const [engine, setEngine] = useState<"GOOGLE_DOCS" | "HTML_PDF">("GOOGLE_DOCS");
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  // --- Cá nhân hoá + Xác nhận điện tử: "Tạo & gửi hồ sơ xác nhận" ---
  const [issuing, setIssuing] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);
  const [issueResult, setIssueResult] = useState<{ total: number } | null>(null);

  useEffect(() => {
    fetch("/api/document-merge/engine", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => {
        if (data.engine === "HTML_PDF") setEngine("HTML_PDF");
      })
      .catch(() => setEngine("GOOGLE_DOCS"));
  }, []);

  useEffect(() => {
    if (selectedTemplateId) setTemplateId(selectedTemplateId);
  }, [selectedTemplateId]);

  useEffect(() => {
    fetch("/api/document-merge/templates")
      .then((res) => res.json())
      .then((data) => setTemplates(Array.isArray(data) ? data : []))
      .catch(() => setTemplates([]));
  }, []);

  useEffect(() => {
    setLoadingRecords(true);
    const from = daysAgo(14);
    fetch(`/api/registrations?from=${from}&to=${daysAgo(0)}&assigned=1`)
      .then((res) => res.json())
      .then((data) => {
        const list = Array.isArray(data?.rows) ? data.rows : [];
        setRecords(
          list.map((item: ApplicantRow) => ({
            id: item.id,
            fullName: item.fullName,
            cccd: item.cccd,
            phone: item.phone,
            gender: item.gender,
            declaredType: item.declaredType,
            dwMatch: item.dwMatch,
            deptName: item.deptName,
            groupName: item.groupName,
            status: item.status,
            startingDate: item.startingDate,
            mergedDocUrl: item.mergedDocUrl,
            documentSentAt: item.documentSentAt,
            signatureConfirmedAt: item.signatureConfirmedAt,
          })),
        );
        setSelectedIds(new Set());
      })
      .catch(() => setRecords([]))
      .finally(() => setLoadingRecords(false));
  }, []);

  const filtered = useMemo(() => {
    const q = searchTerm.toLowerCase().trim();
    if (!q) return records;
    return records.filter(
      (row) =>
        row.fullName.toLowerCase().includes(q) ||
        row.cccd.toLowerCase().includes(q) ||
        (row.phone && row.phone.includes(q)),
    );
  }, [records, searchTerm]);

  const selectedTemplate = templates.find((item) => item.id === templateId);
  const selectedRecord = records.find((item) => item.id === previewTargetId) ?? records.find((item) => selectedIds.has(item.id));
  const selectedKind = selectedRecord
    ? resolveDocumentKind({ declaredType: selectedRecord.declaredType, dwMatch: selectedRecord.dwMatch })
    : undefined;
  const routedTemplate = selectedKind
    ? templates.find((item) => item.isActive && item.documentKind === selectedKind)
    : undefined;
  const effectiveTemplate = autoRoute ? routedTemplate : selectedTemplate;
  // HTML/PDF uses an immutable published version of the template the operator
  // selected. Do not silently auto-route a legal PDF to a different version.
  const templateReady = engine === "HTML_PDF" ? Boolean(selectedTemplate) : autoRoute || Boolean(selectedTemplate);

  useEffect(() => {
    if (engine === "HTML_PDF" && autoRoute) setAutoRoute(false);
  }, [engine, autoRoute]);

  const toggleAll = () => {
    if (selectedIds.size === filtered.length && filtered.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filtered.map((row) => row.id)));
    }
  };

  const toggleOne = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
    setPreviewTargetId(id);
  };

  // INCIDENT FIX — chống race khi bấm nhanh nhiều ứng viên: chỉ response của
  // request MỚI NHẤT được phép chạm vào state; response cũ về muộn bị bỏ qua.
  const previewRequestSeq = useRef(0);

  const loadPreview = async (id?: string) => {
    const target = id || previewTargetId || Array.from(selectedIds)[0];
    if (!target) {
      setMergeError("Chọn ít nhất 1 ứng viên để xem trước.");
      return;
    }
    if (!autoRoute && !templateId) {
      setMergeError("Chọn template cố định trước khi Preview.");
      return;
    }
    const seq = ++previewRequestSeq.current;
    setPreviewTargetId(target);
    setPreviewLoading(true);
    setMergeError(null);
    setDiagnostic(null);
    try {
      const res = await fetch("/api/document-merge/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          applicationId: target,
          templateId: autoRoute ? undefined : templateId,
          autoRoute,
        }),
      });
      // INCIDENT FIX — body không phải JSON hợp lệ (edge/proxy error page…)
      // không được ném ra ngoài như network error: parse an toàn.
      let data: Record<string, unknown> = {};
      try {
        const parsed: unknown = await res.json();
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          data = parsed as Record<string, unknown>;
        }
      } catch {
        data = {};
      }
      if (seq !== previewRequestSeq.current) return; // response cũ — bỏ qua
      if (!res.ok) {
        setDiagnostic({
          code: typeof data.code === "string" ? data.code : `HTTP_${res.status}`,
          error: typeof data.error === "string" ? data.error : "Không xem trước được",
          action: typeof data.action === "string" ? data.action : undefined,
          details: typeof data.details === "string" ? data.details : undefined,
        });
        setPreview(null);
        return;
      }
      // INCIDENT FIX — KHÔNG BAO GIỜ set payload thô vào state. Nhánh
      // canonical trả `unresolved` (không có `unreplaced`) từng làm render
      // crash toàn trang. Normalizer đảm bảo mọi field UI đọc đều đúng kiểu.
      setPreview(normalizePreviewResponse(data));
    } catch (error) {
      if (seq !== previewRequestSeq.current) return;
      setPreview(null);
      setDiagnostic({
        code: "NETWORK_ERROR",
        error: "Không kết nối được tới Preview API.",
        action: "Kiểm tra kết nối mạng hoặc deployment Vercel rồi thử lại.",
        details: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (seq === previewRequestSeq.current) setPreviewLoading(false);
    }
  };

  // --- Phase 14: "Tạo Google Doc chỉnh sửa" cho MỘT hồ sơ ---
  // Luôn dùng Google Docs engine (editable output). Job giờ chạy bất đồng bộ
  // trên Cloud Run worker — poll tới terminal rồi mở output (không giữ request).
  const [singleDocBusy, setSingleDocBusy] = useState<string | null>(null);

  /**
   * Poll GET /api/document-merge/jobs/[id] tới khi terminal (bounded ~90s).
   * Trả về outputUrl nếu COMPLETED; ném Error nếu FAILED/CANCELLED; null nếu
   * hết thời gian chờ (job vẫn chạy — người dùng theo dõi qua Progress UI).
   */
  const waitForMergeJobOutput = async (jobId: string): Promise<string | null> => {
    const deadline = Date.now() + 90_000;
    for (;;) {
      try {
        const res = await fetch(`/api/document-merge/jobs/${jobId}`, { cache: "no-store" });
        const json = await res.json();
        if (res.ok && typeof json === "object" && json !== null) {
          const status = typeof json.status === "string" ? json.status : "";
          if (status === "COMPLETED") {
            return typeof json.outputUrl === "string" && json.outputUrl ? json.outputUrl : null;
          }
          if (status === "FAILED" || status === "CANCELLED") {
            const summary =
              typeof json.errorSummary === "string" && json.errorSummary ? json.errorSummary : `Job kết thúc với trạng thái ${status}.`;
            throw new Error(summary);
          }
        }
      } catch (error) {
        // Network hiccup during polling — tolerate until deadline.
        if (error instanceof Error && error.message.includes("Job kết thúc")) throw error;
      }
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  };

  const createEditableDoc = async (row: ApplicantRow) => {
    const effective = autoRoute
      ? templates.find((item) => item.isActive && item.documentKind === resolveDocumentKind({ declaredType: row.declaredType, dwMatch: row.dwMatch }))
      : selectedTemplate;
    if (!effective) {
      alert("Chưa có template phù hợp để tạo Google Doc.");
      return;
    }
    setSingleDocBusy(row.id);
    try {
      const res = await fetch("/api/document-merge/merge/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templateId: autoRoute ? undefined : effective.id,
          autoRoute: false,
          mergeMode: "INDIVIDUAL_DOCUMENTS",
          batchPrint: false,
          dispatchToApplicant: false,
          records: { entityType: "daily_applications", recordIds: [row.id] },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.details || "Không tạo được Google Doc.");
      if (!data.jobId) throw new Error("Không nhận được jobId từ Merge API.");
      const outputUrl = await waitForMergeJobOutput(data.jobId);
      if (!outputUrl) {
        alert("Google Doc đang được tạo bởi worker — mở bảng tiến độ/lịch sử merge để xem kết quả trong giây lát.");
        setActiveJobId(data.jobId);
        return;
      }
      window.open(outputUrl, "_blank", "noopener");
      alert("Đã tạo Google Doc chỉnh sửa cho hồ sơ này.");
    } catch (err) {
      alert(err instanceof Error ? err.message : "Không tạo được Google Doc.");
    } finally {
      setSingleDocBusy(null);
    }
  };

  /**
   * "Tạo & gửi hồ sơ xác nhận" — the individual-document Xác nhận điện tử
   * workflow (candidate later reviews + confirms at the public lookup page).
   * Separate from execute()/"Đẩy tài liệu merge" below, which is the older
   * single-signature-canvas flow and does not create immutable, hashed,
   * per-candidate documents.
   */
  const issueCandidateDocuments = async () => {
    if (selectedIds.size === 0) {
      setIssueError("Chọn danh sách ứng viên trước khi tạo & gửi hồ sơ xác nhận.");
      return;
    }
    setIssuing(true);
    setIssueError(null);
    setIssueResult(null);
    try {
      const res = await fetch("/api/document-merge/candidate-documents/issue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templateId: autoRoute ? undefined : templateId,
          applicationIds: Array.from(selectedIds),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setIssueError(data.error || "Không tạo được hồ sơ xác nhận.");
        return;
      }
      setIssueResult({ total: data.total ?? selectedIds.size });
    } catch (err) {
      setIssueError(err instanceof Error ? err.message : "Không tạo được hồ sơ xác nhận.");
    } finally {
      setIssuing(false);
    }
  };

  const execute = async (dispatchToApplicant: boolean) => {
    if (selectedIds.size === 0) {
      setMergeError("Chọn danh sách ứng viên đã xếp việc trước khi merge.");
      return;
    }
    if (!autoRoute && !templateId) {
      setMergeError("Chọn template cố định trước khi merge.");
      return;
    }
    setIsMerging(true);
    setMergeError(null);
    setDiagnostic(null);
    setActiveJobId(null);
    try {
      // Cả 2 engine giờ đều ASYNC (GOOGLE_DOCS chạy trên Cloud Run worker từ
      // sự cố 28–29/08): POST tạo durable job rồi trả jobId ngay — Progress
      // UI poll 4s. HTTP request không còn chờ Google Docs/Drive.
      if (engine === "HTML_PDF") {
        const res = await fetch("/api/document-merge/jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            templateId: autoRoute ? undefined : templateId,
            autoRoute,
            mergeMode: batchPrint ? "ONE_DOCUMENT" : "INDIVIDUAL_DOCUMENTS",
            dispatchToApplicant,
            records: {
              entityType: "daily_applications",
              recordIds: Array.from(selectedIds),
            },
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          setDiagnostic({
            code: data.code || `JOB_HTTP_${res.status}`,
            error: data.error || "Không tạo được merge job",
            action: "Kiểm tra template đang hoạt động và mapping trước khi chạy lại.",
          });
          return;
        }
        setActiveJobId(data.jobId);
        return;
      }

      const res = await fetch("/api/document-merge/merge/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templateId: autoRoute ? undefined : templateId,
          autoRoute,
          mergeMode: batchPrint ? "ONE_DOCUMENT" : "INDIVIDUAL_DOCUMENTS",
          batchPrint,
          dispatchToApplicant,
          records: {
            entityType: "daily_applications",
            recordIds: Array.from(selectedIds),
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setDiagnostic({
          code: data.code || `MERGE_HTTP_${res.status}`,
          error: data.error || data.details || "Merge thất bại",
          action: data.action || "Kiểm tra Mapping Inspector và Preview một hồ sơ trước khi chạy lại.",
          details: data.details && data.details !== data.error ? data.details : undefined,
        });
        return;
      }
      // Durable async job — Progress UI poll tới khi worker hoàn tất.
      setActiveJobId(data.jobId);
    } catch (error) {
      setDiagnostic({
        code: "MERGE_NETWORK_ERROR",
        error: "Không kết nối được tới Merge API.",
        action: "Kiểm tra mạng/deployment và thử lại.",
        details: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setIsMerging(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-slate-200/80 bg-white p-5 shadow-xs">
        <h2 className="text-base font-bold text-slate-900">Xử lý Merge tài liệu Tập nghề</h2>
        <p className="mt-1 text-xs text-slate-500">
          Mặc định chọn một <b>template cố định</b> để trộn cho toàn bộ hồ sơ đã chọn. Chỉ khi bật <b>Auto Route</b>, hệ thống mới phân loại DW Cũ → Tài liệu A và DW Mới → Tài liệu B.
        </p>
      </div>

      {activeJobId && (
        <>
          <JobProgressPanel
            jobId={activeJobId}
            onClosed={() => setActiveJobId(null)}
          />
          <button
            type="button"
            onClick={onSwitchToHistory}
            className="mt-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
          >
            Xem lịch sử merge
          </button>
        </>
      )}

      {diagnostic && <DiagnosticBox diagnostic={diagnostic} />}
      {mergeError && !diagnostic && (
        <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> {mergeError}
        </div>
      )}

      {selectedRecord && (
        <div className={`rounded-xl border p-4 text-xs ${effectiveTemplate ? "border-emerald-200 bg-emerald-50/60" : "border-amber-200 bg-amber-50"}`}>
          <p className="font-bold text-slate-900">Template thực tế sẽ được sử dụng</p>
          <p className="mt-1 text-slate-700">
            {autoRoute ? (
              <>
                {resolveDwClassification({ declaredType: selectedRecord.declaredType, dwMatch: selectedRecord.dwMatch }) === "OLD" ? "DW Cũ" : "DW Mới"}
                {" → "}Tài liệu {selectedKind ?? "—"}{" → "}
                <b>{effectiveTemplate?.name ?? `Chưa có Tài liệu ${selectedKind ?? "phù hợp"} đang hoạt động`}</b>
              </>
            ) : (
              <>
                Mẫu cố định → <b>{selectedTemplate?.name ?? "Chưa chọn template"}</b>
              </>
            )}
            {effectiveTemplate ? ` · Mapping ${effectiveTemplate.placeholderCount ?? 0} placeholder` : ""}
          </p>
        </div>
      )}

      <MappingInspector template={effectiveTemplate} />

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="space-y-4 rounded-xl border border-slate-200/80 bg-white p-4 shadow-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-bold text-slate-900">Danh sách đã xếp việc</h3>
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-bold text-emerald-800">{selectedIds.size}/{filtered.length}</span>
          </div>

          <label className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50/60 p-3 text-xs">
            <input
              type="checkbox"
              checked={autoRoute}
              disabled={engine === "HTML_PDF"}
              onChange={(e) => setAutoRoute(e.target.checked)}
              className="mt-0.5 disabled:cursor-not-allowed"
            />
            <span>
              <b>Auto Route theo phân loại DW (tùy chọn)</b>
              <span className="mt-0.5 block text-[11px] text-slate-500">
                {engine === "HTML_PDF"
                  ? "HTML/PDF yêu cầu mẫu cố định được chọn rõ ràng để snapshot đúng phiên bản và contract."
                  : "Tắt mặc định: dùng đúng template bạn chọn. Bật: DW Cũ → Tài liệu A, DW Mới → Tài liệu B."}
              </span>
            </span>
          </label>

          {!autoRoute && (
            <select
              value={templateId}
              onChange={(e) => {
                setTemplateId(e.target.value);
                onSelectTemplateId(e.target.value);
              }}
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs"
            >
              <option value="">-- Chọn template cố định --</option>
              {templates.filter((item) => item.isActive).map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
          )}

          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} placeholder="Tìm họ tên / CCCD / SĐT" className="w-full rounded-lg border border-slate-200 py-1.5 pl-8 pr-3 text-xs" />
          </div>

          <div className="flex items-center justify-between text-[11px]">
            <button type="button" onClick={toggleAll} className="font-semibold text-emerald-800">
              {selectedIds.size === filtered.length && filtered.length > 0 ? "Bỏ chọn tất cả" : "Chọn tất cả"}
            </button>
            {selectedTemplate && !autoRoute && <span className="text-slate-500">Mẫu cố định: {selectedTemplate.name}</span>}
          </div>

          <div className="max-h-[460px] overflow-y-auto rounded-lg border border-slate-100">
            {loadingRecords ? (
              <p className="p-6 text-center text-xs text-slate-400">Đang tải ứng viên đã xếp việc...</p>
            ) : filtered.length === 0 ? (
              <p className="p-6 text-center text-xs text-slate-500">Không có ứng viên đã xếp việc (có bộ phận) trong 14 ngày gần đây.</p>
            ) : (
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500">
                  <tr><th className="px-3 py-2"> </th><th className="px-3 py-2">Ứng viên</th><th className="px-3 py-2">{autoRoute ? "DW / Mẫu" : "Mẫu sử dụng"}</th><th className="px-3 py-2">Bộ phận</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filtered.map((row) => {
                    const kind = resolveDocumentKind({ declaredType: row.declaredType, dwMatch: row.dwMatch });
                    const dw = resolveDwClassification({ declaredType: row.declaredType, dwMatch: row.dwMatch });
                    const selected = selectedIds.has(row.id);
                    const rowTemplate = autoRoute
                      ? templates.find((item) => item.isActive && item.documentKind === kind)
                      : selectedTemplate;
                    return (
                      <tr
                        key={row.id}
                        onClick={() => { toggleOne(row.id); void loadPreview(row.id); }}
                        className={`cursor-pointer ${selected ? "bg-emerald-50/70" : "hover:bg-slate-50"} ${previewTargetId === row.id ? "ring-1 ring-inset ring-emerald-300" : ""}`}
                      >
                        <td className="px-3 py-2"><input type="checkbox" checked={selected} readOnly className="accent-emerald-700" /></td>
                        <td className="px-3 py-2">
                          <div className="font-semibold text-slate-900">{row.fullName}</div>
                          <div className="font-mono text-[10px] text-slate-500">{row.cccd}</div>
                          {row.signatureConfirmedAt && <div className="text-[10px] font-bold text-emerald-700">Đã ký</div>}
                          {row.documentSentAt && !row.signatureConfirmedAt && <div className="text-[10px] text-amber-700">Đã gửi, chờ ký</div>}
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); void createEditableDoc(row); }}
                            disabled={singleDocBusy !== null}
                            title="Tạo Google Doc chỉnh sửa cho hồ sơ này (engine Google Docs — không dùng cho batch)"
                            className="mt-1 inline-flex items-center gap-1 rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
                          >
                            {singleDocBusy === row.id ? <RefreshCw className="h-2.5 w-2.5 animate-spin" /> : <ExternalLink className="h-2.5 w-2.5" />}
                            Google Doc
                          </button>
                        </td>
                        <td className="px-3 py-2">
                          {autoRoute ? (
                            <>
                              <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold ${dw === "OLD" ? "bg-sky-100 text-sky-800" : "bg-amber-100 text-amber-800"}`}>{dw === "OLD" ? "DW Cũ" : "DW Mới"}</span>
                              <div className="mt-1 text-[10px] font-semibold text-slate-600">Tài liệu {kind}</div>
                              <div className={`mt-0.5 max-w-[150px] truncate text-[9px] ${rowTemplate ? "text-emerald-700" : "text-red-600"}`} title={rowTemplate?.name}>
                                {rowTemplate?.name ?? "Chưa cấu hình mẫu"}
                              </div>
                            </>
                          ) : (
                            <div className={`max-w-[180px] truncate text-[10px] font-semibold ${selectedTemplate ? "text-emerald-700" : "text-amber-700"}`} title={selectedTemplate?.name}>
                              {selectedTemplate?.name ?? "Chưa chọn template"}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-slate-600">
                          {row.deptName || "—"}
                          {row.startingDate && <div className="text-[10px] text-slate-400">{row.startingDate}</div>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <section className="flex min-h-[520px] flex-col rounded-xl border border-slate-200/80 bg-white p-4 shadow-xs">
          <div className="flex items-center justify-between gap-2 border-b border-slate-100 pb-3">
            <h3 className="text-sm font-bold text-slate-900">Preview tài liệu</h3>
            <button type="button" onClick={() => void loadPreview()} disabled={previewLoading || !templateReady} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50">
              <Eye className="h-3.5 w-3.5" /> {previewLoading ? "Đang tải..." : "Preview"}
            </button>
          </div>

          <div className="mt-3 flex-1 overflow-y-auto rounded-lg bg-slate-50 p-4 text-xs leading-relaxed text-slate-800">
            {!preview && !previewLoading && <p className="text-center text-slate-400">Chọn một ứng viên rồi nhấn Preview để xem nội dung merge với dữ liệu thật.</p>}
            {previewLoading && <p className="text-center text-slate-400">Đang merge thử...</p>}
            <PreviewErrorBoundary
              resetKey={`${previewTargetId}:${preview?.applicationId ?? ""}`}
              onReset={() => void loadPreview()}
            >
            {preview && (
              <div className="space-y-3">
                <div className="rounded-lg bg-white p-3 shadow-xs">
                  <p className="font-bold text-slate-900">{preview.fullName}</p>
                  <p className="font-mono text-[11px] text-slate-500">{preview.cccd}</p>
                  {autoRoute && <p className="mt-1 text-[11px] text-emerald-800">{preview.dwClassification === "OLD" ? "DW Cũ" : "DW Mới"} → {preview.documentKindLabel}</p>}
                  <p className="text-[11px] text-slate-500">{autoRoute ? "Mẫu được route" : "Mẫu cố định"}: {preview.templateName}</p>
                  {preview.mappingSummary && <p className="mt-1 text-[10px] text-slate-400">Mapping: {preview.mappingSummary.mapped}/{preview.mappingSummary.total} · Required: {preview.mappingSummary.required}</p>}

                  {/* Template / Version / Status / Engine — bắt buộc hiển thị để
                      operator biết CHÍNH XÁC đang xem tài liệu nào. */}
                  <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 border-t border-slate-100 pt-2 text-[10px]">
                    <dt className="text-slate-400">Template</dt>
                    <dd className="truncate font-medium text-slate-700">{preview.templateName}</dd>
                    <dt className="text-slate-400">Version</dt>
                    <dd className="font-medium text-slate-700">
                      {preview.templateVersion != null ? `v${preview.templateVersion}` : "—"}
                    </dd>
                    <dt className="text-slate-400">Status</dt>
                    <dd>
                      <span
                        className={
                          preview.isPublishedCanonical
                            ? "rounded bg-emerald-100 px-1.5 py-0.5 font-semibold text-emerald-800"
                            : "rounded bg-amber-100 px-1.5 py-0.5 font-semibold text-amber-800"
                        }
                      >
                        {preview.versionStatus ?? "GOOGLE_DOCS"}
                      </span>
                    </dd>
                    <dt className="text-slate-400">Engine</dt>
                    <dd className="font-medium text-slate-700">{preview.engine ?? "GOOGLE_DOCS"}</dd>
                    {preview.pageCount != null && (
                      <>
                        <dt className="text-slate-400">Số trang</dt>
                        <dd className="font-medium text-slate-700">{preview.pageCount}</dd>
                      </>
                    )}
                  </dl>
                  {preview.versionStatus && !preview.isPublishedCanonical && (
                    <p className="mt-2 rounded bg-amber-50 p-1.5 text-[10px] text-amber-800">
                      Đây là bản nháp để kiểm tra. Job production chỉ dùng phiên bản đã XUẤT BẢN.
                    </p>
                  )}
                </div>
                {preview.renderedHtml ? (
                  <iframe
                    title="Canonical document preview"
                    className="h-[520px] w-full rounded-lg border border-slate-200 bg-white"
                    sandbox=""
                    srcDoc={preview.renderedHtml}
                  />
                ) : (
                  <pre className="whitespace-pre-wrap font-sans text-[12px] text-slate-800">{preview.content}</pre>
                )}
                {(preview.missingFields.length > 0 || preview.unreplaced.length > 0) && (
                  <p className="rounded-lg bg-amber-50 p-2 text-[11px] text-amber-800">Trường thiếu / chưa thay: {[...preview.missingFields, ...preview.unreplaced].join(", ")}</p>
                )}
              </div>
            )}
            </PreviewErrorBoundary>
          </div>

          <div className="mt-4 space-y-3 border-t border-slate-100 pt-4">
            <label className="flex items-start gap-2 rounded-lg border border-slate-200 p-3 text-xs">
              <input type="checkbox" checked={batchPrint} onChange={(e) => setBatchPrint(e.target.checked)} className="mt-0.5" />
              <span><b>Merge toàn bộ danh sách để xuất file in (Có Page Break)</b><span className="mt-0.5 block text-[11px] text-slate-500">Gộp toàn bộ danh sách vào 1 file Google Docs, tự chèn dấu ngắt trang giữa từng người.</span></span>
            </label>

            <div className="grid gap-2 sm:grid-cols-2">
              <button type="button" onClick={() => void loadPreview()} disabled={previewLoading || selectedIds.size === 0 || !templateReady} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white py-2.5 text-xs font-semibold text-slate-700 disabled:opacity-50">
                <FileCheck className="h-3.5 w-3.5" /> Preview
              </button>
              <button type="button" onClick={() => void execute(true)} disabled={isMerging || selectedIds.size === 0 || !templateReady} className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-emerald-700 py-2.5 text-xs font-bold text-white shadow-sm hover:bg-emerald-800 disabled:opacity-50">
                <Send className="h-3.5 w-3.5" /> {isMerging ? "Đang đẩy..." : "Đẩy tài liệu merge đến Người tìm việc"}
              </button>
            </div>
            <button type="button" onClick={() => void execute(false)} disabled={isMerging || selectedIds.size === 0 || !templateReady} className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 py-2 text-xs font-semibold text-emerald-800 disabled:opacity-50">
              <Sparkles className="h-3.5 w-3.5" /> Chỉ xuất file (không gửi ứng viên)
            </button>

            <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-3">
              <p className="text-[11px] font-bold text-indigo-900">Hồ sơ xác nhận điện tử (mới)</p>
              <p className="mt-0.5 text-[10px] text-indigo-700">
                Tạo MỘT PDF riêng, bất biến, có mã băm SHA-256 cho MỖI ứng viên đã chọn. Ứng viên tự xem + tích
                &quot;Xác nhận đồng ý&quot; tại trang tra cứu công khai — khác với &quot;Đẩy tài liệu merge&quot; ở trên (chữ ký vẽ tay,
                dùng chung 1 trường).
              </p>
              <button
                type="button"
                onClick={() => void issueCandidateDocuments()}
                disabled={issuing || selectedIds.size === 0 || !templateReady}
                className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-indigo-700 py-2.5 text-xs font-bold text-white shadow-sm hover:bg-indigo-800 disabled:opacity-50"
              >
                <ShieldCheck className="h-3.5 w-3.5" />
                {issuing ? "Đang tạo & gửi..." : `Tạo & gửi hồ sơ xác nhận (${selectedIds.size})`}
              </button>
              {issueError && <p className="mt-2 rounded-lg bg-red-50 p-2 text-[11px] text-red-700">{issueError}</p>}
              {issueResult && (
                <p className="mt-2 rounded-lg bg-emerald-50 p-2 text-[11px] text-emerald-800">
                  Đã xếp hàng tạo {issueResult.total} hồ sơ xác nhận. Xem trạng thái tại danh sách &quot;Hồ sơ xác nhận điện tử&quot;.
                </p>
              )}
            </div>
          </div>
        </section>
      </div>
      <CandidateDocumentsStatusPanel />
    </div>
  );
}
