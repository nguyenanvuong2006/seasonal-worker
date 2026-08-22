"use client";
/**
 * PDF Overlay — Visual PDF Viewer + overlay boxes (PR3).
 *
 * - Render trang PDF thật (pdf.js canvas) + SVG/div overlay chứa field boxes.
 * - Multi-page (điều hướng page từ parent), zoom in/out, fit width.
 * - Giữ đúng aspect ratio trang; chuyển đổi pixel ↔ PDF pt qua coordinates.ts
 *   (gốc bottom-left — PR1). Mọi drag/resize đều làm việc trong không gian
 *   CSS pixel rồi convert VỀ pt trước khi gửi lên (không lưu pixel).
 * - Không chỉnh sửa PDF trong trình duyệt (chỉ vẽ overlay).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { getPdfJs } from "./pdfjs";
import {
  pdfBoxToPixelBox,
  pixelBoxToPdfBox,
  pixelToPdfPoint,
  scaleToFitWidth,
  pageDisplaySize,
  type PageDimPt,
} from "@/lib/document-merge/pdf-overlay/mapper/coordinates";
import { makeNewPosition } from "@/lib/document-merge/pdf-overlay/mapper/serialization";
import type { PageLayoutEntry } from "@/lib/document-merge/pdf-overlay/mapper/validation-summary";
import type { EditorPosition } from "@/lib/document-merge/pdf-overlay/mapper/serialization";

export type ResizeHandle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

interface PdfViewerProps {
  pdfBytes: ArrayBuffer | null;
  pageLayout: PageLayoutEntry[];
  currentPage: number;
  fitWidth: boolean;
  zoomPct: number;
  onScale?: (scale: number) => void;
  positions: EditorPosition[];
  selectedClientId: string | null;
  onSelect: (clientId: string) => void;
  onGeometryChange: (clientId: string, box: { x: number; y: number; width: number; height: number }) => void;
  onAddPosition: (pos: EditorPosition) => void;
  readOnly: boolean;
  /** preview: hiển thị value mẫu trong box (in-memory, không mutate). */
  previewValues?: Record<string, string> | null;
}

function toPageDim(entry?: PageLayoutEntry): PageDimPt {
  return {
    width: entry?.width ?? 595.28,
    height: entry?.height ?? 841.89,
    rotation: (entry?.rotation as PageDimPt["rotation"]) ?? 0,
  };
}

