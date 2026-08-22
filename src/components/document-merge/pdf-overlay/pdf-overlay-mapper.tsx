"use client";
/**
 * PDF Overlay — Visual Mapper (PR3, CONFIGURATION UI ONLY).
 * Workflow: Template → PDF Overlay → PDF Versions → select DRAFT → Visual Mapper
 * → Validate → Save → Publish.
 *
 * - Tải positions (PR2 GET) + fields (mapping active) + blank PDF bytes.
 * - Drag/drop placeholder lên trang; drag/resize box; chỉnh số chính xác.
 * - Dirty-state detection; Save = bulk upsert (PUT positions) + DELETE cho position
 *   bị xoá; nếu save fail → giữ dirty, không mất dữ liệu.
 * - Validate trước publish (validation-summary, THUẦN). Publish CHỈ qua PR2
 *   lifecycle API (POST publish). PUBLISHED/ARCHIVED = read-only.
 * - Preview an toàn (in-memory sample values) — không gọi Production merge.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Eye,
  Loader2,
  Maximize2,
  Minus,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
} from "lucide-react";
import { PdfViewer } from "./pdf-viewer";
import { PlaceholderPanel, type PlaceholderField } from "./placeholder-panel";
import { PositionEditor } from "./position-editor";
import { ValidationPanel } from "./validation-panel";
import { PreviewPanel } from "./preview-panel";
import {
  dbRowToEditor,
  editorToPayload,
  isDirty,
  type EditorPosition,
} from "@/lib/document-merge/pdf-overlay/mapper/serialization";
import { buildValidationSummary, type ValidationSummary } from "@/lib/document-merge/pdf-overlay/mapper/validation-summary";
import type { PdfVersion } from "./pdf-version-manager";

interface PdfOverlayMapperProps {
  templateId: string;
  version: PdfVersion;
  onBack: () => void;
  onPublished: () => void;
}

export function PdfOverlayMapper({ templateId, version, onBack, onPublished }: PdfOverlayMapperProps) {
  const readOnly = version.status !== "DRAFT";

  const [positions, setPositions] = useState<EditorPosition[]>([]);
  const [baseline, setBaseline] = useState<EditorPosition[]>([]);
  const [fields, setFields] = useState<PlaceholderField[]>([]);
  const [pdfBytes, setPdfBytes] = useState<ArrayBuffer | null>(null);

  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [fit, setFit] = useState(true);
  const [zoomPct, setZoomPct] = useState(100);
  const [scale, setScale] = useState(1);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  const [summary, setSummary] = useState<ValidationSummary | null>(null);
  const dirty = isDirty(positions, baseline);

  // refs chứa state mới nhất — cập nhật TRONG EFFECT (không ghi ref lúc render).
  const latestRef = useRef({ dirty, positions, baseline });
  const warnRef = useRef<() => boolean>(() => true);
  useEffect(() => {
    latestRef.current = { dirty, positions, baseline };
    warnRef.current = () => {
      if (latestRef.current.dirty) {
        return window.confirm("Bạn có thay đổi chưa lưu. Rời khỏi sẽ mất thay đổi — Tiếp tục?");
      }
      return true;
    };
  });

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [posRes, fieldRes, pdfRes] = await Promise.all([
        fetch(`/api/document-merge/templates/${templateId}/pdf-versions/${version.id}/positions`, { cache: "no-store" }),
        fetch(`/api/document-merge/templates/${templateId}/fields`, { cache: "no-store" }),
        fetch(`/api/document-merge/templates/${templateId}/pdf-versions/${version.id}/blank-pdf`, { cache: "no-store" }),
      ]);
      if (!posRes.ok) {
        const d = await posRes.json().catch(() => ({}));
        throw new Error(d.error || "Không tải được positions.");
      }
      const posData = await posRes.json();
      const fieldData = fieldRes.ok ? await fieldRes.json() : [];
      if (!pdfRes.ok) throw new Error("Không tải được blank PDF.");
      const pdfBuf = await pdfRes.arrayBuffer();

      const editor = (Array.isArray(posData) ? posData : []).map((r: any) => dbRowToEditor(r));
      setPositions(editor);
      setBaseline(editor.map((e: EditorPosition) => ({ ...e })));
      setFields(Array.isArray(fieldData) ? fieldData : []);
      setPdfBytes(pdfBuf);
      if (editor.length > 0) setSelectedClientId(editor[0].clientId);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Không tải được dữ liệu mapper.");
    } finally {
      setLoading(false);
    }
  }, [templateId, version.id]);

  useEffect(() => {
    load();
  }, [load]);

  const pageCount = version.pageLayout.length;

  // unsaved-changes guard on unload
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (latestRef.current.dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  const handleBack = () => {
    if (!warnRef.current()) return;
    onBack();
  };

  const updatePosition = useCallback((clientId: string, patch: Partial<EditorPosition>) => {
    setPositions((ps) => ps.map((p) => (p.clientId === clientId ? { ...p, ...patch } : p)));
  }, []);

  const addPosition = useCallback((pos: EditorPosition) => {
    setPositions((ps) => [...ps, pos]);
  }, []);

  const geometryChange = useCallback((clientId: string, box: { x: number; y: number; width: number; height: number }) => {
    setPositions((ps) => ps.map((p) => (p.clientId === clientId ? { ...p, ...box } : p)));
  }, []);

  const duplicatePosition = useCallback((clientId: string) => {
    setPositions((ps) => {
      const src = ps.find((p) => p.clientId === clientId);
      if (!src) return ps;
      const copy: EditorPosition = { ...src, clientId: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}`, dbId: undefined, x: src.x + 10, y: src.y + 10 };
      const idx = ps.indexOf(src);
      const next = [...ps];
      next.splice(idx + 1, 0, copy);
      return next;
    });
  }, []);

  const deletePosition = useCallback((clientId: string) => {
    setPositions((ps) => ps.filter((p) => p.clientId !== clientId));
    setSelectedClientId((s) => (s === clientId ? null : s));
  }, []);

  const selected = positions.find((p) => p.clientId === selectedClientId) ?? null;

  const save = async (): Promise<boolean> => {
    setSaving(true);
    setSaveError(null);
    try {
      const currentDbIds = new Set(positions.map((p) => p.dbId).filter((x): x is string => Boolean(x)));
      const toDelete = baseline.filter((b) => b.dbId && !currentDbIds.has(b.dbId));
      for (const d of toDelete) {
        const res = await fetch(
          `/api/document-merge/templates/${templateId}/pdf-versions/${version.id}/positions/${d.dbId}`,
          { method: "DELETE" },
        );
        if (!res.ok && res.status !== 404) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `Không xoá được position ${d.dbId}.`);
        }
      }

      const payloads = positions.map(editorToPayload);
      const res = await fetch(
        `/api/document-merge/templates/${templateId}/pdf-versions/${version.id}/positions`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ positions: payloads }),
        },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Lưu vị trí thất bại.");

      const returned = (Array.isArray(data) ? data : []).map((r: any) => dbRowToEditor(r));
      const prevSelected = selected?.placeholder;
      setPositions(returned);
      setBaseline(returned.map((e) => ({ ...e })));
      if (prevSelected) {
        const match = returned.find((r) => r.placeholder === prevSelected);
        if (match) setSelectedClientId(match.clientId);
      }
      setSavedAt(new Date());
      return true;
    } catch (err) {
      // FAILED SAVE → giữ dirty (không đổi baseline)
      setSaveError(err instanceof Error ? err.message : "Lưu thất bại.");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const runValidation = () => {
    setSummary(buildValidationSummary(positions, version.pageLayout, fields));
  };

  const publish = async () => {
    if (dirty) {
      const ok = window.confirm("Có thay đổi chưa lưu. Lưu trước khi publish?");
      if (!ok) return;
      const saved = await save();
      if (!saved) return; // save fail → không publish
    }
    if (!window.confirm("Publish version này? (PDF Overlay vẫn CHƯA kích hoạt cho merge production)")) return;
    setPublishing(true);
    setSaveError(null);
    try {
      const res = await fetch(
        `/api/document-merge/templates/${templateId}/pdf-versions/${version.id}/publish`,
        { method: "POST" },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Publish thất bại.");
      onPublished();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Publish thất bại.");
    } finally {
      setPublishing(false);
    }
  };

  const noteRef = useRef<HTMLDivElement | null>(null);

  if (loading) {
    return <div className="rounded-xl border border-slate-200 bg-white p-12 text-center text-sm text-slate-500">Đang tải Visual Mapper...</div>;
  }
  if (loadError) {
    return <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-sm text-red-700">{loadError}</div>;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button onClick={handleBack} className="rounded-lg border border-slate-200 p-2 text-slate-500 hover:bg-slate-50" title="Quay lại PDF Versions">
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div>
            <div className="text-base font-bold text-slate-900">Visual Mapper — Version {version.version}</div>
            <div className="text-xs text-slate-500">
              Trạng thái <span className="font-semibold">{version.status}</span> · {pageCount} trang · Tạo bởi {version.createdBy}
              {readOnly && <span className="ml-2 font-semibold text-amber-600">READ-ONLY</span>}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {!readOnly && (
            <button onClick={() => setPreviewOpen(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">
              <Eye className="h-3.5 w-3.5" /> Preview (sample)
            </button>
          )}
          {!readOnly && (
            <button onClick={runValidation} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">
              <ShieldCheck className="h-3.5 w-3.5" /> Validate
            </button>
          )}
          {!readOnly && (
            <button onClick={save} disabled={saving || !dirty} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-40">
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              {dirty ? "Lưu thay đổi" : "Đã lưu"}
            </button>
          )}
          {!readOnly && (
            <button onClick={publish} disabled={publishing} className="inline-flex items-center gap-1.5 rounded-lg bg-slate-800 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-900 disabled:opacity-40">
              {publishing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />} Publish
            </button>
          )}
        </div>
      </div>

      {saveError && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">{saveError}</div>}
      {savedAt && !dirty && <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-2 text-[11px] text-emerald-700">✓ Đã lưu lúc {savedAt.toLocaleTimeString("vi-VN")}.</div>}
      {dirty && !readOnly && (
        <div ref={noteRef} className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-[11px] font-semibold text-amber-700">⚠ Có thay đổi chưa lưu.</div>
      )}

      <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
        <div className="flex items-center gap-1.5">
          <button onClick={() => setCurrentPage((p) => Math.max(1, p - 1))} className="rounded-md border border-slate-200 p-1 text-slate-500 hover:bg-slate-50">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="text-xs font-semibold text-slate-700">Trang {currentPage} / {pageCount}</span>
          <button onClick={() => setCurrentPage((p) => Math.min(pageCount, p + 1))} className="rounded-md border border-slate-200 p-1 text-slate-500 hover:bg-slate-50">
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
        <div className="flex items-center gap-1.5">
          <button onClick={() => setFit(true)} className={`rounded-md border px-2 py-1 text-[11px] font-semibold ${fit ? "border-emerald-500 bg-emerald-50 text-emerald-700" : "border-slate-200 text-slate-500"}`}>
            <Maximize2 className="mr-1 inline h-3 w-3" />Fit
          </button>
          <button onClick={() => { setFit(false); setZoomPct((z) => Math.max(50, z - 25)); }} className="rounded-md border border-slate-200 p-1 text-slate-500 hover:bg-slate-50">
            <Minus className="h-3.5 w-3.5" />
          </button>
          <span className="w-12 text-center text-[11px] font-semibold text-slate-600">{fit ? "fit" : `${zoomPct}%`}</span>
          <button onClick={() => { setFit(false); setZoomPct((z) => Math.min(300, z + 25)); }} className="rounded-md border border-slate-200 p-1 text-slate-500 hover:bg-slate-50">
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[240px_1fr_300px]">
        {/* Placeholder panel */}
        <div className="h-[70vh] rounded-xl border border-slate-200 bg-white p-3">
          <PlaceholderPanel fields={fields} positions={positions} currentPage={currentPage} onAdd={addPosition} />
        </div>

        {/* PDF viewer */}
        <div className="overflow-auto rounded-xl border border-slate-200 bg-slate-100 p-3">
          <PdfViewer
            pdfBytes={pdfBytes}
            pageLayout={version.pageLayout}
            currentPage={currentPage}
            fitWidth={fit}
            zoomPct={zoomPct}
            onScale={setScale}
            positions={positions}
            selectedClientId={selectedClientId}
            onSelect={setSelectedClientId}
            onGeometryChange={geometryChange}
            onAddPosition={addPosition}
            readOnly={readOnly}
          />
        </div>

        {/* Editor + validation */}
        <div className="h-[70vh] overflow-y-auto rounded-xl border border-slate-200 bg-white p-3">
          <PositionEditor
            pos={selected}
            pageCount={pageCount}
            readOnly={readOnly}
            onUpdate={updatePosition}
            onDuplicate={duplicatePosition}
            onDelete={deletePosition}
          />
          <div className="my-3 border-t border-slate-100" />
          <div className="mb-1 text-xs font-bold text-slate-800">Validation</div>
          <button onClick={runValidation} className="mb-2 inline-flex items-center gap-1 rounded-md border border-slate-200 px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50">
            <RefreshCw className="h-3 w-3" /> Chạy validation
          </button>
          <ValidationPanel summary={summary} />
        </div>
      </div>

      {previewOpen && !readOnly && (
        <PreviewPanel pdfBytes={pdfBytes} positions={positions} pageLayout={version.pageLayout} onClose={() => setPreviewOpen(false)} />
      )}
    </div>
  );
}
