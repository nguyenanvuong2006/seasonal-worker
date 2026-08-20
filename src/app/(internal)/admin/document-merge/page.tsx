"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  ExternalLink,
  FileText,
  History as HistoryIcon,
  Key,
  Layers,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { MergeWorkspace } from "@/components/document-merge/merge-workspace";
import { TemplateLibrary } from "@/components/document-merge/template-library";
import { VerificationPanel } from "@/components/document-merge/verification-panel";

type TabType = "templates" | "merge" | "history" | "fields" | "verification";

const TABS: { id: TabType; label: string; icon: typeof FileText }[] = [
  { id: "templates", label: "Quản lý Templates", icon: FileText },
  { id: "merge", label: "Thực hiện Merge", icon: Layers },
  { id: "history", label: "Lịch sử Merge", icon: HistoryIcon },
  { id: "fields", label: "Danh mục Placeholders", icon: Key },
  { id: "verification", label: "Verification", icon: ShieldCheck },
];

function DocumentMergeContent() {
  const searchParams = useSearchParams();
  const templateParam = searchParams.get("template") || "";
  const requestedTab = searchParams.get("tab") as TabType | null;
  const [activeTab, setActiveTab] = useState<TabType>(templateParam ? "merge" : requestedTab || "templates");
  const [selectedTemplateId, setSelectedTemplateId] = useState(templateParam);

  useEffect(() => {
    if (templateParam) {
      setSelectedTemplateId(templateParam);
      setActiveTab("merge");
    }
  }, [templateParam]);

  const selectForMerge = (templateId: string) => {
    setSelectedTemplateId(templateId);
    setActiveTab("merge");
  };

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-emerald-950/10 bg-white shadow-xs">
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-emerald-700 text-white shadow-sm">
                <FileText className="h-5 w-5" />
              </div>
              <div>
                <h1 className="text-xl font-bold text-slate-900 sm:text-2xl">Document Merge Center</h1>
                <p className="text-xs text-slate-500 sm:text-sm">Google Docs Merge Engine — quản lý mẫu, mapping, preview, merge và ký nhận hồ sơ Tập nghề.</p>
              </div>
            </div>
            <div className="flex gap-2">
              <button onClick={() => setActiveTab("templates")} className="rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">Templates</button>
              <button onClick={() => setActiveTab("merge")} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-3.5 py-2 text-xs font-semibold text-white hover:bg-emerald-800"><Layers className="h-3.5 w-3.5" /> Tạo tài liệu mới</button>
            </div>
          </div>

          <nav className="mt-6 flex overflow-x-auto border-b border-slate-200">
            {TABS.map((tab) => {
              const Icon = tab.icon;
              const active = activeTab === tab.id;
              return (
                <button key={tab.id} onClick={() => setActiveTab(tab.id)} className={`flex shrink-0 items-center gap-2 border-b-2 px-4 py-3 text-xs font-semibold transition sm:text-sm ${active ? "border-emerald-700 text-emerald-800" : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700"}`}>
                  <Icon className="h-4 w-4" /> {tab.label}
                </button>
              );
            })}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        {activeTab === "templates" && <TemplateLibrary onSelectForMerge={selectForMerge} />}
        {activeTab === "merge" && <MergeWorkspace selectedTemplateId={selectedTemplateId} onSelectTemplateId={setSelectedTemplateId} onSwitchToHistory={() => setActiveTab("history")} />}
        {activeTab === "history" && <HistoryTab />}
        {activeTab === "fields" && <FieldsTab />}
        {activeTab === "verification" && <VerificationPanel />}
      </main>
    </div>
  );
}

export default function DocumentMergeCenterPage() {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-500">Đang tải Document Merge Center...</div>}>
      <DocumentMergeContent />
    </Suspense>
  );
}

