"use client";
/**
 * PDF Overlay — tab wrapper (PR3).
 * Workflow: Template → PDF Overlay → PDF Versions → DRAFT → Visual Mapper.
 * Admin chọn template rồi quản lý PDF Overlay cho template đó. Đây là UI CẤU HÌNH
 * — PDF Overlay CHƯA được kích hoạt cho merge production (engine vẫn GOOGLE_DOCS).
 */

import { useEffect, useState } from "react";
import { FileText, FolderOpen } from "lucide-react";
import { PdfVersionManager } from "./pdf-version-manager";

interface TemplateItem {
  id: string;
  name: string;
  documentKind?: string;
}

export function PdfOverlayTab() {
  const [templates, setTemplates] = useState<TemplateItem[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/document-merge/templates", { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        const list = (Array.isArray(data) ? data : []) as TemplateItem[];
        setTemplates(list);
        if (list.length > 0 && !selectedId) setSelectedId(list[0].id);
      })
      .catch(() => setError("Không tải được danh sách template."))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">Đang tải template...</div>;
  }
  if (error) {
    return <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-sm text-red-700">{error}</div>;
  }
  if (templates.length === 0) {
    return <div className="rounded-xl border border-dashed border-slate-300 bg-white p-12 text-center text-sm text-slate-500">Chưa có template merge.</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-800 text-white">
            <FileText className="h-5 w-5" />
          </div>
          <div>
            <div className="text-base font-bold text-slate-900">PDF Overlay — Admin Visual Mapper</div>
            <div className="text-xs text-slate-500">Map placeholder lên blank PDF template. CHỈ cấu hình — chưa kích hoạt engine.</div>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white p-3">
        <FolderOpen className="h-4 w-4 text-slate-400" />
        <span className="text-xs font-semibold text-slate-500">Template:</span>
        <select
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 outline-none focus:border-emerald-600"
        >
          {templates.map((t) => (
            <option key={t.id} value={t.id}>{t.name}{t.documentKind ? ` (${t.documentKind})` : ""}</option>
          ))}
        </select>
      </div>

      {selectedId && <PdfVersionManager templateId={selectedId} />}
    </div>
  );
}
