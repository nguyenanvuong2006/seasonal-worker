"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ExternalLink,
  FileText,
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

  const openEdit = async (template: Template) => {
    setCreating(false);
    setEditing(template);
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
  };

  const closeEditor = () => {
    setCreating(false);
    setEditing(null);
    setMappings([]);
    setForm(EMPTY_FORM);
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
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
