"use client";

/**
 * PDF Overlay Mapper — Admin UI chính (PR3).
 *
 * Tabs: Versions (quản lý version + upload blank PDF + publish/archive/verify)
 *       Mapper  (đặt box position trên PDF + properties + preview).
 *
 * RBAC: server-side route nào cũng yêu cầu document_merge.templates.manage;
 * client chỉ hiển thị/ẩn theo response (không phải lớp bảo mật).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, ShieldCheck, Trash2, Upload } from "lucide-react";

import { PdfViewer } from "./pdf-viewer";
import { PropertiesPanel } from "./properties-panel";
import {
  isVersionEditable,
  VERSION_STATUS_LABEL,
  formatPt,
  type IntegrityResult,
  type PdfPosition,
  type PdfVersion,
  type PositionInput,
} from "./mapper-types";

type Mode = "versions" | "mapper";

const statusCls: Record<PdfVersion["status"], string> = {
  DRAFT: "bg-amber-50 text-amber-700",
  PUBLISHED: "bg-emerald-50 text-emerald-700",
  ARCHIVED: "bg-slate-100 text-slate-500",
};

export function PdfMapper({ templateId }: { templateId: string }) {
  const [mode, setMode] = useState<Mode>("versions");
  const [versions, setVersions] = useState<PdfVersion[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const selectedVersion = useMemo(
    () => versions.find((v) => v.id === selectedVersionId) ?? null,
    [versions, selectedVersionId],
  );
  const readOnly = selectedVersion ? !isVersionEditable(selectedVersion.status) : true;

  const loadVersions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/document-merge/templates/${templateId}/pdf-versions`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Không tải được danh sách version.");
      const list = Array.isArray(data) ? data : [];
      setVersions(list);
      setSelectedVersionId((prev) => prev ?? list[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không tải được version.");
    } finally {
      setLoading(false);
    }
  }, [templateId]);

  useEffect(() => {
    loadVersions();
  }, [loadVersions]);

  const flash = (msg: string) => {
    setNotice(msg);
    window.setTimeout(() => setNotice(null), 4000);
  };

  // ---------- Version actions ----------
  const createVersion = async (file: File) => {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`/api/document-merge/templates/${templateId}/pdf-versions`, {
      method: "POST",
      body: form,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Không tạo được version.");
    await loadVersions();
    setSelectedVersionId(data.id);
    setMode("mapper");
    flash(`Đã tạo version DRAFT v${data.version}.`);
  };

  const act = async (versionId: string, action: "publish" | "archive") => {
    if (action === "archive" && !confirm("Archive version DRAFT này?")) return;
    if (action === "publish" && !confirm("Publish version này? Version PUBLISHED hiện tại sẽ bị archive.")) return;
    const res = await fetch(`/api/document-merge/templates/${templateId}/pdf-versions/${versionId}/${action}`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || `Không ${action} được version.`);
      return;
    }
    await loadVersions();
    flash(`Đã ${action} version.`);
  };

  const [integrity, setIntegrity] = useState<Record<string, IntegrityResult>>({});
  const verify = async (versionId: string) => {
    setIntegrity((prev) => ({ ...prev, [versionId]: { checking: true } as unknown as IntegrityResult }));
    try {
      const res = await fetch(`/api/document-merge/templates/${templateId}/pdf-versions/${versionId}/verify`, { cache: "no-store" });
      const data = await res.json();
      setIntegrity((prev) => ({ ...prev, [versionId]: data }));
    } catch {
      setIntegrity((prev) => ({ ...prev, [versionId]: { ok: false, sha256: "", expectedSha256: "" } }));
    }
  };

  // ---------- Mapper: positions ----------
  const [positions, setPositions] = useState<PdfPosition[]>([]);
  const [selectedPositionId, setSelectedPositionId] = useState<string | null>(null);
  const [placingPlaceholder, setPlacingPlaceholder] = useState<string | null>(null);
  const [placeholders, setPlaceholders] = useState<string[]>([]);
  const [pageNumber, setPageNumber] = useState(1);
  const [scale, setScale] = useState(1);
  const [mapperError, setMapperError] = useState<string | null>(null);

  const selectedPosition = useMemo(
    () => positions.find((p) => p.id === selectedPositionId) ?? null,
    [positions, selectedPositionId],
  );

  useEffect(() => {
    if (!selectedVersionId) return;
    let cancelled = false;
    (async () => {
      setMapperError(null);
      try {
        const [posRes, fieldRes] = await Promise.all([
          fetch(`/api/document-merge/templates/${templateId}/pdf-versions/${selectedVersionId}/positions`, { cache: "no-store" }),
          fetch(`/api/document-merge/templates/${templateId}/fields`, { cache: "no-store" }),
        ]);
        const posData = await posRes.json();
        if (!posRes.ok) throw new Error(posData.error || "Không tải được positions.");
        setPositions(Array.isArray(posData) ? posData : []);
        setSelectedPositionId(null);
        setPageNumber(1);

        const fieldData = await fieldRes.json();
        if (Array.isArray(fieldData)) {
          setPlaceholders(fieldData.map((f: { placeholder: string }) => f.placeholder).sort());
        }
      } catch (err) {
        setMapperError(err instanceof Error ? err.message : "Không tải được dữ liệu mapper.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedVersionId, templateId]);

  const patchPosition = useCallback(
    async (id: string, input: PositionInput) => {
      const res = await fetch(
        `/api/document-merge/templates/${templateId}/pdf-versions/${selectedVersionId}/positions/${id}`,
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) },
      );
      const data = await res.json();
      if (!res.ok) {
        setMapperError(data.error || "Không lưu được position.");
        return;
      }
      setPositions((prev) => prev.map((p) => (p.id === id ? data : p)));
      setSelectedPositionId(id);
    },
    [templateId, selectedVersionId],
  );

  const createPosition = useCallback(
    async (input: PositionInput) => {
      const res = await fetch(
        `/api/document-merge/templates/${templateId}/pdf-versions/${selectedVersionId}/positions`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) },
      );
      const data = await res.json();
      if (!res.ok) {
        setMapperError(data.error || "Không tạo được position.");
        return;
      }
      setPositions((prev) => [...prev, data]);
      setSelectedPositionId(data.id);
      setPlacingPlaceholder(null);
    },
    [templateId, selectedVersionId],
  );

  const deletePosition = useCallback(
    async (id: string) => {
      if (!confirm("Xoá position này?")) return;
      const res = await fetch(
        `/api/document-merge/templates/${templateId}/pdf-versions/${selectedVersionId}/positions/${id}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setMapperError(data.error || "Không xoá được position.");
        return;
      }
      setPositions((prev) => prev.filter((p) => p.id !== id));
      if (selectedPositionId === id) setSelectedPositionId(null);
    },
    [templateId, selectedVersionId, selectedPositionId],
  );

  const handleCommit = useCallback(
    (position: PdfPosition, box: { x: number; y: number; width: number; height: number }) => {
      patchPosition(position.id, {
        placeholder: position.placeholder,
        pageNumber: position.pageNumber,
        ...box,
        type: position.type,
      });
    },
    [patchPosition],
  );

  const handlePlace = useCallback(
    (page: number, box: { x: number; y: number; width: number; height: number }) => {
      if (!placingPlaceholder) return;
      createPosition({
        placeholder: placingPlaceholder,
        pageNumber: page,
        ...box,
        type: "TEXT",
      });
    },
    [placingPlaceholder, createPosition],
  );

  // ---------- Preview (non-production) ----------
  const [previewValues, setPreviewValues] = useState<string>("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const renderPreview = async () => {
    setPreviewLoading(true);
    setPreviewError(null);
    setPreviewUrl(null);
    try {
      let fieldValues: Record<string, string> = {};
      if (previewValues.trim()) {
        fieldValues = JSON.parse(previewValues);
      }
      const res = await fetch(
        `/api/document-merge/templates/${templateId}/pdf-versions/${selectedVersionId}/preview`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fieldValues }) },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Preview thất bại (${res.status}).`);
      }
      const blob = await res.blob();
      setPreviewUrl(URL.createObjectURL(blob));
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : "Preview thất bại.");
    } finally {
      setPreviewLoading(false);
    }
  };

  if (loading) {
    return <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-sm text-slate-500">Đang tải PDF versions...</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-slate-900">PDF Overlay Mapper</h2>
          <p className="text-xs text-slate-500">Bản đồ tọa độ PDF (bất hoạt — engine vẫn GOOGLE_DOCS). Chỉ quản lý template PDF nền + vị trí field.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setMode("versions")} className={`rounded-lg border px-3 py-2 text-xs font-semibold ${mode === "versions" ? "border-emerald-700 bg-emerald-50 text-emerald-800" : "border-slate-200 bg-white text-slate-600"}`}>Versions</button>
          <button onClick={() => setMode("mapper")} disabled={!selectedVersionId} className={`rounded-lg border px-3 py-2 text-xs font-semibold ${mode === "mapper" ? "border-emerald-700 bg-emerald-50 text-emerald-800" : "border-slate-200 bg-white text-slate-600 disabled:opacity-40"}`}>Mapper</button>
        </div>
      </div>

      {notice && <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-700">{notice}</div>}
      {error && <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700">{error}</div>}

      {mode === "versions" && (
        <div className="space-y-4">
          <VersionUpload onCreate={createVersion} />
          {versions.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">
              Chưa có PDF template version nào — upload blank PDF để bắt đầu.
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
              <ul className="divide-y divide-slate-100">
                {versions.map((v) => {
                  const it = integrity[v.id];
                  return (
                    <li key={v.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-bold text-slate-900">v{v.version}</span>
                          <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${statusCls[v.status]}`}>{VERSION_STATUS_LABEL[v.status]}</span>
                          {v.pageCount > 0 && <span className="text-[11px] text-slate-500">{v.pageCount} trang</span>}
                          {it && !("checking" in it) && (
                            <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${it.ok ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>
                              {it.ok ? "Integrity OK" : "Integrity FAIL"}
                            </span>
                          )}
                        </div>
                        <p className="mt-1 text-[11px] text-slate-500">
                          {formatPt(v.pageLayout?.[0]?.width)}×{formatPt(v.pageLayout?.[0]?.height)}pt · {v.createdBy} · {new Date(v.createdAt).toLocaleString("vi-VN")}
                        </p>
                        <p className="font-mono text-[10px] text-slate-400">sha256 {v.sha256.slice(0, 16)}…</p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <button onClick={() => { setSelectedVersionId(v.id); setMode("mapper"); }} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700">Mở mapper</button>
                        <button onClick={() => verify(v.id)} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700"><ShieldCheck className="h-3.5 w-3.5" /> Verify</button>
                        {v.status === "DRAFT" && <button onClick={() => act(v.id, "publish")} className="rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white">Publish</button>}
                        {v.status === "DRAFT" && <button onClick={() => act(v.id, "archive")} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600">Archive</button>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}

      {mode === "mapper" && selectedVersion && (
        <div className="space-y-4">
          {mapperError && <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700">{mapperError}</div>}

          {/* Version banner */}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-slate-900">v{selectedVersion.version}</span>
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${statusCls[selectedVersion.status]}`}>{VERSION_STATUS_LABEL[selectedVersion.status]}</span>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => setMode("versions")} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600">‹ Versions</button>
              <button onClick={loadVersions} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600"><RefreshCw className="h-3.5 w-3.5" /> Làm mới</button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
            {/* Left: placeholder list */}
            <div className="space-y-3">
              <div className="rounded-xl border border-slate-200 bg-white p-3">
                <div className="mb-2 text-[11px] font-bold uppercase text-slate-500">Placeholders ({placeholders.length})</div>
                <div className="max-h-80 space-y-1 overflow-auto">
                  {placeholders.map((ph) => {
                    const count = positions.filter((p) => p.placeholder === ph).length;
                    const active = placingPlaceholder === ph;
                    return (
                      <button
                        key={ph}
                        disabled={readOnly}
                        onClick={() => setPlacingPlaceholder(active ? null : ph)}
                        className={`flex w-full items-center justify-between rounded-lg border px-2.5 py-1.5 text-left text-xs ${active ? "border-emerald-700 bg-emerald-50 text-emerald-800" : "border-transparent hover:bg-slate-50 text-slate-700"} disabled:opacity-40`}
                      >
                        <span className="truncate font-mono">{ph}</span>
                        {count > 0 && <span className="rounded bg-emerald-100 px-1.5 text-[10px] font-bold text-emerald-700">{count}</span>}
                      </button>
                    );
                  })}
                  {placeholders.length === 0 && <div className="p-3 text-center text-xs text-slate-400">Không có placeholder (template chưa scan mapping).</div>}
                </div>
              </div>

              {/* Properties panel */}
              {selectedPosition && (
                <PropertiesPanel
                  key={selectedPosition.id}
                  position={selectedPosition}
                  readOnly={readOnly}
                  onSave={(input) => patchPosition(selectedPosition.id, input)}
                />
              )}
              {selectedPosition && readOnly && (
                <button onClick={() => deletePosition(selectedPosition.id)} disabled className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-400">Không thể xoá (read-only)</button>
              )}
            </div>

            {/* Right: viewer */}
            <div className="min-w-0">
              <PdfViewer
                pdfUrl={`/api/document-merge/templates/${templateId}/pdf-versions/${selectedVersion.id}/blank-pdf`}
                pages={selectedVersion.pageLayout ?? []}
                positions={positions}
                selectedId={selectedPositionId}
                readOnly={readOnly}
                placingPlaceholder={placingPlaceholder}
                scale={scale}
                onScaleChange={setScale}
                pageNumber={pageNumber}
                onPageChange={setPageNumber}
                onSelect={(id) => setSelectedPositionId(id)}
                onPlace={handlePlace}
                onCommit={handleCommit}
              />
            </div>
          </div>

          {/* Position actions for selected */}
          {selectedPosition && !readOnly && (
            <div className="flex items-center justify-end gap-2">
              <button onClick={() => deletePosition(selectedPosition.id)} className="inline-flex items-center gap-1 rounded-lg border border-red-200 bg-white px-3 py-2 text-xs font-semibold text-red-600 hover:bg-red-50"><Trash2 className="h-3.5 w-3.5" /> Xoá position</button>
            </div>
          )}

          {/* Preview (non-production) */}
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-900">Preview (non-production)</h3>
              <span className="text-[10px] text-slate-400">Chỉ render với giá trị do bạn cung cấp — không tạo merge job, không dùng dữ liệu thật.</span>
            </div>
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1fr_auto]">
              <textarea
                value={previewValues}
                onChange={(e) => setPreviewValues(e.target.value)}
                rows={4}
                placeholder={'{"Ho_ten": "Nguyễn Văn An", "So_CCCD": "072201012345", ...} — để trống để render với giá trị rỗng.'}
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono text-xs outline-none focus:border-emerald-600"
              />
              <button onClick={renderPreview} disabled={previewLoading} className="h-fit rounded-lg bg-emerald-700 px-4 py-2 text-xs font-bold text-white hover:bg-emerald-800 disabled:opacity-50">
                {previewLoading ? "Đang render..." : "Render preview"}
              </button>
            </div>
            {previewError && <div className="mt-2 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">{previewError}</div>}
            {previewUrl && (
              <iframe title="PDF preview" src={previewUrl} className="mt-3 h-[600px] w-full rounded-lg border border-slate-200" />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function VersionUpload({ onCreate }: { onCreate: (file: File) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onFile = async (file: File | null) => {
    if (!file) return;
    setBusy(true);
    setErr(null);
    try {
      await onCreate(file);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Upload thất bại.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-dashed border-slate-300 bg-white p-4">
      <label className="flex cursor-pointer flex-col items-center justify-center gap-2 py-4 text-center">
        <Upload className="h-6 w-6 text-slate-400" />
        <span className="text-sm font-semibold text-slate-700">Upload blank PDF (tạo version DRAFT)</span>
        <span className="text-xs text-slate-400">PDF nền đã blanked (placeholder đã xoá) · tối đa 25 MB · không tự publish</span>
        <input
          type="file"
          accept="application/pdf"
          className="hidden"
          disabled={busy}
          onChange={(e) => onFile(e.target.files?.[0] ?? null)}
        />
      </label>
      {busy && <div className="text-center text-xs text-slate-500">Đang upload...</div>}
      {err && <div className="mt-2 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">{err}</div>}
    </div>
  );
}
