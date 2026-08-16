'use client';

/**
 * Document Merge Center — Main Page
 * 
 * Trung tâm quản lý mẫu biểu và thực hiện merge tài liệu tự động từ cơ sở dữ liệu.
 */

import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { MergeWorkspace } from '@/components/document-merge/merge-workspace';
import { extractGoogleDocId, documentKindLabel } from '@/lib/document-merge/template-routing';
import {
  FileText,
  Layers,
  History as HistoryIcon,
  Key,
  CheckCircle2,
  AlertCircle,
  Clock,
  ExternalLink,
  Search,
  CheckSquare,
  Square,
  Play,
  RotateCcw,
  Plus,
  RefreshCw,
  Trash2,
  Eye,
  FileCheck,
  Users,
  Sliders,
  ChevronRight,
  Sparkles,
  Info,
} from 'lucide-react';

type TabType = 'templates' | 'merge' | 'history' | 'fields';

interface MergeTemplate {
  id: string;
  name: string;
  description: string | null;
  googleDocId: string;
  outputFolderId: string | null;
  outputFileNamePattern: string | null;
  defaultMergeMode: 'ONE_DOCUMENT' | 'INDIVIDUAL_DOCUMENTS';
  documentKind?: 'A' | 'B' | 'GENERIC';
  dataSources: string[];
  isActive: boolean;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
  placeholderCount?: number;
  fieldMappingsCount?: number;
}

interface WorkerRecord {
  id: string;
  fullName: string;
  cccd: string;
  phone?: string | null;
  gender?: string | null;
  dob?: string | null;
  code?: string | null;
  department?: string | null;
  status?: string | null;
}

interface PreflightResult {
  preflight: boolean;
  valid: boolean;
  totalRecords: number;
  totalPlaceholders: number;
  mappedPlaceholders: number;
  validationResults: { recordId: string; missingFields: string[] }[];
}

const TABS: { id: TabType; label: string; icon: typeof FileText; desc: string }[] = [
  { id: 'templates', label: 'Quản lý Templates', icon: FileText, desc: 'Danh sách mẫu Google Docs & ánh xạ trường' },
  { id: 'merge', label: 'Thực hiện Merge', icon: Layers, desc: 'Chọn mẫu và hồ sơ lao động để tạo tài liệu' },
  { id: 'history', label: 'Lịch sử Merge', icon: HistoryIcon, desc: 'Theo dõi và tải lại tài liệu đã tạo' },
  { id: 'fields', label: 'Danh mục Placeholders', icon: Key, desc: 'Tra cứu các trường dữ liệu hệ thống hỗ trợ' },
];

