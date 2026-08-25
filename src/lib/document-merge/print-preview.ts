/**
 * PRINT-ONLY PREVIEW VIEW — deterministic browser print for the visual PDF
 * acceptance gate.
 *
 * WHY
 * ---
 * The previous "In / Lưu PDF TEST" implementation called
 * `iframe.contentWindow.print()` on a `<iframe sandbox="allow-modals">`.
 * A sandboxed iframe without `allow-same-origin` is treated as an OPAQUE
 * origin, so the parent page is cross-origin relative to it. `print()` is NOT
 * in the cross-origin-allowed member set for a WindowProxy, so the call threw
 * a SecurityError and the button had no observable effect. Even where that is
 * allowed, `iframe.contentWindow.print()` is unreliable on Chrome Android: the
 * mobile browser does not reliably open the native print dialog for a nested
 * iframe's content.
 *
 * This module builds the deterministic alternative: a print-only view that is a
 * TOP-LEVEL document the browser owns. A top-level `window.print()` opens the
 * native dialog for THAT document on desktop Chrome AND Chrome Android, prints
 * the Preview document only (never the admin page), and is driven by the same
 * canonical renderer as the Preview + Cloud Run HTML_PDF worker.
 *
 * It is intentionally dependency-free (no db, no next, no io) so it can be unit
 * tested without a database and reused by the print route.
 */

/** Query control for the print-only route: `autoprint=1` auto-opens the dialog. */
export const PRINT_VIEW_AUTO_PRINT = "1";

/** Default path of the print-only route (relative — the modal opens it in a new tab). */
export const PRINT_VIEW_PATH = "/api/document-merge/templates/:templateId/versions/:versionId/print";

/** Metadata rendered into the print-only toolbar. */
export interface PrintToolingMeta {
  templateName: string;
  version: number;
  versionStatus: string;
  fullName?: string | null | undefined;
  cccd?: string | null | undefined;
  /**
   * H2 fix (Defect A / Phase 4/11) — when set, a prominent red line is added
   * to the toolbar so the operator never prints/saves a PDF that still has
   * unresolved placeholders without seeing why. Build this with
   * buildUnresolvedPlaceholderTitle() (unresolved-placeholder-guard.ts) —
   * the SAME module unsaved-preview uses, so Preview and Print never diverge
   * on this signal (print parity).
   */
  warning?: string | null | undefined;
}

/** True when a preview has actually been produced (so only then may we print it). */
export function hasRenderedPreview(result: { renderedHtml?: string | null | undefined } | null | undefined): boolean {
  return typeof result?.renderedHtml === "string" && result.renderedHtml.trim().length > 0;
}

/**
 * Resolve which candidate the print view must use.
 *
 * `previewApplicationId` is the id captured when the current `renderedHtml` was
 * produced; `selectedId` is the id of the candidate row currently selected in
 * the list. These can diverge if the operator picks another candidate after
 * rendering without re-running the preview, so the RENDERED id always wins.
 */
export function resolvePreviewApplicationId(
  previewApplicationId: string | null | undefined,
  selectedId: string | null | undefined,
): string | null {
  return previewApplicationId || selectedId || null;
}

/**
 * Single decision point for the print action: there must be a rendered preview
 * AND a candidate id that produced it. This is the gate that prevents printing
 * a blank/wrong document before the Preview has rendered successfully.
 */
export function canOpenPrintView(
  preview: { renderedHtml?: string | null | undefined } | null | undefined,
  previewApplicationId: string | null | undefined,
  selectedId: string | null | undefined,
): boolean {
  if (!hasRenderedPreview(preview)) return false;
  return Boolean(resolvePreviewApplicationId(previewApplicationId, selectedId));
}

/**
 * Build the absolute (site-relative) URL of the print-only view.
 *
 * `templateId`/`versionId` come from the route path (explicit, never the
 * published pointer) and `applicationId` comes from the already-rendered
 * preview. With `autoPrint` the browsed page calls `window.print()` on load so
 * the operator gets the native dialog immediately; without it the page shows the
 * A4 document and an in-page "In / Lưu PDF" button (the mobile-safe fallback).
 */
export function buildPrintViewUrl(input: {
  templateId: string;
  versionId: string;
  applicationId: string;
  autoPrint?: boolean;
}): string {
  const params = new URLSearchParams({ applicationId: input.applicationId });
  if (input.autoPrint) params.set("autoprint", PRINT_VIEW_AUTO_PRINT);
  const path = PRINT_VIEW_PATH.replace(":templateId", encodeURIComponent(input.templateId)).replace(
    ":versionId",
    encodeURIComponent(input.versionId),
  );
  return `${path}?${params.toString()}`;
}