function HistoryTab() {
  const [loading, setLoading] = useState(true);
  const [history, setHistory] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/document-merge/history", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Không tải được lịch sử merge.");
      setHistory(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không tải được lịch sử merge.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const remove = async (jobId: string) => {
    if (!confirm("Bạn có chắc muốn xoá lịch sử merge này?")) return;
    const res = await fetch(`/api/document-merge/history/${jobId}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.error || "Không xoá được lịch sử merge.");
      return;
    }
    load();
  };

  if (loading) return <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">Đang tải lịch sử merge...</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div><h2 className="text-base font-bold text-slate-900">Lịch sử Merge Documents</h2><p className="text-xs text-slate-500">Theo dõi tài liệu đã tạo và mở lại Google Docs.</p></div>
        <button onClick={load} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700"><RefreshCw className="h-3.5 w-3.5" /> Làm mới</button>
      </div>
      {error && <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-xs text-red-700">{error}</div>}
      {history.length === 0 ? <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">Chưa có lịch sử merge.</div> : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xs">
          <ul className="divide-y divide-slate-100">
            {history.map((job) => (
              <li key={job.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-2"><span className="text-sm font-bold text-slate-900">{job.templateNameSnapshot || "Template không tên"}</span><span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${job.status === "COMPLETED" ? "bg-emerald-50 text-emerald-700" : job.status === "FAILED" ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-700"}`}>{job.status}</span></div>
                  <p className="mt-1 text-xs text-slate-500">{job.recordCount} hồ sơ · {job.createdBy} · {new Date(job.createdAt).toLocaleString("vi-VN")}</p>
                </div>
                <div className="flex items-center gap-2">
                  {job.outputUrl && <a href={job.outputUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-lg bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700"><ExternalLink className="h-3.5 w-3.5" /> Mở Google Docs</a>}
                  <button onClick={() => remove(job.id)} className="rounded-lg p-2 text-slate-400 hover:bg-red-50 hover:text-red-600"><Trash2 className="h-4 w-4" /></button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function FieldsTab() {
  const [loading, setLoading] = useState(true);
  const [catalog, setCatalog] = useState<any>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    fetch("/api/document-merge/field-catalog", { cache: "no-store" })
      .then((res) => res.json())
      .then((data) => setCatalog(data))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">Đang tải danh mục placeholder...</div>;
  if (!catalog) return <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-sm text-red-700">Không tải được danh mục field.</div>;

  const groups = Object.entries(catalog.groupedCatalog || {}) as [string, any[]][];
  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div><h2 className="text-base font-bold text-slate-900">Danh mục Field & Placeholder</h2><p className="text-xs text-slate-500">Tra cứu nguồn dữ liệu hệ thống hỗ trợ cho Document Merge.</p></div>
        <div className="relative sm:w-80"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Tìm placeholder / field..." className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-9 pr-3 text-xs outline-none focus:border-emerald-600" /></div>
      </div>
      <div className="space-y-4">
        {groups.map(([category, fields]) => {
          const filtered = fields.filter((field) => {
            const q = query.toLowerCase().trim();
            if (!q) return true;
            return String(field.label || "").toLowerCase().includes(q) || String(field.suggestedPlaceholder || "").toLowerCase().includes(q) || String(field.databaseSource || "").toLowerCase().includes(q);
          });
          if (!filtered.length) return null;
          return <section key={category} className="overflow-hidden rounded-xl border border-slate-200 bg-white"><div className="bg-slate-50 px-4 py-3 text-xs font-bold text-slate-800">{category} ({filtered.length})</div><div className="divide-y divide-slate-100">{filtered.map((field) => <div key={field.fieldKey} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"><div><div className="text-xs font-semibold text-slate-900">{field.label}</div><div className="font-mono text-[11px] text-slate-400">{field.databaseSource}</div></div><span className="w-fit rounded bg-emerald-50 px-2 py-1 font-mono text-[11px] text-emerald-800">{`<<${field.suggestedPlaceholder}>>`}</span></div>)}</div></section>;
        })}
      </div>
    </div>
  );
}
