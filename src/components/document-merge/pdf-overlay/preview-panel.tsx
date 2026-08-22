"use client";
/**
 * PDF Overlay — Preview mode (PR3, SAFE).
 * Preview layout với SAMPLE VALUES trong-memory (tiếng Việt, ngày, địa chỉ dài,
 * checkbox, multiline) — KHÔNG đọc Production candidate, KHÔNG tạo merge job,
 * KHÔNG mutate Production. Kết quả chỉ hiển thị ở browser.
 *
 * Cơ chế: blank PDF bytes + font → renderPreviewPdf (pdf-lib, in-memory) → hiển
 * thị qua PdfViewer (readOnly). Admin có thể chỉnh value mẫu (cũng in-memory).
 */

import { useCallback, useEffect, useState } from "react";
import { Maximize2, Minus, Plus, X } from "lucide-react";
import { PdfViewer } from "./pdf-viewer";
import { renderPreviewPdf } from "./preview-render";
import { buildSampleValueSet } from "@/lib/document-merge/pdf-overlay/mapper/sample-values";
import type { PageLayoutEntry } from "@/lib/document-merge/pdf-overlay/mapper/validation-summary";
import type { EditorPosition } from "@/lib/document-merge/pdf-overlay/mapper/serialization";

interface PreviewPanelProps {
  pdfBytes: ArrayBuffer | null;
  positions: EditorPosition[];
  pageLayout: PageLayoutEntry[];
  onClose: () => void;
}

export function PreviewPanel({ pdfBytes, positions, pageLayout, onClose }: PreviewPanelProps) {
  const [fontBytes, setFontBytes] = useState<ArrayBuffer | null>(null);
  const [previewBytes, setPreviewBytes] = useState<ArrayBuffer | null>(null);
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [currentPage, setCurrentPage] = useState(1);
  const [zoomPct, setZoomPct] = useState(100);
  const [fit, setFit] = useState(true);
  const [status, setStatus] = useState<string | null>("Đang tải...");

  // load font
  useEffect(() => {
    let cancelled = false;
    fetch("/api/document-merge/pdf-overlay/font", { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error("Không tải được font preview.");
        return r.arrayBuffer();
      })
      .then((buf) => {
        if (!cancelled) setFontBytes(buf);
      })
      .catch((err) => {
        if (!cancelled) setStatus(err instanceof Error ? err.message : "Lỗi tải font.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // build preview pdf when font ready
  useEffect(() => {
    let cancelled = false;
    if (!pdfBytes || !fontBytes) return;
    setStatus("Đang render preview...");
    const sample = buildSampleValueSet(overrides).values;
    renderPreviewPdf(pdfBytes, positions, sample, fontBytes).then((res) => {
      if (cancelled) return;
      if (res.error) {
        setStatus("Lỗi: " + res.error);
      } else {
        const ab = res.bytes.buffer as ArrayBuffer;
        setPreviewBytes(ab.slice(res.bytes.byteOffset, res.bytes.byteOffset + res.bytes.byteLength));
        setStatus(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [pdfBytes, fontBytes, positions, overrides]);

  const pageCount = pageLayout.length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4" onMouseDown={onClose}>
      <div
        className="flex h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div>
            <div className="text-sm font-bold text-slate-800">Preview layout (sample data — in-memory)</div>
            <div className="text-[11px] text-emerald-600">Tiếng Việt · ngày · địa chỉ dài · checkbox · multiline — không ghi Production</div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-slate-400">Trang {currentPage}/{pageCount}</span>
            <button onClick={() => setFit(!fit)} className="rounded-md border border-slate-200 p-1.5 text-slate-500 hover:bg-slate-100" title="Fit width">
              <Maximize2 className="h-3.5 w-3.5" />
            </button>
            <button onClick={() => setZoomPct((z) => Math.max(50, z - 25))} className="rounded-md border border-slate-200 p-1.5 text-slate-500 hover:bg-slate-100">
              <Minus className="h-3.5 w-3.5" />
            </button>
            <span className="w-12 text-center text-[11px] font-semibold text-slate-600">{fit ? "fit" : `${zoomPct}%`}</span>
            <button onClick={() => setZoomPct((z) => Math.min(300, z + 25))} className="rounded-md border border-slate-200 p-1.5 text-slate-500 hover:bg-slate-100">
              <Plus className="h-3.5 w-3.5" />
            </button>
            <button onClick={onClose} className="rounded-md border border-slate-200 p-1.5 text-slate-500 hover:bg-slate-100">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        <div className="flex flex-1 overflow-hidden">
          <div className="flex-1 overflow-auto bg-slate-100 p-3">
            {status ? (
              <div className="flex h-full items-center justify-center text-xs text-slate-500">{status}</div>
            ) : (
              <PdfViewer
                pdfBytes={previewBytes}
                pageLayout={pageLayout}
                currentPage={currentPage}
                fitWidth={fit}
                zoomPct={zoomPct}
                positions={positions}
                selectedClientId={null}
                onSelect={() => {}}
                onGeometryChange={() => {}}
                onAddPosition={() => {}}
                readOnly
              />
            )}
          </div>

          <div className="w-64 overflow-y-auto border-l border-slate-200 p-3">
            <div className="mb-2 text-xs font-bold text-slate-700">Value mẫu (chỉnh trong-memory)</div>
            <div className="space-y-2">
              {Object.entries(buildSampleValueSet().values)
                .filter(([k]) => positions.some((p) => p.placeholder === k))
                .map(([k]) => (
                  <label key={k} className="block">
                    <span className="text-[10px] font-semibold text-slate-500">{k}</span>
                    <input
                      value={overrides[k] ?? buildSampleValueSet().values[k]}
                      onChange={(e) => setOverrides((o) => ({ ...o, [k]: e.target.value }))}
                      className="w-full rounded-md border border-slate-200 px-2 py-1 text-xs outline-none focus:border-emerald-600"
                    />
                  </label>
                ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
