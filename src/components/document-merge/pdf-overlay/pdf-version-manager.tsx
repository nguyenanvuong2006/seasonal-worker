"use client";
/**
 * PDF Overlay — PDF Versions manager (PR3).
 * Workflow: Template → PDF Overlay → PDF Versions → select/create DRAFT → Visual Mapper.
 * Admin thấy version, phân biệt DRAFT/PUBLISHED/ARCHIVED, tạo DRAFT (upload blank PDF),
 * xem metadata (version, SHA-256, page count, page dimensions, created date/user, status),
 * verify integrity, publish (CHỈ qua PR2 lifecycle API), archive (nơi được phép).
 * Không bao giờ sửa position trên PUBLISHED/ARCHIVED (mapper mở read-only).
 */

import { useEffect, useRef, useState } from "react";
import {
  Archive,
  ArrowLeft,
  FileUp,
  Files,
  FolderOpen,
  Loader2,
  Lock,
  RefreshCw,
  ScanSearch,
  ShieldCheck,
  Upload,
} from "lucide-react";
import { PdfOverlayMapper } from "./pdf-overlay-mapper";
import type { PageLayoutEntry } from "@/lib/document-merge/pdf-overlay/mapper/validation-summary";

export interface PdfVersion {
  id: string;
  templateId: string;
  version: number;
  status: "DRAFT" | "PUBLISHED" | "ARCHIVED";
  pdfStorageKey: string;
  sha256: string;
  pageCount: number;
  pageLayout: PageLayoutEntry[];
  sourceNote: string | null;
  createdBy: string;
  publishedAt: string | null;
  archivedAt: string | null;
  supersededBy: number | null;
  createdAt: string;
  updatedAt: string;
}

const STATUS_STYLE: Record<string, string> = {
  DRAFT: "bg-amber-50 text-amber-700 border-amber-200",
  PUBLISHED: "bg-emerald-50 text-emerald-700 border-emerald-200",
  ARCHIVED: "bg-slate-100 text-slate-500 border-slate-200",
};

