"use client";

/**
 * PDF Overlay Mapper — PDF viewer + position overlay (PR3).
 *
 * Render blank PDF bằng pdfjs-dist ra canvas (KHÔNG sửa bytes PDF client-side),
 * overlay các box position (drag/resize/click-to-place). Tọa độ luôn quy đổi về
 * PDF points (bottom-left) qua mapper-coordinates — source of truth ở DB.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";

import {
  cssBoxToPdf,
  dragBox,
  pdfBoxToCss,
  resizeBox,
  type ResizeHandle,
} from "@/lib/document-merge/pdf-overlay/mapper-coordinates";
import type { PageGeometry, PdfBox } from "@/lib/document-merge/pdf-overlay/types";
import type { PdfPosition } from "./mapper-types";

// Worker cho pdfjs (Next.js webpack trace + emit asset qua new URL).
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

const DEFAULT_BOX: PdfBox = { x: 50, y: 500, width: 140, height: 20 };
const RESIZE_HANDLES: ResizeHandle[] = ["nw", "ne", "sw", "se"];

interface PdfViewerProps {
  /** URL tải blank PDF bytes (endpoint blank-pdf). */
  pdfUrl: string | null;
  pages: PageGeometry[];
  positions: PdfPosition[];
  selectedId: string | null;
  readOnly: boolean;
  /** Khi set, click lên trang sẽ đặt box mới cho placeholder này. */
  placingPlaceholder: string | null;
  scale: number;
  onScaleChange: (scale: number) => void;
  pageNumber: number;
  onPageChange: (page: number) => void;
  onSelect: (positionId: string | null) => void;
  onPlace: (pageNumber: number, box: PdfBox) => void;
  onCommit: (position: PdfPosition, box: PdfBox) => void;
}

