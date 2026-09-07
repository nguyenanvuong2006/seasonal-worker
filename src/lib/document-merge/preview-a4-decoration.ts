/**
 * PREVIEW-ONLY A4 SHEET DECORATION (pure string transform, no DOM/React).
 *
 * The browser has no way to obey `@page`/print-media pagination on an
 * ordinary on-screen render (that only ever applies during an actual print
 * action or a headless "print" media emulation) — so an unstyled preview of
 * a multi-page canonical document shows as one long, undifferentiated
 * scrollable block. This does NOT touch the canonical HTML/CSS used for the
 * real merge/PDF (the renderer's own output is never modified) — it only
 * injects an EXTRA, purely visual `<style>` block into an already-rendered
 * preview document, giving each top-level `.page`/`.paper` element a
 * boxed, centered, A4-proportioned "sheet" look with a "Trang N" label, so
 * an operator can visually tell pages apart.
 *
 * This is explicitly an APPROXIMATION: a `.page`/`.paper` whose own content
 * overflows further than one physical page in the real PDF still renders as
 * a single (taller) box here — genuine multi-page overflow pagination is a
 * print-media/Chromium behavior this CSS-only decoration cannot reproduce
 * on screen. The generated PDF ("In / Lưu PDF TEST") remains the
 * authoritative verification artifact; callers must label this preview as
 * approximate next to it (see draft-version-preview-modal.tsx).
 */

export const A4_PREVIEW_SHEET_DECORATION_CSS = `
html { counter-reset: dm-preview-page; }
body { background: #64748b; padding: 28px 0; margin: 0; }
.page, .paper {
  counter-increment: dm-preview-page;
  box-shadow: 0 6px 24px rgba(15, 23, 42, 0.35);
  margin: 0 auto 28px;
  position: relative;
}
.page::before, .paper::before {
  content: "Trang " counter(dm-preview-page);
  position: absolute;
  top: -22px;
  left: 0;
  font: bold 11px/1.4 "Noto Sans", "DejaVu Sans", Arial, sans-serif;
  color: #f1f5f9;
  background: rgba(15, 23, 42, 0.65);
  padding: 2px 9px;
  border-radius: 4px 4px 0 0;
}
`;

/**
 * Margin/printable-area guide (Phase 5) — a subtle, non-printing dashed inset
 * drawn at exactly the configured margin, so an admin can see "A4 physical
 * page -> configured margin -> printable content area" on screen. This is
 * PREVIEW-ONLY: it is injected into the already-rendered preview HTML shown
 * in a modal iframe, exactly like `A4_PREVIEW_SHEET_DECORATION_CSS` above —
 * it never touches the canonical HTML/CSS the real PDF renders from
 * (wrapHtmlDocument's own `pageGeometryCss()` output), so it can never appear
 * in a generated PDF.
 */
export function marginGuideCss(margins: { topMm: number; bottomMm: number; leftMm: number; rightMm: number }): string {
  return `
.page::after, .paper::after {
  content: "";
  position: absolute;
  top: ${margins.topMm}mm;
  right: ${margins.rightMm}mm;
  bottom: ${margins.bottomMm}mm;
  left: ${margins.leftMm}mm;
  border: 1px dashed rgba(37, 99, 235, 0.55);
  pointer-events: none;
}
`;
}

/**
 * Injects the decoration `<style>` right before `</head>` (or, if the
 * document has no `<head>`, prepends it — browsers hoist a stray top-level
 * `<style>` into the parsed `<head>` automatically). Idempotent: a second
 * call is a no-op if the decoration is already present.
 *
 * `margins`, when provided, additionally draws the printable-area guide
 * (see `marginGuideCss`) using the SAME margin values the final PDF used —
 * Preview and PDF must never disagree about what "the margin" is.
 */
export function decoratePreviewForA4Sheets(
  html: string,
  margins?: { topMm: number; bottomMm: number; leftMm: number; rightMm: number } | null,
): string {
  const decoration = A4_PREVIEW_SHEET_DECORATION_CSS + (margins ? marginGuideCss(margins) : "");
  if (html.includes(A4_PREVIEW_SHEET_DECORATION_CSS)) {
    // Idempotent even when a caller adds a margin guide on a second pass: if
    // the base decoration is already present but the guide isn't yet, append
    // just the guide instead of skipping entirely.
    if (margins && !html.includes(marginGuideCss(margins))) {
      const guideTag = `<style>${marginGuideCss(margins)}</style>`;
      return /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${guideTag}</head>`) : `${guideTag}${html}`;
    }
    return html;
  }
  const styleTag = `<style>${decoration}</style>`;
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `${styleTag}</head>`);
  }
  return `${styleTag}${html}`;
}