export function PdfViewer({
  pdfBytes,
  pageLayout,
  currentPage,
  fitWidth,
  zoomPct,
  onScale,
  positions,
  selectedClientId,
  onSelect,
  onGeometryChange,
  onAddPosition,
  readOnly,
  previewValues,
}: PdfViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [pageCanvas, setPageCanvas] = useState<{ page: import("pdfjs-dist").PDFPageProxy; pageNum: number } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const page = pageLayout.find((p) => p.pageNumber === currentPage);
  const pageDim = toPageDim(page);

  // scale (fit width hoặc zoom theo % của fit)
  const fitScale = scaleToFitWidth(pageDim, Math.max(containerWidth - 16, 1));
  const effectiveScale = fitWidth ? fitScale : fitScale * (zoomPct / 100);
  const display = pageDisplaySize(pageDim, effectiveScale);

  // đo container width (fit width)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setContainerWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // load pdf document (chỉ client)
  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    setPageCanvas(null);
    if (!pdfBytes) return;
    (async () => {
      try {
        const pdfjs = await getPdfJs();
        const doc = await pdfjs.getDocument({ data: new Uint8Array(pdfBytes) }).promise;
        if (cancelled) return;
        const p = await doc.getPage(currentPage);
        if (cancelled) return;
        setPageCanvas({ page: p, pageNum: currentPage });
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "Không đọc được PDF.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pdfBytes, currentPage]);

  // render canvas (độ phân giải dpr cho nét, CSS scale = scale)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !pageCanvas || pageCanvas.pageNum !== currentPage) return;
    const dpr = Math.min(typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1, 2);
    const renderScale = effectiveScale * dpr;
    const viewport = pageCanvas.page.getViewport({ scale: renderScale });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = `${viewport.width / dpr}px`;
    canvas.style.height = `${viewport.height / dpr}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    pageCanvas.page.render({ canvasContext: ctx, viewport } as any).promise.catch(() => {
      /* render thất bại — không crash UI */
    });
  }, [pageCanvas, currentPage, effectiveScale]);

  useEffect(() => {
    if (onScale && effectiveScale > 0) onScale(effectiveScale);
  }, [effectiveScale, onScale]);

  // drag/resize state
  const dragRef = useRef<{
    kind: "move" | ResizeHandle;
    startClientX: number;
    startClientY: number;
    startCss: { left: number; top: number; width: number; height: number };
    clientId: string;
  } | null>(null);

  const pagePositions = positions.filter((p) => p.pageNumber === currentPage);

  const cssRectFor = (pos: EditorPosition) => pdfBoxToPixelBox(pos, pageDim, effectiveScale);

  const beginPointer = useCallback(
    (clientId: string, kind: "move" | ResizeHandle) => (e: React.PointerEvent) => {
      if (readOnly) return;
      const pos = pagePositions.find((p) => p.clientId === clientId);
      if (!pos) return;
      e.preventDefault();
      e.stopPropagation();
      const startCss = cssRectFor(pos);
      dragRef.current = {
        kind,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startCss,
        clientId,
      };
      onSelect(clientId);
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [readOnly, pagePositions, effectiveScale, pageDim, onSelect],
  );

  const applyCssRect = useCallback(
    (clientId: string, rect: { left: number; top: number; width: number; height: number }) => {
      const box = pixelBoxToPdfBox(rect, pageDim, effectiveScale);
      onGeometryChange(clientId, {
        x: Math.round(box.x * 1000) / 1000,
        y: Math.round(box.y * 1000) / 1000,
        width: Math.max(Math.round(box.width * 1000) / 1000, 0.5),
        height: Math.max(Math.round(box.height * 1000) / 1000, 0.5),
      });
    },
    [pageDim, effectiveScale, onGeometryChange],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      e.preventDefault();
      const dx = e.clientX - d.startClientX;
      const dy = e.clientY - d.startClientY;
      const s = d.startCss;
      let rect = { ...s };
      if (d.kind === "move") {
        rect = { left: s.left + dx, top: s.top + dy, width: s.width, height: s.height };
      } else {
        if (d.kind.includes("e")) rect.width = s.width + dx;
        if (d.kind.includes("s")) rect.height = s.height + dy;
        if (d.kind.includes("w")) {
          rect.left = s.left + dx;
          rect.width = s.width - dx;
        }
        if (d.kind.includes("n")) {
          rect.top = s.top + dy;
          rect.height = s.height - dy;
        }
      }
      applyCssRect(d.clientId, rect);
    },
    [applyCssRect],
  );

  const endPointer = useCallback(() => {
    dragRef.current = null;
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      if (readOnly) return;
      e.preventDefault();
      const placeholder = e.dataTransfer.getData("text/plain");
      if (!placeholder) return;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const cssX = e.clientX - rect.left;
      const cssY = e.clientY - rect.top;
      const pt = pixelToPdfPoint({ x: cssX, y: cssY }, pageDim, effectiveScale);
      const newPos = makeNewPosition(placeholder, currentPage, { type: "TEXT" });
      newPos.x = Math.round(pt.x * 1000) / 1000;
      newPos.y = Math.round(pt.y * 1000) / 1000;
      onAddPosition(newPos);
      onSelect(newPos.clientId);
    },
    [readOnly, pageDim, effectiveScale, currentPage, onAddPosition, onSelect],
  );

  const previewTextFor = (pos: EditorPosition): string => {
    if (pos.type === "STATIC_TEXT") return pos.staticText ?? "";
    if (previewValues) return previewValues[pos.placeholder] ?? "";
    return "";
  };

  return (
    <div ref={containerRef} className="w-full">
      {loadError && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-xs text-red-700">{loadError}</div>
      )}
      <div
        className="relative mx-auto overflow-hidden rounded-lg border border-slate-300 bg-white shadow-sm"
        style={{ width: display.width, height: display.height }}
        onDragOver={(e) => !readOnly && e.preventDefault()}
        onDrop={onDrop}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerLeave={endPointer}
      >
        <canvas ref={canvasRef} className="absolute left-0 top-0 block" />

        {/* overlay boxes */}
        {pagePositions.map((pos) => {
          const css = pdfBoxToPixelBox(pos, pageDim, effectiveScale);
          const selected = pos.clientId === selectedClientId;
          const isCheckbox = pos.type === "CHECKBOX" || pos.type === "RADIO_OPTION";
          const boxStyle = boxBorderStyle(pos.type);
          return (
            <div
              key={pos.clientId}
              onPointerDown={beginPointer(pos.clientId, "move")}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(pos.clientId);
              }}
              className="absolute select-none cursor-move"
              style={{
                left: css.left,
                top: css.top,
                width: css.width,
                height: css.height,
                border: selected ? `2px solid ${boxStyle.selectedBorder}` : `1.5px solid ${boxStyle.border}`,
                background: selected ? boxStyle.selectedBg : boxStyle.bg,
                boxSizing: "border-box",
              }}
            >
              {/* label */}
              <div
                className={`pointer-events-none absolute left-0 top-0 max-w-full truncate whitespace-nowrap px-0.5 text-[9px] font-bold leading-tight ${selected ? "text-white" : "text-slate-700"}`}
                style={{ background: selected ? boxStyle.selectedBorder : "rgba(255,255,255,0.85)", color: selected ? "#fff" : boxStyle.border }}
                title={pos.placeholder}
              >
                {boxStyle.label} {pos.placeholder}
                {pos.isRequired && <span className="ml-0.5">*</span>}
              </div>

              {/* preview value */}
              {!readOnly && !isCheckbox && previewTextFor(pos) && (
                <div
                  className="pointer-events-none absolute inset-0 px-0.5 text-[9px] leading-tight text-slate-500"
                  style={{ overflow: "hidden", whiteSpace: pos.multiline ? "normal" : "nowrap" }}
                >
                  {previewTextFor(pos)}
                </div>
              )}

              {/* resize handles (selected + editable) */}
              {selected && !readOnly && (
                <>
                  {(["nw", "ne", "sw", "se"] as const).map((h) => (
                    <div
                      key={h}
                      onPointerDown={beginPointer(pos.clientId, h)}
                      className="absolute z-10 h-2.5 w-2.5 cursor-nwse-resize rounded-full border border-white bg-emerald-600"
                      style={cornerStyle(h)}
                    />
                  ))}
                  {(["n", "s", "e", "w"] as const).map((h) => (
                    <div
                      key={h}
                      onPointerDown={beginPointer(pos.clientId, h)}
                      className="absolute z-10 h-1.5 w-1.5 cursor-pointer rounded-full bg-emerald-600"
                      style={edgeStyle(h)}
                    />
                  ))}
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const cornerStyle = (h: string): React.CSSProperties => {
  switch (h) {
    case "nw": return { left: -4, top: -4 };
    case "ne": return { right: -4, top: -4 };
    case "sw": return { left: -4, bottom: -4 };
    case "se": return { right: -4, bottom: -4 };
    default: return {};
  }
};
const edgeStyle = (h: string): React.CSSProperties => {
  switch (h) {
    case "n": return { left: "50%", top: -3, transform: "translateX(-50%)" };
    case "s": return { left: "50%", bottom: -3, transform: "translateX(-50%)" };
    case "e": return { right: -3, top: "50%", transform: "translateY(-50%)" };
    case "w": return { left: -3, top: "50%", transform: "translateY(-50%)" };
    default: return {};
  }
};

/** Phân biệt loại field bằng BORDER + nhãn chữ + icon (không chỉ dùng màu). */
function boxBorderStyle(type: string): {
  border: string;
  selectedBorder: string;
  bg: string;
  selectedBg: string;
  label: string;
} {
  switch (type) {
    case "DATE":
      return { border: "#0284c7", selectedBorder: "#0369a1", bg: "rgba(2,132,199,0.08)", selectedBg: "rgba(2,132,199,0.25)", label: "📅" };
    case "NUMBER":
      return { border: "#7c3aed", selectedBorder: "#6d28d9", bg: "rgba(124,58,237,0.08)", selectedBg: "rgba(124,58,237,0.25)", label: "#" };
    case "CHECKBOX":
    case "RADIO_OPTION":
      return { border: "#059669", selectedBorder: "#047857", bg: "rgba(5,150,105,0.10)", selectedBg: "rgba(5,150,105,0.30)", label: "☑" };
    case "STATIC_TEXT":
      return { border: "#b45309", selectedBorder: "#92400e", bg: "rgba(180,83,9,0.08)", selectedBg: "rgba(180,83,9,0.22)", label: "¶" };
    case "MULTILINE_TEXT":
      return { border: "#0f766e", selectedBorder: "#115e59", bg: "rgba(15,118,110,0.08)", selectedBg: "rgba(15,118,110,0.22)", label: "☰" };
    case "IMAGE":
      return { border: "#334155", selectedBorder: "#1e293b", bg: "rgba(51,65,85,0.08)", selectedBg: "rgba(51,65,85,0.22)", label: "🖼" };
    default:
      return { border: "#2563eb", selectedBorder: "#1d4ed8", bg: "rgba(37,99,235,0.08)", selectedBg: "rgba(37,99,235,0.22)", label: "T" };
  }
}
