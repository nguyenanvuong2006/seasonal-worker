"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
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
  Sparkles,
} from "lucide-react";
import {
  documentKindLabel,
  resolveDocumentKind,
  resolveDwClassification,
} from "@/lib/document-merge/template-routing";

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

type PreviewResult = {
  applicationId: string;
  fullName: string;
  cccd: string;
  deptName?: string | null;
  startingDate?: string | null;
  dwClassification: "OLD" | "NEW";
  documentKind: "A" | "B";
  documentKindLabel: string;
  templateId?: string;
  templateName: string;
  content: string;
  missingFields: string[];
  unreplaced: string[];
  valid: boolean;
  mappingSummary?: { total: number; mapped: number; required: number; suggested: number };
};

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
  "SYSTEM_FIELD",
  "STATIC_TEXT",
  "CHECKBOX_OPTION",
];

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
                            className="w-full rounded border border-slate-200 px-2 py-1.5 font-mono"
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <input
                            value={field.sourcePath ?? ""}
                            onChange={(event) => updateField(field.id, { sourcePath: event.target.value || null })}
                            placeholder="vd: customAnswers.email"
                            className="w-full rounded border border-slate-200 px-2 py-1.5 font-mono"
                          />
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
  const [mergeSuccess, setMergeSuccess] = useState<{
    jobId: string;
    outputUrl?: string | null;
    printUrl?: string | null;
    dispatchedCount: number;
  } | null>(null);

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
  const templateReady = autoRoute || Boolean(selectedTemplate);

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
      const data = await res.json();
      if (!res.ok) {
        setDiagnostic({
          code: data.code || `HTTP_${res.status}`,
          error: data.error || "Không xem trước được",
          action: data.action,
          details: data.details,
        });
        setPreview(null);
        return;
      }
      setPreview(data);
    } catch (error) {
      setPreview(null);
      setDiagnostic({
        code: "NETWORK_ERROR",
        error: "Không kết nối được tới Preview API.",
        action: "Kiểm tra kết nối mạng hoặc deployment Vercel rồi thử lại.",
        details: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPreviewLoading(false);
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
    setMergeSuccess(null);
    try {
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
      setMergeSuccess({
        jobId: data.jobId,
        outputUrl: data.outputUrl,
        printUrl: data.printUrl,
        dispatchedCount: data.dispatchedCount ?? 0,
      });
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

      {mergeSuccess && (
        <div className="rounded-2xl border border-emerald-300 bg-emerald-50/80 p-5">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="mt-0.5 h-6 w-6 text-emerald-700" />
            <div className="flex-1">
              <p className="font-bold text-emerald-950">Hoàn tất merge</p>
              <p className="mt-1 text-xs text-emerald-800">
                Job {mergeSuccess.jobId}
                {mergeSuccess.dispatchedCount > 0
                  ? ` — đã đẩy ${mergeSuccess.dispatchedCount} tài liệu đến hồ sơ tra cứu.`
                  : ""}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {mergeSuccess.printUrl && (
                  <a href={mergeSuccess.printUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-bold text-white">
                    <ExternalLink className="h-3.5 w-3.5" /> Mở file in (page break)
                  </a>
                )}
                {mergeSuccess.outputUrl && !mergeSuccess.printUrl && (
                  <a href={mergeSuccess.outputUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-bold text-white">
                    <ExternalLink className="h-3.5 w-3.5" /> Mở Google Docs
                  </a>
                )}
                <button type="button" onClick={onSwitchToHistory} className="rounded-lg border border-emerald-300 bg-white px-3 py-1.5 text-xs font-semibold text-emerald-800">
                  Xem lịch sử
                </button>
              </div>
            </div>
          </div>
        </div>
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
            <input type="checkbox" checked={autoRoute} onChange={(e) => setAutoRoute(e.target.checked)} className="mt-0.5" />
            <span>
              <b>Auto Route theo phân loại DW (tùy chọn)</b>
              <span className="mt-0.5 block text-[11px] text-slate-500">Tắt mặc định: dùng đúng template bạn chọn. Bật: DW Cũ → Tài liệu A, DW Mới → Tài liệu B.</span>
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
            {preview && (
              <div className="space-y-3">
                <div className="rounded-lg bg-white p-3 shadow-xs">
                  <p className="font-bold text-slate-900">{preview.fullName}</p>
                  <p className="font-mono text-[11px] text-slate-500">{preview.cccd}</p>
                  {autoRoute && <p className="mt-1 text-[11px] text-emerald-800">{preview.dwClassification === "OLD" ? "DW Cũ" : "DW Mới"} → {preview.documentKindLabel}</p>}
                  <p className="text-[11px] text-slate-500">{autoRoute ? "Mẫu được route" : "Mẫu cố định"}: {preview.templateName}</p>
                  {preview.mappingSummary && <p className="mt-1 text-[10px] text-slate-400">Mapping: {preview.mappingSummary.mapped}/{preview.mappingSummary.total} · Required: {preview.mappingSummary.required}</p>}
                </div>
                <pre className="whitespace-pre-wrap font-sans text-[12px] text-slate-800">{preview.content}</pre>
                {(preview.missingFields.length > 0 || preview.unreplaced.length > 0) && (
                  <p className="rounded-lg bg-amber-50 p-2 text-[11px] text-amber-800">Trường thiếu / chưa thay: {[...preview.missingFields, ...preview.unreplaced].join(", ")}</p>
                )}
              </div>
            )}
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
          </div>
        </section>
      </div>
    </div>
  );
}
