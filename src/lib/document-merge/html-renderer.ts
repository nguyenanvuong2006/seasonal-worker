/**
 * HTML/CSS print template engine.
 *
 * Data flow: normalized record → semantic merge fields → escaped HTML →
 * Playwright PDF.  The renderer intentionally has no PDF-coordinate knowledge;
 * positioning, tables, checkboxes and pagination stay in ordinary HTML/CSS.
 *
 * ⚠️ This module holds NO document body and exposes no "render a registered
 * template" entry point. It renders only a body handed to it by the canonical
 * pipeline (see canonical-document.ts). Pagination follows whatever the
 * canonical body defines — no page count is assumed anywhere.
 */

import { extractUniquePlaceholders, replaceMultiplePlaceholders } from "./placeholder-extractor.ts";

/** HTML-escape all merge values before inserting them into a trusted template. */
export function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Production output must never contain editor/preview affordances.  Templates
 * are authored by authorised staff, but stripping these known affordances also
 * makes a pasted visual-preview HTML safe to use as a print template. Scripts
 * and embedded browsing contexts are removed as defence in depth; Chromium's
 * worker additionally blocks all network requests.
 */
function stripInlineEventHandlers(html: string): string {
  // Match only inside a literal start tag. Applying a bare `on...=` regex to
  // arbitrary text would corrupt an escaped candidate value such as
  // `&lt;img onerror=...&gt;` after merge replacement.
  const eventAttributeInTag = /(<[a-z][\w:-]*\b[^>]*?)\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
  let current = html;
  let next = current.replace(eventAttributeInTag, "$1");
  while (next !== current) {
    current = next;
    next = current.replace(eventAttributeInTag, "$1");
  }
  return current;
}

export function stripPreviewOnlyMarkup(html: string): string {
  // The named class list includes the canonical trainee-registration source's
  // visual authoring shell. The legal document itself uses neither of these
  // classes, so removing the complete containers cannot remove form content.
  const previewClasses = "preview-only|template-code|placeholder-highlight|toolbar|nav-tabs|code-panel|page-label|debug-panel|editor-controls|template-panel";
  const withoutPreviewMarkup = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<(?:iframe|object|embed)\b[^>]*>[\s\S]*?<\/(?:iframe|object|embed)\s*>/gi, "")
    .replace(/<(?:nav|button)\b[^>]*>[\s\S]*?<\/(?:nav|button)\s*>/gi, "")
    .replace(/<([a-z][\w:-]*)\b[^>]*\b(?:data-preview-only|data-template-code)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(new RegExp(`<([a-z][\\w:-]*)\\b[^>]*\\bclass=(?:"[^"]*\\b(?:${previewClasses})\\b[^"]*"|'[^']*\\b(?:${previewClasses})\\b[^']*')[^>]*>[\\s\\S]*?<\\/\\1\\s*>`, "gi"), "");
  return stripInlineEventHandlers(withoutPreviewMarkup);
}

/**
 * Shared print rules.  `.page + .page` starts a new logical section without a
 * trailing forced blank page.  A long value may naturally add a page, but it
 * cannot overlap its neighbour or create an empty final page.
 */
export const A4_PRINT_CSS = `
@page {
  size: A4;
  margin: 12mm 12mm;
}
* {
  box-sizing: border-box;
}
html, body {
  margin: 0;
  padding: 0;
  font-family: "Noto Sans", "DejaVu Sans", "Arial", "Times New Roman", sans-serif;
  font-size: 12pt;
  line-height: 1.5;
  color: #000;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.page {
  width: 100%;
  break-after: auto;
  page-break-after: auto;
}
.page + .page {
  break-before: page;
  page-break-before: always;
}
h1 { font-size: 16pt; margin: 0 0 4pt; }
h2 { font-size: 14pt; margin: 8pt 0 4pt; }
h3 { font-size: 12.5pt; margin: 6pt 0 2pt; }
p { margin: 0 0 4pt; overflow-wrap: anywhere; word-break: normal; }
.center { text-align: center; }
.right { text-align: right; }
.bold { font-weight: 700; }
.italic { font-style: italic; }
.underline { text-decoration: underline; }
table {
  width: 100%;
  table-layout: fixed;
  border-collapse: collapse;
  margin: 4pt 0;
}
th, td {
  border: 1px solid #000;
  padding: 3pt 4pt;
  vertical-align: top;
  text-align: left;
  overflow-wrap: anywhere;
  word-break: normal;
}
th { font-weight: 700; text-align: center; }
.no-border, .no-border th, .no-border td { border: none; }
.field { display: inline-block; min-width: 80pt; max-width: 100%; border-bottom: 1px dotted #000; padding: 0 4pt; overflow-wrap: anywhere; }
.merge-value { overflow-wrap: anywhere; word-break: normal; }
.chk {
  display: inline-block;
  width: 9pt;
  height: 9pt;
  border: 1.2px solid #000;
  margin: 0 2pt 0 0;
  vertical-align: -1pt;
  text-align: center;
  font-size: 8pt;
  line-height: 9pt;
  white-space: nowrap;
}
.sig-line { display: inline-block; width: 160pt; border-bottom: 1px solid #000; }
.logo { max-height: 22mm; max-width: 100%; }
/* Keep signatures and complete tables together where room permits. */
.page .right,
.page table,
.sig-block {
  break-inside: avoid;
  page-break-inside: avoid;
}
/* Belt-and-braces protection if a trusted template retains preview classes. */
.preview-only,
.template-code,
.placeholder-highlight,
[data-preview-only],
[data-template-code] { display: none !important; }
`;

/**
 * Layout capability utilities (v12) — opt-in, class-scoped CSS. No existing
 * template references these classes, so appending them to the shared print
 * CSS is a no-op for every already-PUBLISHED template.
 */
export const LAYOUT_UTILITY_CSS = `
.equal-columns-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  column-gap: 8mm;
  align-items: baseline;
}
.equal-columns-2 > * { min-width: 0; }
.keep-with-next-small {
  break-after: avoid;
  page-break-after: avoid;
}
.variable-length {
  overflow-wrap: anywhere;
  word-break: normal;
  white-space: normal;
  min-width: 0;
}
`;

/** Wrap trusted body + CSS into a Unicode A4 document suitable for Playwright. */
export function wrapHtmlDocument(bodyHtml: string, css: string): string {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>${A4_PRINT_CSS}\n${LAYOUT_UTILITY_CSS}\n${css}</style>
</head>
<body>${stripPreviewOnlyMarkup(bodyHtml)}</body>
</html>`;
}

export interface RenderResult {
  html: string;
  /** Semantic placeholders left after replacement; a job must not render these to PDF. */
  unreplaced: string[];
}

/**
 * Render an arbitrary published version.  Both current {{Field}} and legacy
 * <<Field>> syntax resolve to the same semantic field. Candidate data is always
 * escaped; only the authorised template markup is retained.
 */
export function renderApplicantHtmlFromParts(
  bodyHtml: string,
  css: string | null | undefined,
  fieldValues: Record<string, string>,
): RenderResult {
  const escaped: Record<string, string> = {};
  for (const [key, value] of Object.entries(fieldValues)) {
    escaped[key] = escapeHtml(value);
  }
  const body = replaceMultiplePlaceholders(stripPreviewOnlyMarkup(bodyHtml), escaped);
  const unreplaced = extractUniquePlaceholders(body);
  return { html: wrapHtmlDocument(body, css ?? ""), unreplaced };
}
