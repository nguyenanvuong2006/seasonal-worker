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
 * Injects the decoration `<style>` right before `</head>` (or, if the
 * document has no `<head>`, prepends it — browsers hoist a stray top-level
 * `<style>` into the parsed `<head>` automatically). Idempotent: a second
 * call is a no-op if the decoration is already present.
 */
export function decoratePreviewForA4Sheets(html: string): string {
  if (html.includes(A4_PREVIEW_SHEET_DECORATION_CSS)) return html;
  const styleTag = `<style>${A4_PREVIEW_SHEET_DECORATION_CSS}</style>`;
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `${styleTag}</head>`);
  }
  return `${styleTag}${html}`;
}