function DocumentMergeContent() {
  const searchParams = useSearchParams();

  const initialTab = (searchParams.get('tab') as TabType) || (searchParams.get('template') ? 'merge' : 'templates');
  const initialTemplateId = searchParams.get('template') || '';

  const [activeTab, setActiveTab] = useState<TabType>(initialTab);
  const [selectedTemplateIdForMerge, setSelectedTemplateIdForMerge] = useState<string>(initialTemplateId);

  useEffect(() => {
    const templateParam = searchParams.get('template');
    if (templateParam) {
      setSelectedTemplateIdForMerge(templateParam);
      setActiveTab('merge');
    }
  }, [searchParams]);

  const handleSelectTemplateForMerge = (templateId: string) => {
    setSelectedTemplateIdForMerge(templateId);
    setActiveTab('merge');
  };

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Top Banner Header */}
      <div className="border-b border-emerald-950/10 bg-white shadow-xs">
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="flex items-center gap-2.5">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-700 text-white shadow-sm">
                  <FileText className="h-5 w-5" />
                </div>
                <div>
                  <h1 className="text-xl font-bold text-slate-900 sm:text-2xl">
                    Document Merge Center
                  </h1>
                  <p className="text-xs text-slate-500 sm:text-sm">
                    Generic Document Merge Engine — Tự động điền dữ liệu vào mẫu Google Docs
                  </p>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => setActiveTab('templates')}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-medium text-slate-700 shadow-xs transition hover:bg-slate-50 hover:text-slate-900"
              >
                <FileText className="h-3.5 w-3.5 text-slate-500" />
                Templates
              </button>
              <button
                onClick={() => setActiveTab('merge')}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-3.5 py-2 text-xs font-medium text-white shadow-sm transition hover:bg-emerald-800"
              >
                <Layers className="h-3.5 w-3.5" />
                Tạo tài liệu mới
              </button>
            </div>
          </div>

          {/* Navigation Tabs */}
          <div className="mt-6 flex overflow-x-auto border-b border-slate-200">
            {TABS.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-2 border-b-2 px-4 py-3 text-xs font-semibold whitespace-nowrap transition-colors sm:text-sm ${
                    isActive
                      ? 'border-emerald-700 text-emerald-800'
                      : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700'
                  }`}
                >
                  <Icon className={`h-4 w-4 ${isActive ? 'text-emerald-700' : 'text-slate-400'}`} />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Main Content Area */}
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
        {activeTab === 'templates' && (
          <TemplatesTab onSelectForMerge={handleSelectTemplateForMerge} />
        )}
        {activeTab === 'merge' && (
          <MergeWorkspace
            selectedTemplateId={selectedTemplateIdForMerge}
            onSelectTemplateId={setSelectedTemplateIdForMerge}
            onSwitchToHistory={() => setActiveTab('history')}
          />
        )}
        {activeTab === 'history' && <HistoryTab />}
        {activeTab === 'fields' && <FieldsTab />}
      </main>
    </div>
  );
}

export default function DocumentMergeCenterPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-slate-50">
          <div className="h-8 w-8 animate-spin rounded-full border-3 border-emerald-700 border-t-transparent" />
        </div>
      }
    >
      <DocumentMergeContent />
    </Suspense>
  );
}

// =============================================================================
// TAB 1: TEMPLATES
// =============================================================================
function TemplatesTab({ onSelectForMerge }: { onSelectForMerge: (templateId: string) => void }) {
  const [loading, setLoading] = useState(true);
  const [templates, setTemplates] = useState<MergeTemplate[]>([]);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [formData, setFormData] = useState({
    name: '',
    description: '',
    googleDocId: '',
    outputFolderId: '',
    outputFileNamePattern: '',
    defaultMergeMode: 'ONE_DOCUMENT' as 'ONE_DOCUMENT' | 'INDIVIDUAL_DOCUMENTS',
    documentKind: 'GENERIC' as 'A' | 'B' | 'GENERIC',
  });

  const loadTemplates = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/document-merge/templates');
      if (!res.ok) throw new Error('Không thể tải danh sách templates');
      const data = await res.json();
      setTemplates(Array.isArray(data) ? data : []);
    } catch (err: any) {
      setError(err.message || 'Lỗi khi tải templates');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTemplates();
  }, []);

  const handleCreateTemplate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.name || !formData.googleDocId) {
      alert('Vui lòng nhập tên template và Google Doc ID');
      return;
    }

    setCreating(true);
    try {
      const res = await fetch('/api/document-merge/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Tạo template thất bại');
      }

      setShowCreateModal(false);
      setFormData({
        name: '',
        description: '',
        googleDocId: '',
        outputFolderId: '',
        outputFileNamePattern: '',
        defaultMergeMode: 'ONE_DOCUMENT',
        documentKind: 'GENERIC',
      });
      loadTemplates();
    } catch (err: any) {
      alert(err.message || 'Lỗi khi tạo template');
    } finally {
      setCreating(false);
    }
  };

  const handleToggleActive = async (templateId: string) => {
    try {
      const res = await fetch(`/api/document-merge/templates/${templateId}/activate`, {
        method: 'POST',
      });
      if (res.ok) {
        loadTemplates();
      }
    } catch (err) {
      console.error('Failed to toggle active', err);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-3 border-emerald-700 border-t-transparent" />
          <p className="text-xs font-medium text-slate-500">Đang tải danh sách templates...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-base font-bold text-slate-900">Danh sách Mẫu tài liệu</h2>
          <p className="text-xs text-slate-500">
            Quản lý các mẫu Google Docs dùng để trộn hợp đồng, cam kết, quyết định tuyển dụng.
          </p>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-3.5 py-2 text-xs font-semibold text-white shadow-xs transition hover:bg-emerald-800"
        >
          <Plus className="h-4 w-4" />
          Tạo Template mới
        </button>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-xs text-red-700">
          {error}
        </div>
      )}

      {templates.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-12 text-center shadow-xs">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-700">
            <FileText className="h-6 w-6" />
          </div>
          <h3 className="mt-4 text-sm font-bold text-slate-900">Chưa có Template nào</h3>
          <p className="mx-auto mt-1 max-w-sm text-xs text-slate-500">
            Hãy bắt đầu bằng cách kết nối với một Google Doc mẫu có chứa các placeholder như &lt;&lt;Ho_ten&gt;&gt;.
          </p>
          <button
            onClick={() => setShowCreateModal(true)}
            className="mt-5 inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-emerald-800"
          >
            <Plus className="h-4 w-4" />
            Tạo Template đầu tiên
          </button>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((template) => (
            <div
              key={template.id}
              className="flex flex-col justify-between rounded-xl border border-slate-200/80 bg-white p-5 shadow-xs transition hover:border-emerald-300 hover:shadow-md"
            >
              <div>
                <div className="flex items-start justify-between gap-2">
                  <h3 className="font-bold text-slate-900 line-clamp-1">{template.name}</h3>
                  <button
                    onClick={() => handleToggleActive(template.id)}
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wider uppercase transition ${
                      template.isActive
                        ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}
                  >
                    {template.isActive ? 'Hoạt động' : 'Tắt'}
                  </button>
                </div>

                {template.description && (
                  <p className="mt-1 text-xs text-slate-500 line-clamp-2">{template.description}</p>
                )}

                <div className="mt-4 space-y-1.5 rounded-lg bg-slate-50 p-2.5 text-[11px] text-slate-600">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-400">Doc ID:</span>
                    <span className="font-mono text-slate-700 truncate max-w-[140px]" title={template.googleDocId}>
                      {template.googleDocId}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-slate-400">Placeholders:</span>
                    <span className="font-semibold text-emerald-700">{template.placeholderCount || 0} trường</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-slate-400">Chế độ mặc định:</span>
                    <span>{template.defaultMergeMode === 'ONE_DOCUMENT' ? '1 File gộp' : 'Từng file riêng'}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-slate-400">Phân loại:</span>
                    <span className="font-semibold text-emerald-800">{documentKindLabel(template.documentKind)}</span>
                  </div>
                </div>
              </div>

              <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3">
                <a
                  href={`https://docs.google.com/document/d/${template.googleDocId}/edit`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-emerald-700"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Mẫu gốc
                </a>

                <div className="flex items-center gap-2">
                  <button
                    onClick={async () => {
                      try {
                        const res = await fetch(`/api/document-merge/templates/${template.id}/scan`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ googleDocId: template.googleDocId }),
                        });
                        const data = await res.json();
                        if (!res.ok) throw new Error(data.error || 'Scan thất bại');
                        alert(`Đã quét ${data.placeholders?.length ?? 0} placeholder.`);
                        loadTemplates();
                      } catch (err: any) {
                        alert(err.message || 'Không quét được placeholder');
                      }
                    }}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                  >
                    Scan
                  </button>
                  <button
                    onClick={() => onSelectForMerge(template.id)}
                    className="inline-flex items-center gap-1 rounded-lg bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 transition hover:bg-emerald-700 hover:text-white"
                  >
                    <Layers className="h-3.5 w-3.5" />
                    Merge →
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Modal Tạo Template Mới */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-xs">
          <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="text-base font-bold text-slate-900">Tạo Mẫu Document Merge mới</h3>
              <button
                onClick={() => setShowCreateModal(false)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleCreateTemplate} className="mt-4 space-y-4 text-xs">
              <div>
                <label className="block font-semibold text-slate-700">Tên Template *</label>
                <input
                  type="text"
                  required
                  placeholder="VD: Hợp đồng thử việc Tập nghề 2026"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-800 outline-none focus:border-emerald-600"
                />
              </div>

              <div>
                <label className="block font-semibold text-slate-700">Mô tả</label>
                <input
                  type="text"
                  placeholder="Ghi chú mục đích sử dụng của mẫu này..."
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-800 outline-none focus:border-emerald-600"
                />
              </div>

              <div>
                <label className="block font-semibold text-slate-700">Google Docs URL / ID *</label>
                <input
                  type="text"
                  required
                  placeholder="Dán URL Google Docs hoặc Doc ID"
                  value={formData.googleDocId}
                  onChange={(e) => {
                    const extracted = extractGoogleDocId(e.target.value);
                    setFormData({ ...formData, googleDocId: extracted || e.target.value });
                  }}
                  className="mt-1 w-full font-mono rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-800 outline-none focus:border-emerald-600"
                />
                <p className="mt-1 text-[11px] text-slate-400">
                  Dán nguyên URL — hệ thống tự tách Doc ID. Ví dụ: https://docs.google.com/document/d/<b>[DOC_ID]</b>/edit
                </p>
              </div>

              <div>
                <label className="block font-semibold text-slate-700">Phân loại mẫu (Routing A / B)</label>
                <select
                  value={formData.documentKind}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      documentKind: e.target.value as 'A' | 'B' | 'GENERIC',
                    })
                  }
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-800 outline-none focus:border-emerald-600 bg-white"
                >
                  <option value="GENERIC">Mẫu chung (fallback)</option>
                  <option value="A">Tài liệu A — Cam kết / Tái ký (DW Cũ)</option>
                  <option value="B">Tài liệu B — Hợp đồng đào tạo nghề (DW Mới)</option>
                </select>
              </div>

              <div>
                <label className="block font-semibold text-slate-700">Chế độ xuất mặc định</label>
                <select
                  value={formData.defaultMergeMode}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      defaultMergeMode: e.target.value as 'ONE_DOCUMENT' | 'INDIVIDUAL_DOCUMENTS',
                    })
                  }
                  className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-800 outline-none focus:border-emerald-600 bg-white"
                >
                  <option value="ONE_DOCUMENT">Gộp chung 1 file duy nhất (Page breaks)</option>
                  <option value="INDIVIDUAL_DOCUMENTS">Tạo từng file tài liệu riêng lẻ</option>
                </select>
              </div>

              <div className="flex justify-end gap-2 border-t border-slate-100 pt-4">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50"
                >
                  Huỷ
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-4 py-2 text-xs font-semibold text-white shadow-xs hover:bg-emerald-800 disabled:opacity-50"
                >
                  {creating ? 'Đang tạo...' : 'Lưu Template'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// TAB 2: MERGE DOCUMENTS FORM
// =============================================================================
function MergeTab({
  selectedTemplateId,
  onSelectTemplateId,
  onSwitchToHistory,
}: {
  selectedTemplateId: string;
  onSelectTemplateId: (id: string) => void;
  onSwitchToHistory: () => void;
}) {
  const [templates, setTemplates] = useState<MergeTemplate[]>([]);
  const [loadingTemplates, setLoadingTemplates] = useState(true);

  // Form State
  const [templateId, setTemplateId] = useState<string>(selectedTemplateId);
  const [entityType, setEntityType] = useState<'worker_profiles' | 'daily_applications'>('worker_profiles');
  const [mergeMode, setMergeMode] = useState<'ONE_DOCUMENT' | 'INDIVIDUAL_DOCUMENTS'>('ONE_DOCUMENT');

  // Workers / Records List
  const [records, setRecords] = useState<WorkerRecord[]>([]);
  const [loadingRecords, setLoadingRecords] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedRecordIds, setSelectedRecordIds] = useState<Set<string>>(new Set());

  // Execution & Preflight State
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [preflightResult, setPreflightResult] = useState<PreflightResult | null>(null);
  const [isMerging, setIsMerging] = useState(false);
  const [mergeSuccess, setMergeSuccess] = useState<{
    jobId: string;
    outputUrl: string;
    recordCount: number;
  } | null>(null);
  const [mergeError, setMergeError] = useState<string | null>(null);

  // Synchronize when parent prop changes
  useEffect(() => {
    if (selectedTemplateId) {
      setTemplateId(selectedTemplateId);
    }
  }, [selectedTemplateId]);

  // Load Templates
  useEffect(() => {
    fetch('/api/document-merge/templates')
      .then((res) => res.json())
      .then((data) => {
        const list = Array.isArray(data) ? data : [];
        setTemplates(list);
        if (!templateId && list.length > 0) {
          const activeFirst = list.find((t: MergeTemplate) => t.isActive) || list[0];
          setTemplateId(activeFirst.id);
          onSelectTemplateId(activeFirst.id);
        }
        setLoadingTemplates(false);
      })
      .catch(() => setLoadingTemplates(false));
  }, []);

  // Update default merge mode when template changes
  useEffect(() => {
    if (templateId && templates.length > 0) {
      const t = templates.find((item) => item.id === templateId);
      if (t?.defaultMergeMode) {
        setMergeMode(t.defaultMergeMode);
      }
    }
    setPreflightResult(null);
    setMergeSuccess(null);
    setMergeError(null);
  }, [templateId, templates]);

  // Load Workers or Registrations
  useEffect(() => {
    setLoadingRecords(true);
    const endpoint = entityType === 'worker_profiles' ? '/api/workers?limit=100' : '/api/registrations?limit=100';

    fetch(endpoint)
      .then((res) => res.json())
      .then((data) => {
        let list: any[] = [];
        if (Array.isArray(data)) {
          list = data;
        } else if (data && Array.isArray(data.rows)) {
          list = data.rows;
        } else if (data && Array.isArray(data.registrations)) {
          list = data.registrations;
        }

        const normalized: WorkerRecord[] = list.map((item) => ({
          id: item.id,
          fullName: item.fullName || item.full_name || 'Chưa có tên',
          cccd: item.cccd || '',
          phone: item.phone || null,
          gender: item.gender || null,
          dob: item.dob || item.bod || null,
          code: item.code || null,
          department: item.deptName || item.department || null,
          status: item.status || (item.isActive ? 'ACTIVE' : null),
        }));

        setRecords(normalized);
        setSelectedRecordIds(new Set());
        setLoadingRecords(false);
      })
      .catch(() => setLoadingRecords(false));
  }, [entityType]);

  // Filtered records
  const filteredRecords = records.filter((r) => {
    const q = searchTerm.toLowerCase().trim();
    if (!q) return true;
    return (
      r.fullName.toLowerCase().includes(q) ||
      r.cccd.toLowerCase().includes(q) ||
      (r.phone && r.phone.toLowerCase().includes(q))
    );
  });

  const handleToggleSelectAll = () => {
    if (selectedRecordIds.size === filteredRecords.length && filteredRecords.length > 0) {
      setSelectedRecordIds(new Set());
    } else {
      setSelectedRecordIds(new Set(filteredRecords.map((r) => r.id)));
    }
  };

  const handleToggleRecord = (id: string) => {
    const next = new Set(selectedRecordIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    setSelectedRecordIds(next);
  };

  // Run Preflight
  const handlePreflight = async () => {
    if (!templateId || selectedRecordIds.size === 0) {
      alert('Vui lòng chọn Template và ít nhất 1 hồ sơ lao động.');
      return;
    }

    setPreflightLoading(true);
    setMergeError(null);
    setPreflightResult(null);

    try {
      const res = await fetch('/api/document-merge/merge/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          templateId,
          mergeMode,
          records: {
            entityType,
            recordIds: Array.from(selectedRecordIds),
          },
          preflight: true,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Preflight check failed');
      setPreflightResult(data);
    } catch (err: any) {
      setMergeError(err.message || 'Lỗi khi kiểm tra dữ liệu trước khi merge');
    } finally {
      setPreflightLoading(false);
    }
  };

  // Run Real Merge
  const handleExecuteMerge = async () => {
    if (!templateId || selectedRecordIds.size === 0) {
      alert('Vui lòng chọn Template và ít nhất 1 hồ sơ lao động.');
      return;
    }

    setIsMerging(true);
    setMergeError(null);
    setMergeSuccess(null);

    try {
      const res = await fetch('/api/document-merge/merge/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          templateId,
          mergeMode,
          records: {
            entityType,
            recordIds: Array.from(selectedRecordIds),
          },
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || data.details || 'Merge operation failed');
      }

      setMergeSuccess({
        jobId: data.jobId,
        outputUrl: data.outputUrl,
        recordCount: selectedRecordIds.size,
      });
    } catch (err: any) {
      setMergeError(err.message || 'Có lỗi xảy ra trong quá trình xuất tài liệu');
    } finally {
      setIsMerging(false);
    }
  };

  const selectedTemplate = templates.find((t) => t.id === templateId);

  return (
    <div className="space-y-6">
      {/* Top Header Information */}
      <div className="rounded-xl border border-slate-200/80 bg-white p-5 shadow-xs">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-base font-bold text-slate-900">Tạo tài liệu từ Template</h2>
            <p className="text-xs text-slate-500">
              Chọn mẫu tài liệu Google Docs, chọn danh sách lao động cần in, và hệ thống sẽ tự động điền các trường tương ứng.
            </p>
          </div>
          {selectedTemplate && (
            <div className="inline-flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-1.5 text-xs text-emerald-800">
              <span className="font-semibold">Đang chọn:</span>
              <span className="font-bold">{selectedTemplate.name}</span>
            </div>
          )}
        </div>
      </div>

      {/* Success Alert */}
      {mergeSuccess && (
        <div className="rounded-2xl border border-emerald-300 bg-emerald-50/80 p-6 shadow-sm">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-600 text-white shadow-sm">
                <CheckCircle2 className="h-6 w-6" />
              </div>
              <div>
                <h3 className="text-base font-bold text-emerald-950">
                  Tạo tài liệu Google Docs thành công!
                </h3>
                <p className="mt-0.5 text-xs text-emerald-800">
                  Đã hoàn thành trộn dữ liệu cho <b>{mergeSuccess.recordCount}</b> hồ sơ lao động.
                </p>
                <div className="mt-2 text-[11px] text-emerald-700">
                  Job ID: <span className="font-mono">{mergeSuccess.jobId}</span>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              <a
                href={mergeSuccess.outputUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-4 py-2.5 text-xs font-bold text-white shadow-sm transition hover:bg-emerald-800"
              >
                <ExternalLink className="h-4 w-4" />
                Mở Google Docs →
              </a>
              <button
                onClick={onSwitchToHistory}
                className="rounded-lg border border-emerald-300 bg-white px-3.5 py-2 text-xs font-semibold text-emerald-800 transition hover:bg-emerald-50"
              >
                Xem lịch sử
              </button>
              <button
                onClick={() => {
                  setMergeSuccess(null);
                  setSelectedRecordIds(new Set());
                }}
                className="rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-600 transition hover:bg-slate-50"
              >
                Tạo merge mới
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Error Alert */}
      {mergeError && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-xs text-red-700 flex items-start gap-2.5">
          <AlertCircle className="h-4 w-4 shrink-0 text-red-600 mt-0.5" />
          <div className="flex-1">
            <span className="font-bold">Lỗi: </span>
            {mergeError}
          </div>
        </div>
      )}

      {/* Form Steps Grid */}
      <div className="grid gap-6 lg:grid-cols-3">
        {/* Left Column: Config Panel (1 Col) */}
        <div className="space-y-6 lg:col-span-1">
          {/* STEP 1: Select Template */}
          <div className="rounded-xl border border-slate-200/80 bg-white p-5 shadow-xs">
            <div className="flex items-center gap-2 border-b border-slate-100 pb-3">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-700 text-xs font-bold text-white">
                1
              </span>
              <h3 className="text-sm font-bold text-slate-900">Chọn Template</h3>
            </div>

            <div className="mt-4 space-y-3">
              {loadingTemplates ? (
                <div className="py-4 text-center text-xs text-slate-400">Đang tải templates...</div>
              ) : templates.length === 0 ? (
                <div className="rounded-lg border border-dashed border-slate-200 p-4 text-center text-xs text-slate-500">
                  Chưa có template nào. Vui lòng tạo template ở tab &quot;Templates&quot;.
                </div>
              ) : (
                <>
                  <div>
                    <label className="block text-xs font-semibold text-slate-700">Mẫu tài liệu</label>
                    <select
                      value={templateId}
                      onChange={(e) => {
                        setTemplateId(e.target.value);
                        onSelectTemplateId(e.target.value);
                      }}
                      className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-800 outline-none focus:border-emerald-600"
                    >
                      {templates.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name} {!t.isActive ? '(Tắt)' : ''}
                        </option>
                      ))}
                    </select>
                  </div>

                  {selectedTemplate && (
                    <div className="rounded-lg bg-slate-50 p-3 text-[11px] text-slate-600 space-y-1.5">
                      <div className="flex justify-between">
                        <span className="text-slate-400">Placeholders:</span>
                        <span className="font-semibold text-emerald-700">
                          {selectedTemplate.placeholderCount || 0} trường
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-400">Doc ID:</span>
                        <span className="font-mono text-slate-700 truncate max-w-[120px]">
                          {selectedTemplate.googleDocId}
                        </span>
                      </div>
                      <div className="pt-1 text-right">
                        <a
                          href={`https://docs.google.com/document/d/${selectedTemplate.googleDocId}/edit`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-emerald-700 hover:underline"
                        >
                          <ExternalLink className="h-3 w-3" />
                          Xem mẫu gốc trên Google Docs
                        </a>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {/* STEP 2: Merge Mode */}
          <div className="rounded-xl border border-slate-200/80 bg-white p-5 shadow-xs">
            <div className="flex items-center gap-2 border-b border-slate-100 pb-3">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-700 text-xs font-bold text-white">
                2
              </span>
              <h3 className="text-sm font-bold text-slate-900">Chế độ Merge</h3>
            </div>

            <div className="mt-4 space-y-2.5">
              <label
                className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition ${
                  mergeMode === 'ONE_DOCUMENT'
                    ? 'border-emerald-600 bg-emerald-50/50'
                    : 'border-slate-200 hover:bg-slate-50'
                }`}
              >
                <input
                  type="radio"
                  name="mergeMode"
                  value="ONE_DOCUMENT"
                  checked={mergeMode === 'ONE_DOCUMENT'}
                  onChange={() => setMergeMode('ONE_DOCUMENT')}
                  className="mt-0.5 text-emerald-600 focus:ring-emerald-500"
                />
                <div className="text-xs">
                  <div className="font-bold text-slate-900">Gộp chung 1 file Google Docs</div>
                  <div className="text-[11px] text-slate-500">
                    Tất cả các lao động được gộp vào một tài liệu duy nhất (có dấu ngắt trang tự động).
                  </div>
                </div>
              </label>

              <label
                className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition ${
                  mergeMode === 'INDIVIDUAL_DOCUMENTS'
                    ? 'border-emerald-600 bg-emerald-50/50'
                    : 'border-slate-200 hover:bg-slate-50'
                }`}
              >
                <input
                  type="radio"
                  name="mergeMode"
                  value="INDIVIDUAL_DOCUMENTS"
                  checked={mergeMode === 'INDIVIDUAL_DOCUMENTS'}
                  onChange={() => setMergeMode('INDIVIDUAL_DOCUMENTS')}
                  className="mt-0.5 text-emerald-600 focus:ring-emerald-500"
                />
                <div className="text-xs">
                  <div className="font-bold text-slate-900">Tài liệu riêng từng người</div>
                  <div className="text-[11px] text-slate-500">
                    Tạo tài liệu riêng biệt cho mỗi lao động trong thư mục đích.
                  </div>
                </div>
              </label>
            </div>
          </div>

          {/* STEP 4: Execution Actions */}
          <div className="rounded-xl border border-slate-200/80 bg-white p-5 shadow-xs">
            <div className="flex items-center gap-2 border-b border-slate-100 pb-3">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-700 text-xs font-bold text-white">
                4
              </span>
              <h3 className="text-sm font-bold text-slate-900">Kiểm tra & Xuất</h3>
            </div>

            <div className="mt-4 space-y-3">
              <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600 space-y-1">
                <div className="flex justify-between">
                  <span>Số hồ sơ đã chọn:</span>
                  <span className="font-bold text-slate-900">{selectedRecordIds.size} lao động</span>
                </div>
                <div className="flex justify-between">
                  <span>Mẫu áp dụng:</span>
                  <span className="font-medium text-slate-700 truncate max-w-[140px]">
                    {selectedTemplate ? selectedTemplate.name : 'Chưa chọn'}
                  </span>
                </div>
              </div>

              {/* Preflight result card */}
              {preflightResult && (
                <div
                  className={`rounded-lg p-3 text-xs ${
                    preflightResult.valid
                      ? 'border border-emerald-200 bg-emerald-50 text-emerald-800'
                      : 'border border-amber-200 bg-amber-50 text-amber-800'
                  }`}
                >
                  <div className="font-bold flex items-center gap-1.5">
                    {preflightResult.valid ? (
                      <>
                        <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                        Sẵn sàng thực hiện merge!
                      </>
                    ) : (
                      <>
                        <AlertCircle className="h-4 w-4 text-amber-600" />
                        Cảnh báo: Có trường thiếu dữ liệu
                      </>
                    )}
                  </div>
                  <div className="mt-1 text-[11px]">
                    Đã ánh xạ: {preflightResult.mappedPlaceholders} / {preflightResult.totalPlaceholders} trường.
                  </div>
                </div>
              )}

              <div className="flex flex-col gap-2 pt-2">
                <button
                  type="button"
                  onClick={handlePreflight}
                  disabled={preflightLoading || selectedRecordIds.size === 0 || !templateId}
                  className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white py-2 text-xs font-semibold text-slate-700 shadow-xs transition hover:bg-slate-50 disabled:opacity-50"
                >
                  <FileCheck className="h-3.5 w-3.5 text-slate-500" />
                  {preflightLoading ? 'Đang kiểm tra...' : 'Kiểm tra dữ liệu (Preflight)'}
                </button>

                <button
                  type="button"
                  onClick={handleExecuteMerge}
                  disabled={isMerging || selectedRecordIds.size === 0 || !templateId}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-700 py-2.5 text-xs font-bold text-white shadow-sm transition hover:bg-emerald-800 disabled:opacity-50"
                >
                  {isMerging ? (
                    <>
                      <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                      Đang thực hiện merge...
                    </>
                  ) : (
                    <>
                      <Sparkles className="h-4 w-4" />
                      Thực hiện Merge ({selectedRecordIds.size})
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: Worker Selection Table (2 Cols) */}
        <div className="space-y-4 lg:col-span-2">
          <div className="rounded-xl border border-slate-200/80 bg-white shadow-xs">
            <div className="border-b border-slate-100 p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-2">
                  <span className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-700 text-xs font-bold text-white">
                    3
                  </span>
                  <h3 className="text-sm font-bold text-slate-900">Chọn Hồ sơ Lao động</h3>
                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-bold text-emerald-800">
                    Đã chọn {selectedRecordIds.size} / {filteredRecords.length}
                  </span>
                </div>

                {/* Entity Type Switcher */}
                <div className="flex rounded-lg bg-slate-100 p-0.5 text-xs">
                  <button
                    type="button"
                    onClick={() => setEntityType('worker_profiles')}
                    className={`rounded-md px-3 py-1 font-medium transition ${
                      entityType === 'worker_profiles'
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-500 hover:text-slate-800'
                    }`}
                  >
                    Hồ sơ Tập nghề (DW)
                  </button>
                  <button
                    type="button"
                    onClick={() => setEntityType('daily_applications')}
                    className={`rounded-md px-3 py-1 font-medium transition ${
                      entityType === 'daily_applications'
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-500 hover:text-slate-800'
                    }`}
                  >
                    Daily Application
                  </button>
                </div>
              </div>

              {/* Search & Actions Bar */}
              <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                  <input
                    type="text"
                    placeholder="Tìm theo họ tên, số CCCD, số điện thoại..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="w-full rounded-lg border border-slate-200 bg-slate-50/50 py-1.5 pl-8 pr-3 text-xs outline-none focus:border-emerald-600 focus:bg-white"
                  />
                </div>

                <button
                  type="button"
                  onClick={handleToggleSelectAll}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                >
                  {selectedRecordIds.size === filteredRecords.length && filteredRecords.length > 0 ? (
                    <>
                      <Square className="h-3.5 w-3.5 text-slate-400" />
                      Bỏ chọn tất cả
                    </>
                  ) : (
                    <>
                      <CheckSquare className="h-3.5 w-3.5 text-emerald-600" />
                      Chọn tất cả ({filteredRecords.length})
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Workers Table */}
            <div className="max-h-[520px] overflow-y-auto">
              {loadingRecords ? (
                <div className="flex flex-col items-center justify-center py-16 text-slate-400">
                  <div className="h-6 w-6 animate-spin rounded-full border-2 border-emerald-700 border-t-transparent" />
                  <p className="mt-2 text-xs">Đang tải danh sách lao động...</p>
                </div>
              ) : filteredRecords.length === 0 ? (
                <div className="p-8 text-center text-xs text-slate-500">
                  Không tìm thấy hồ sơ lao động nào phù hợp với bộ lọc.
                </div>
              ) : (
                <table className="w-full border-collapse text-left text-xs">
                  <thead className="sticky top-0 bg-slate-50 text-[11px] font-bold text-slate-500 uppercase tracking-wider">
                    <tr className="border-b border-slate-200">
                      <th className="w-10 px-4 py-2.5 text-center">
                        <input
                          type="checkbox"
                          checked={
                            selectedRecordIds.size === filteredRecords.length && filteredRecords.length > 0
                          }
                          onChange={handleToggleSelectAll}
                          className="rounded text-emerald-600 focus:ring-emerald-500"
                        />
                      </th>
                      <th className="px-4 py-2.5">Họ và tên</th>
                      <th className="px-4 py-2.5">Số CCCD</th>
                      <th className="px-4 py-2.5">Số ĐT / Giới tính</th>
                      <th className="px-4 py-2.5">Bộ phận / Trạng thái</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredRecords.map((r) => {
                      const isSelected = selectedRecordIds.has(r.id);
                      return (
                        <tr
                          key={r.id}
                          onClick={() => handleToggleRecord(r.id)}
                          className={`cursor-pointer transition hover:bg-slate-50 ${
                            isSelected ? 'bg-emerald-50/60 font-medium' : ''
                          }`}
                        >
                          <td className="px-4 py-2.5 text-center" onClick={(e) => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => handleToggleRecord(r.id)}
                              className="rounded text-emerald-600 focus:ring-emerald-500"
                            />
                          </td>
                          <td className="px-4 py-2.5 text-slate-900 font-medium">
                            {r.fullName}
                            {r.code && (
                              <span className="ml-1.5 text-[10px] text-slate-400 font-mono">
                                ({r.code})
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-2.5 font-mono text-slate-600">{r.cccd || '—'}</td>
                          <td className="px-4 py-2.5 text-slate-500">
                            {r.phone || '—'}
                            {r.gender && (
                              <span className="ml-1.5 inline-block rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600">
                                {r.gender}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-2.5 text-slate-500">
                            {r.department || '—'}
                            {r.status && (
                              <span className="ml-1.5 inline-block rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700">
                                {r.status}
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// TAB 3: MERGE HISTORY
// =============================================================================
function HistoryTab() {
  const [loading, setLoading] = useState(true);
  const [history, setHistory] = useState<any[]>([]);

  const loadHistory = () => {
    setLoading(true);
    fetch('/api/document-merge/history')
      .then((res) => res.json())
      .then((data) => {
        setHistory(Array.isArray(data) ? data : []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  };

  useEffect(() => {
    loadHistory();
  }, []);

  const handleDeleteJob = async (jobId: string) => {
    if (!confirm('Bạn có chắc chắn muốn xoá lịch sử merge này?')) return;
    try {
      const res = await fetch(`/api/document-merge/history/${jobId}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        loadHistory();
      }
    } catch (err) {
      console.error('Delete job failed', err);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <div className="flex flex-col items-center gap-2">
          <div className="h-8 w-8 animate-spin rounded-full border-3 border-emerald-700 border-t-transparent" />
          <p className="text-xs text-slate-500">Đang tải lịch sử merge...</p>
        </div>
      </div>
    );
  }

  if (history.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-12 text-center shadow-xs">
        <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-50 text-emerald-700">
          <HistoryIcon className="h-6 w-6" />
        </div>
        <h3 className="mt-4 text-sm font-bold text-slate-900">Chưa có lịch sử merge</h3>
        <p className="mx-auto mt-1 max-w-sm text-xs text-slate-500">
          Các lần thực hiện xuất tài liệu Google Docs sẽ được ghi nhận và hiển thị chi tiết tại đây.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-bold text-slate-900">Lịch sử Merge Documents</h2>
          <p className="text-xs text-slate-500">Theo dõi trạng thái và đường dẫn tải các tài liệu đã tạo.</p>
        </div>
        <button
          onClick={loadHistory}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
        >
          <RefreshCw className="h-3.5 w-3.5 text-slate-400" />
          Làm mới
        </button>
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-xs">
        <ul className="divide-y divide-slate-100">
          {history.map((job) => (
            <li key={job.id} className="p-4 transition hover:bg-slate-50">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-slate-900 text-sm">
                      {job.templateNameSnapshot || 'Template không tên'}
                    </span>
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${
                        job.status === 'COMPLETED'
                          ? 'bg-emerald-50 text-emerald-700'
                          : job.status === 'FAILED'
                          ? 'bg-red-50 text-red-700'
                          : 'bg-amber-50 text-amber-700'
                      }`}
                    >
                      {job.status}
                    </span>
                  </div>

                  <p className="mt-1 text-xs text-slate-500">
                    {job.recordCount} hồ sơ • {job.mergeMode === 'ONE_DOCUMENT' ? '1 File gộp' : 'File riêng lẻ'} •
                    Tạo bởi <span className="font-medium text-slate-700">{job.createdBy}</span> vào lúc{' '}
                    {new Date(job.createdAt).toLocaleString('vi-VN')}
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  {job.outputUrl && job.status === 'COMPLETED' && (
                    <a
                      href={job.outputUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded-lg bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-700 hover:text-white transition"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      Mở Google Docs
                    </a>
                  )}

                  <button
                    onClick={() => handleDeleteJob(job.id)}
                    className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600 transition"
                    title="Xoá nhật ký"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// =============================================================================
// TAB 4: FIELDS & PLACEHOLDERS CATALOG
// =============================================================================
function FieldsTab() {
  const [loading, setLoading] = useState(true);
  const [catalog, setCatalog] = useState<any>(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    fetch('/api/document-merge/field-catalog')
      .then((res) => res.json())
      .then((data) => {
        setCatalog(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <div className="flex flex-col items-center gap-2">
          <div className="h-8 w-8 animate-spin rounded-full border-3 border-emerald-700 border-t-transparent" />
          <p className="text-xs text-slate-500">Đang tải danh mục trường dữ liệu...</p>
        </div>
      </div>
    );
  }

  if (!catalog) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-xs text-slate-500">
        Không thể tải danh mục trường dữ liệu.
      </div>
    );
  }

  const categoryLabels: Record<string, string> = {
    worker_profile: 'Hồ sơ Tập nghề (Worker Profile)',
    daily_application: 'Đơn đăng ký (Daily Application)',
    employment_session: 'Phiên làm việc (Employment Session)',
    department: 'Bộ phận / Cơ cấu tổ chức',
    dynamic_form: 'Câu hỏi động (Dynamic Form)',
    computed: 'Trường tính toán (Computed)',
    system: 'Trường hệ thống (System)',
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-base font-bold text-slate-900">Danh mục Field & Placeholder Catalog</h2>
          <p className="text-xs text-slate-500">
            Tổng cộng <b>{catalog.totalFields}</b> trường dữ liệu có sẵn để gắn vào các thẻ &lt;&lt;...&gt;&gt; trong Google Docs.
          </p>
        </div>

        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="Tìm kiếm placeholder hoặc nhãn..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg border border-slate-200 bg-white py-1.5 pl-8 pr-3 text-xs outline-none focus:border-emerald-600"
          />
        </div>
      </div>

      <div className="space-y-6">
        {Object.entries(catalog.groupedCatalog || {}).map(([category, fieldsArr]) => {
          const list = (fieldsArr as any[]).filter((f) => {
            const q = search.toLowerCase().trim();
            if (!q) return true;
            return (
              f.label.toLowerCase().includes(q) ||
              f.suggestedPlaceholder.toLowerCase().includes(q) ||
              f.databaseSource.toLowerCase().includes(q)
            );
          });

          if (list.length === 0) return null;

          return (
            <div key={category} className="overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-xs">
              <div className="border-b border-slate-100 bg-slate-50/80 px-4 py-3">
                <h3 className="text-xs font-bold text-slate-800">
                  {categoryLabels[category] || category} ({list.length})
                </h3>
              </div>

              <div className="divide-y divide-slate-100">
                {list.map((field: any) => (
                  <div key={field.fieldKey} className="flex flex-col gap-2 p-3.5 sm:flex-row sm:items-center sm:justify-between text-xs">
                    <div>
                      <div className="font-semibold text-slate-900">{field.label}</div>
                      <div className="font-mono text-[11px] text-slate-400">{field.databaseSource}</div>
                    </div>

                    <div className="flex items-center gap-3">
                      <span className="rounded bg-slate-100 px-2 py-0.5 text-[11px] font-mono text-slate-700">
                        &lt;&lt;{field.suggestedPlaceholder}&gt;&gt;
                      </span>
                      <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                        {field.fieldType}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