/** Escape a value for insertion into the print-only toolbar (defence in depth). */
function escapeAttr(value: string | null | undefined): string {
  return (value ?? "").replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

/** Screen-only toolbar style. Hidden entirely when the document is printed. */
const PRINT_TOOLBAR_CSS = `
.print-toolbar {
  position: sticky;
  top: 0;
  z-index: 99999;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px 16px;
  padding: 10px 16px;
  background: #0f172a;
  color: #e2e8f0;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 13px;
  line-height: 1.4;
  border-bottom: 1px solid rgba(255, 255, 255, 0.15);
}
.print-toolbar .pt-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.print-toolbar .pt-title { font-weight: 700; color: #fff; }
.print-toolbar .pt-meta { opacity: 0.85; }
.print-toolbar .pt-actions { display: flex; gap: 8px; }
.print-toolbar .pt-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.3);
  background: transparent;
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  text-decoration: none;
}
.print-toolbar .pt-btn-primary { background: #10b981; border-color: #10b981; color: #04231a; }
.print-toolbar .pt-warning {
  width: 100%;
  margin-top: 6px;
  padding: 6px 10px;
  border-radius: 6px;
  background: #7f1d1d;
  color: #fecaca;
  font-weight: 700;
}
@media print {
  .print-toolbar, .print-toolbar * { display: none !important; }
}
`;

/**
 * Script injected into the print-only view. It wires the in-page button and,
 * only when the body carries `data-autoprint="1"`, opens the native print
 * dialog once the document has loaded. The toolbar is never printed.
 */
const PRINT_VIEW_SCRIPT = `
(function () {
  function doPrint() {
    try { window.print(); } catch (err) { /* operator can use the in-page button */ }
  }
  var btn = document.getElementById('pt-print-btn');
  if (btn) {
    btn.addEventListener('click', function (ev) {
      ev.preventDefault();
      doPrint();
    });
  }
  if (document.body && document.body.getAttribute('data-autoprint') === '1') {
    window.addEventListener('load', function () {
      setTimeout(function () { doPrint(); }, 150);
    });
  }
})();
`;

/**
 * Turn a rendered canonical Preview document into a print-only view.
 *
 * The canonical `renderedHtml` is already a full standalone `<html>` document
 * (A4 `@page`, print CSS and the merged body) — it is the SAME document the
 * Preview iframe shows. We only ADD a screen-only toolbar and an auto-print
 * script; the document body, the merged text and the A4 print CSS are left
 * byte-for-byte intact.
 *
 * `autoPrint` controls whether the loaded page opens the native print dialog.
 */
export function injectPrintTooling(
  renderedHtml: string,
  meta: PrintToolingMeta,
  options: { autoPrint?: boolean } = {},
): string {
  const autoPrint = options.autoPrint === true;
  const toolbar = `
<div class="print-toolbar" data-print-toolbar>
  <div class="pt-info">
    <span class="pt-title">Bản in — kiểm tra trực quan</span>
    <span class="pt-meta">${escapeAttr(meta.templateName)} · v${Number.isFinite(meta.version) ? meta.version : "?"} (${escapeAttr(meta.versionStatus)})${meta.fullName ? " · " + escapeAttr(meta.fullName) : ""}${meta.cccd ? " · CCCD " + escapeAttr(meta.cccd) : ""}</span>
    <span class="pt-meta">Không tạo job, không ghi DB, không publish.</span>
  </div>
  <div class="pt-actions">
    <button type="button" class="pt-btn pt-btn-primary" id="pt-print-btn">In / Lưu PDF</button>
  </div>
  ${meta.warning ? `<div class="pt-warning">${escapeAttr(meta.warning)}</div>` : ""}
</div>`;
  const style = `<style>${PRINT_TOOLBAR_CSS}</style>`;

  const bodyMatch = renderedHtml.match(/<body([^>]*)>/i);
  const tooling = `${style}${toolbar}`;
  let out: string;

  if (bodyMatch) {
    const attrs = bodyMatch[1];
    const bodyTag = `<body${attrs}${autoPrint ? ' data-autoprint="1"' : ""}>`;
    out = renderedHtml.replace(bodyMatch[0], `${bodyTag}${tooling}`);
  } else {
    // Defensive: canonical output always carries a <body>, but if one ever
    // does not, prepend the tooling so the page is still usable.
    out = `${tooling}${renderedHtml}`;
  }

  out = out.replace(/<\/body>/i, `${PRINT_VIEW_SCRIPT}</body>`);
  return out;
}
