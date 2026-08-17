/**
 * HTML/CSS print template engine (Phase 2).
 *
 * Render 1 candidate → HTML → Playwright `page.pdf()`.
 *
 * Template HTML chứa ĐÚNG canonical placeholder `<<...>>` (cùng bộ mà Placeholder
 * Scanner / Mapping Inspector / Data Resolver đang dùng) — KHÔNG xây hệ mapping mới.
 * Giá trị được fill bằng `resolveAllFields` + `applyFallbackPlaceholders` (reuse).
 *
 * Preview và production dùng CHÍNH hàm này → Preview đúng thì PDF đúng.
 */

import { extractUniquePlaceholders, replaceMultiplePlaceholders } from "./placeholder-extractor.ts";

/** HTML-escape giá trị trước khi fill vào template (chống XSS / markup vỡ). */
export function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface HtmlTemplate {
  /** Key định danh template (vd "dang-ky-tap-nghe"). */
  key: string;
  name: string;
  /** Google Doc ID tương ứng (để map merge_templates.google_doc_id → HTML template). */
  googleDocIds: string[];
  /** Body HTML (chỉ phần nội dung, KHÔNG chứa <html>/<head>). */
  html: string;
  /** Print CSS (được nhúng vào <style>). */
  css: string;
}

/** Print CSS chuẩn A4 — mọi template dùng chung các quy tắc này. */
export const A4_PRINT_CSS = `
@page {
  size: A4;
  margin: 14mm 12mm;
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
  page-break-after: always;
  break-after: page;
  width: 100%;
}
.page:last-child {
  page-break-after: auto;
  break-after: auto;
}
h1 { font-size: 16pt; margin: 0 0 4pt; }
h2 { font-size: 14pt; margin: 8pt 0 4pt; }
h3 { font-size: 12.5pt; margin: 6pt 0 2pt; }
p { margin: 0 0 4pt; }
.center { text-align: center; }
.right { text-align: right; }
.bold { font-weight: 700; }
.italic { font-style: italic; }
.underline { text-decoration: underline; }
table {
  width: 100%;
  border-collapse: collapse;
  margin: 4pt 0;
}
th, td {
  border: 1px solid #000;
  padding: 3pt 4pt;
  vertical-align: top;
  text-align: left;
}
th { font-weight: 700; text-align: center; }
.no-border, .no-border th, .no-border td { border: none; }
.field { display: inline-block; min-width: 80pt; border-bottom: 1px dotted #000; padding: 0 4pt; }
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
}
.sig-line { display: inline-block; width: 160pt; border-bottom: 1px solid #000; }
.logo { max-height: 22mm; max-width: 100%; }
`;

/** Bọc body + css thành document HTML hoàn chỉnh để `page.setContent()`. */
export function wrapHtmlDocument(bodyHtml: string, css: string): string {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8" />
<style>${A4_PRINT_CSS}\n${css}</style>
</head>
<body>${bodyHtml}</body>
</html>`;
}

export interface RenderResult {
  html: string;
  /** Placeholder còn sót (chưa được fill) — để detect mapping thiếu. */
  unreplaced: string[];
}

/**
 * Render từ body html + css bất kỳ (Phase 4 — version-based).
 * Preview & production cùng dùng; escape mọi giá trị trước khi fill (chống XSS).
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
  const body = replaceMultiplePlaceholders(bodyHtml, escaped);
  const unreplaced = extractUniquePlaceholders(body);
  return { html: wrapHtmlDocument(body, css ?? ""), unreplaced };
}

/** Render template + field values → HTML hoàn chỉnh. Preview & production cùng dùng. */
export function renderApplicantHtml(template: HtmlTemplate, fieldValues: Record<string, string>): RenderResult {
  return renderApplicantHtmlFromParts(template.html, template.css, fieldValues);
}