export function PdfViewer({
  pdfUrl,
  pages,
  positions,
  selectedId,
  readOnly,
  placingPlaceholder,
  scale,
  onScaleChange,
  pageNumber,
  onPageChange,
  onSelect,
  onPlace,
  onCommit,
}: PdfViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [pdfPage, setPdfPage] = useState<PDFPageProxy | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [overlayScale, setOverlayScale] = useState(1);

  // Drag/resize state (preview box chưa commit).
  const dragRef = useRef<{
    kind: "move" | "resize";
    positionId: string;
    startBox: PdfBox;
    startX: number;
    startY: number;
    handle?: ResizeHandle;
  } | null>(null);
  const [preview, setPreview] = useState<{ positionId: string; box: PdfBox } | null>(null);

  const page = pages.find((p) => p.pageNumber === pageNumber) ?? pages[0];

  // Load PDF bytes.
  useEffect(() => {
    let cancelled = false;
    setPdfDoc(null);
    setPdfPage(null);
    setRenderError(null);
    if (!pdfUrl) return;

    (async () => {
      setLoading(true);
      try {
        const res = await fetch(pdfUrl, { cache: "no-store" });
        if (!res.ok) throw new Error(`Tải blank PDF thất bại (${res.status}).`);
        const data = new Uint8Array(await res.arrayBuffer());
        const doc = await pdfjs.getDocument({ data }).promise;
        if (cancelled) return;
        setPdfDoc(doc);
      } catch (err) {
        if (!cancelled) setRenderError(err instanceof Error ? err.message : "Không tải được PDF.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [pdfUrl]);

  // Load page.
  useEffect(() => {
    let cancelled = false;
    if (!pdfDoc) return;
    (async () => {
      try {
        const p = await pdfDoc.getPage(pageNumber);
        if (!cancelled) setPdfPage(p);
      } catch (err) {
        if (!cancelled) setRenderError(err instanceof Error ? err.message : "Không mở được trang PDF.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pdfDoc, pageNumber]);

  // Render page to canvas.
  useEffect(() => {
    if (!pdfPage || !canvasRef.current || !page) return;
    let cancelled = false;
    (async () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
      const viewport = pdfPage.getViewport({ scale: scale * dpr });
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.style.width = `${viewport.width / dpr}px`;
      canvas.style.height = `${viewport.height / dpr}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      await pdfPage.render({ canvas, canvasContext: ctx, viewport }).promise;
      if (!cancelled) setOverlayScale(viewport.width / dpr / page.width);
    })();
    return () => {
      cancelled = true;
    };
  }, [pdfPage, scale, page]);

  const pagePositions = useMemo(
    () => positions.filter((p) => p.pageNumber === pageNumber),
    [positions, pageNumber],
  );

  const toCss = useCallback(
    (box: PdfBox): { left: number; top: number; width: number; height: number } => {
      if (!page) return { left: 0, top: 0, width: 0, height: 0 };
      const css = pdfBoxToCss(box, page, overlayScale || 1);
      return { left: css.x, top: css.y, width: css.width, height: css.height };
    },
    [page, overlayScale],
  );

  const boxForPosition = (pos: PdfPosition): PdfBox => {
    if (preview && preview.positionId === pos.id) return preview.box;
    return { x: pos.x, y: pos.y, width: pos.width, height: pos.height };
  };

  // Pointer handlers (drag/resize/place) — dùng window để bắt cả khi chuột ra ngoài.
  const beginMove = (e: React.PointerEvent, pos: PdfPosition) => {
    if (readOnly) return;
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = {
      kind: "move",
      positionId: pos.id,
      startBox: { x: pos.x, y: pos.y, width: pos.width, height: pos.height },
      startX: e.clientX,
      startY: e.clientY,
    };
    setPreview({ positionId: pos.id, box: { x: pos.x, y: pos.y, width: pos.width, height: pos.height } });
  };

  const beginResize = (e: React.PointerEvent, pos: PdfPosition, handle: ResizeHandle) => {
    if (readOnly) return;
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = {
      kind: "resize",
      positionId: pos.id,
      startBox: { x: pos.x, y: pos.y, width: pos.width, height: pos.height },
      startX: e.clientX,
      startY: e.clientY,
      handle,
    };
    setPreview({ positionId: pos.id, box: { x: pos.x, y: pos.y, width: pos.width, height: pos.height } });
  };

  useEffect(() => {
    if (!dragRef.current) return;
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || !page) return;
      const dxCss = e.clientX - drag.startX;
      const dyCss = e.clientY - drag.startY;
      const box =
        drag.kind === "move"
          ? dragBox(drag.startBox, page, overlayScale || 1, dxCss, dyCss)
          : resizeBox(drag.startBox, page, overlayScale || 1, drag.handle ?? "se", dxCss, dyCss);
      setPreview({ positionId: drag.positionId, box });
    };
    const onUp = () => {
      const drag = dragRef.current;
      if (drag) {
        const pos = positions.find((p) => p.id === drag.positionId);
        if (pos && preview && preview.positionId === drag.positionId) {
          onCommit(pos, preview.box);
        }
      }
      dragRef.current = null;
      setPreview(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [overlayScale, page, positions, preview, onCommit]);

  const handleCanvasClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (readOnly || !placingPlaceholder || !page || !overlayRef.current) return;
    const rect = overlayRef.current.getBoundingClientRect();
    const cssX = e.clientX - rect.left;
    const cssY = e.clientY - rect.top;
    const box = cssBoxToPdf(
      { x: cssX - DEFAULT_BOX.width * overlayScale / 2, y: cssY - DEFAULT_BOX.height * overlayScale / 2, width: DEFAULT_BOX.width * overlayScale, height: DEFAULT_BOX.height * overlayScale },
      page,
      overlayScale || 1,
    );
    onPlace(pageNumber, box);
  };

  if (!page) {
    return <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">Không có dữ liệu trang.</div>;
  }

  return (
    <div className="space-y-3">
      {/* Toolbar: page nav + zoom */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-2">
        <div className="flex items-center gap-2">
          <button onClick={() => onPageChange(Math.max(1, pageNumber - 1))} disabled={pageNumber <= 1} className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-600 disabled:opacity-40">‹ Trang trước</button>
          <span className="text-xs font-semibold text-slate-700">Trang {pageNumber}/{pages.length}</span>
          <button onClick={() => onPageChange(Math.min(pages.length, pageNumber + 1))} disabled={pageNumber >= pages.length} className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-600 disabled:opacity-40">Trang sau ›</button>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => onScaleChange(Math.max(0.5, scale - 0.25))} className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-bold text-slate-600">−</button>
          <span className="w-14 text-center text-xs font-semibold text-slate-700">{Math.round(scale * 100)}%</span>
          <button onClick={() => onScaleChange(Math.min(3, scale + 0.25))} className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-bold text-slate-600">+</button>
        </div>
      </div>

      {renderError && <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-xs text-red-700">{renderError}</div>}
      {loading && <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500">Đang tải PDF...</div>}

      {/* Canvas + overlay */}
      <div className="overflow-auto rounded-xl border border-slate-300 bg-slate-100 p-4">
        <div className="relative inline-block shadow-lg" ref={overlayRef} onClick={handleCanvasClick} style={{ cursor: placingPlaceholder && !readOnly ? "crosshair" : "default" }}>
          <canvas ref={canvasRef} className="block" />
          {/* Overlay boxes */}
          <div className="pointer-events-none absolute inset-0">
            {pagePositions.map((pos) => {
              const css = toCss(boxForPosition(pos));
              const selected = pos.id === selectedId;
              return (
                <div
                  key={pos.id}
                  className="pointer-events-auto absolute border"
                  style={{
                    left: css.left,
                    top: css.top,
                    width: css.width,
                    height: css.height,
                    borderColor: selected ? "#059669" : "#0f766e",
                    backgroundColor: selected ? "rgba(5,150,105,0.14)" : "rgba(15,118,110,0.08)",
                  }}
                  onPointerDown={(e) => {
                    if (!readOnly) beginMove(e, pos);
                    onSelect(pos.id);
                  }}
                >
                  <span className="absolute -top-4 left-0 whitespace-nowrap rounded bg-emerald-700 px-1 py-0.5 text-[10px] font-bold text-white">
                    {pos.placeholder}
                  </span>
                  {!readOnly && (
                    <>
                      {RESIZE_HANDLES.map((h) => (
                        <span
                          key={h}
                          onPointerDown={(e) => beginResize(e, pos, h)}
                          className="absolute h-3 w-3 rounded-sm border border-emerald-800 bg-white"
                          style={{
                            left: h[1] === "w" ? -6 : undefined,
                            right: h[1] === "e" ? -6 : undefined,
                            top: h[0] === "n" ? -6 : undefined,
                            bottom: h[0] === "s" ? -6 : undefined,
                            cursor: `${h[0]}-${h[1]}-resize`,
                          }}
                        />
                      ))}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <p className="text-xs text-slate-500">
        {readOnly
          ? "Version PUBLISHED/ARCHIVED — chỉ xem, không sửa được."
          : placingPlaceholder
            ? `Đang đặt box cho «${placingPlaceholder}» — click lên trang để đặt.`
            : "Chọn placeholder rồi click trang để đặt box; kéo box để di chuyển, kéo góc để đổi kích thước."}
      </p>
    </div>
  );
}