export function PdfVersionManager({ templateId, onBack }: { templateId: string; onBack?: () => void }) {
  const [versions, setVersions] = useState<PdfVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openVersion, setOpenVersion] = useState<PdfVersion | null>(null);
  const [uploading, setUploading] = useState(false);
  const [verifyMsg, setVerifyMsg] = useState<Record<string, string>>({});
  const [actingVersion, setActingVersion] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/document-merge/templates/${templateId}/pdf-versions`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Không tải được PDF versions.");
      setVersions(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không tải được PDF versions.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [templateId]);

  const uploadFile = async (file: File) => {
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`/api/document-merge/templates/${templateId}/pdf-versions`, {
        method: "POST",
        body: form,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Không tạo được DRAFT.");
      setVersions((v) => [data, ...v]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload thất bại.");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const action = async (
    versionId: string,
    kind: "publish" | "archive" | "verify",
  ) => {
    setActingVersion(versionId);
    setError(null);
    try {
      if (kind === "verify") {
        const res = await fetch(
          `/api/document-merge/templates/${templateId}/pdf-versions/${versionId}/verify`,
          { cache: "no-store" },
        );
        const data = await res.json();
        setVerifyMsg((m) => ({
          ...m,
          [versionId]: res.ok ? `✓ Nguyên vẹn (${data.pageCount} trang, SHA256 ${data.sha256.slice(0, 12)}…)` : `✗ ${data.error || "Integrity fail"}`,
        }));
      } else {
        const res = await fetch(
          `/api/document-merge/templates/${templateId}/pdf-versions/${versionId}/${kind}`,
          { method: "POST" },
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Không ${kind} được version.`);
        setOpenVersion(null);
        await load();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Thao tác thất bại.");
    } finally {
      setActingVersion(null);
    }
  };

  if (openVersion) {
    return (
      <PdfOverlayMapper
        templateId={templateId}
        version={openVersion}
        onBack={() => setOpenVersion(null)}
        onPublished={() => setOpenVersion(null)}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {onBack && (
            <button onClick={onBack} className="rounded-lg border border-slate-200 p-2 text-slate-500 hover:bg-slate-50">
              <ArrowLeft className="h-4 w-4" />
            </button>
          )}
          <div>
            <div className="text-base font-bold text-slate-900">PDF Overlay — PDF Versions</div>
            <div className="text-xs text-slate-500">Tạo DRAFT (upload blank PDF) → Visual Mapper → Publish (CHỈ qua PR2 lifecycle API). PDF Overlay CHƯA được kích hoạt cho merge production.</div>
          </div>
        </div>
        <div className="flex gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf,.pdf"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) uploadFile(f);
            }}
          />
          <button onClick={() => fileRef.current?.click()} disabled={uploading} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-50">
            {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />} Tạo DRAFT (upload PDF)
          </button>
          <button onClick={load} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">
            <RefreshCw className="h-3.5 w-3.5" /> Làm mới
          </button>
        </div>
      </div>

      {error && <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-xs text-red-700">{error}</div>}

      {loading ? (
        <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">Đang tải PDF versions...</div>
      ) : versions.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-12 text-center">
          <Files className="mx-auto mb-2 h-8 w-8 text-slate-300" />
          <div className="text-sm text-slate-500">Chưa có PDF version nào.</div>
          <div className="mt-1 text-xs text-slate-400">Upload blank PDF để tạo DRAFT đầu tiên.</div>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xs">
          <ul className="divide-y divide-slate-100">
            {versions.map((v) => {
              const editable = v.status === "DRAFT";
              return (
                <li key={v.id} className="flex flex-col gap-3 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <span className={`rounded-full border px-2 py-0.5 text-[10px] font-bold ${STATUS_STYLE[v.status]}`}>{v.status}</span>
                      <span className="text-sm font-bold text-slate-900">Version {v.version}</span>
                      {v.status === "PUBLISHED" && v.publishedAt && (
                        <span className="text-[11px] text-slate-400">published {new Date(v.publishedAt).toLocaleString("vi-VN")}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {verifyMsg[v.id] && <span className="max-w-64 truncate text-[11px] text-slate-500">{verifyMsg[v.id]}</span>}
                      <button onClick={() => action(v.id, "verify")} disabled={!!actingVersion} className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50">
                        <ScanSearch className="h-3 w-3" /> Verify
                      </button>
                      {editable && (
                        <>
                          <button onClick={() => action(v.id, "publish")} disabled={!!actingVersion} className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-emerald-700">
                            <ShieldCheck className="h-3 w-3" /> Publish
                          </button>
                          <button onClick={() => action(v.id, "archive")} disabled={!!actingVersion} className="inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50">
                            <Archive className="h-3 w-3" /> Archive
                          </button>
                        </>
                      )}
                      <button
                        onClick={() => setOpenVersion(v)}
                        className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-100"
                      >
                        <FolderOpen className="h-3 w-3" /> {editable ? "Open Visual Mapper" : "Xem (read-only)"}
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg bg-slate-50 p-3 text-[11px] text-slate-600 sm:grid-cols-4">
                    <div><span className="text-slate-400">SHA-256:</span> <span className="font-mono">{v.sha256.slice(0, 16)}…</span></div>
                    <div><span className="text-slate-400">Số trang:</span> {v.pageCount}</div>
                    <div>
                      <span className="text-slate-400">Kích thước:</span>{" "}
                      {v.pageLayout.length > 0
                        ? v.pageLayout.map((p) => `${Math.round(p.width)}×${Math.round(p.height)}`).join(", ")
                        : "—"}
                    </div>
                    <div><span className="text-slate-400">Tạo bởi:</span> {v.createdBy} · {new Date(v.createdAt).toLocaleString("vi-VN")}</div>
                  </div>

                  {!editable && (
                    <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-400">
                      <Lock className="h-3 w-3" /> Position đang khoá (read-only) — không thể sửa.
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
