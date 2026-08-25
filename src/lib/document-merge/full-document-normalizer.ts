/**
 * FULL DOCUMENT NORMALIZER (H2) — lets a non-technical operator paste an
 * ENTIRE HTML document (as returned by an AI) into ONE textarea, instead of
 * manually splitting it into a body fragment + a separate CSS box.
 *
 * Pure, deterministic, NEVER executes the input (no DOM, no eval, no
 * browser) — built on the H1 html-scanner.ts tokenizer, which is already
 * proven (by its own test suite) to never misread `<<Ho_ten>>`/`{{Ho_ten}}`
 * as an HTML tag. This module does not re-implement tag parsing.
 *
 * IDEMPOTENT / MODE-FREE: safe to run on ANY input —
 *   - a full document (<!DOCTYPE>/<html>/<head>/<style>/<body>) extracts the
 *     body content and concatenates every <style> block, in document order;
 *   - a bare fragment with no <body>/<style> tags at all (the H1 "advanced"
 *     split-editor content) passes through unchanged with an empty printCss
 *     and zero warnings.
 * This lets the SAME route handle both the new "paste full document" UI mode
 * and the existing H1 split html+css mode without a client-supplied flag.
 */

import { tokenizeHtml, type HtmlToken } from "./html-scanner.ts";

export type NormalizationWarningCode = "EXTERNAL_STYLESHEET_IGNORED" | "MULTIPLE_BODY_TAGS_FOUND";

export interface NormalizationWarning {
  code: NormalizationWarningCode;
  message: string;
  /** The ignored external resource URL, when applicable. */
  href?: string;
}

export interface NormalizedDocument {
  htmlBody: string;
  /** CSS extracted from every <style> block, in document order, joined with a blank line. */
  extractedCss: string;
  warnings: NormalizationWarning[];
}

function attrValue(token: Extract<HtmlToken, { type: "open-tag" }>, name: string): string | null {
  return token.attrs.find((a) => a.name === name)?.value ?? null;
}

/**
 * Extract the canonical body content + all <style> block text + external
 * stylesheet warnings from a raw pasted string. Never fetches anything.
 */
/** A candidate <body>...</body> extraction boundary (end === null means unterminated -> runs to EOF). */
interface BodySpan {
  start: number;
  end: number | null;
}

/**
 * FIX (Phase 14 / Defect: "49 removed, 0 added" anomaly) — a malformed AI
 * response can contain an early, EMPTY <body></body> pair (e.g. a stray
 * duplicated wrapper) before the REAL content, itself wrapped in a SECOND
 * <body> tag. The naive "first <body> open, first </body> after it" rule
 * then extracts nothing — every placeholder in the real content silently
 * vanishes from the analyzed "current" body, which the diff engine
 * correctly (but confusingly, from an empty body) reports as 100% REMOVED.
 * Collecting every candidate span and preferring the first NON-EMPTY one
 * fixes this while staying identical for the common cases: a single
 * well-formed <body>, a bare fragment (no span at all), an unterminated
 * <body> (one span, used regardless of emptiness), and two well-formed,
 * both-non-empty <body> tags (first one still wins, unchanged).
 */
function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

export function normalizeFullHtmlDocument(raw: string): NormalizedDocument {
  const input = raw ?? "";
  const tokens = tokenizeHtml(input);
  const warnings: NormalizationWarning[] = [];

  const styleChunks: string[] = [];
  const bodySpans: BodySpan[] = [];
  let pendingBodyStart: number | null = null;

  for (const token of tokens) {
    if (token.type === "raw-text" && token.tagName === "style") {
      styleChunks.push(token.content);
      continue;
    }
    if (token.type === "open-tag" && token.name === "link") {
      const rel = (attrValue(token, "rel") ?? "").trim().toLowerCase();
      if (rel === "stylesheet") {
        const href = attrValue(token, "href") ?? "(không có href)";
        warnings.push({
          code: "EXTERNAL_STYLESHEET_IGNORED",
          message: `Bỏ qua stylesheet ngoài "${href}" — hệ thống KHÔNG tải tài nguyên bên ngoài. Hãy dán trực tiếp nội dung CSS vào trong thẻ <style>.`,
          href,
        });
      }
      continue;
    }
    if (token.type === "open-tag" && token.name === "body" && !token.selfClosing) {
      // A new <body> open while a previous one is still unterminated
      // (malformed/nested) closes that previous span right here — at this
      // tag's START, so the new tag's own text is never swallowed into the
      // span being closed — rather than silently extending it past this tag.
      if (pendingBodyStart !== null) {
        bodySpans.push({ start: pendingBodyStart, end: token.start });
      }
      pendingBodyStart = token.end;
      continue;
    }
    if (token.type === "close-tag" && token.name === "body") {
      if (pendingBodyStart !== null) {
        bodySpans.push({ start: pendingBodyStart, end: token.start });
        pendingBodyStart = null;
      }
      continue;
    }
  }
  if (pendingBodyStart !== null) {
    bodySpans.push({ start: pendingBodyStart, end: null });
  }

  let htmlBody: string;
  if (bodySpans.length > 0) {
    const spanText = (span: BodySpan) => input.slice(span.start, span.end ?? input.length);
    const chosen = bodySpans.find((span) => !isBlank(spanText(span))) ?? bodySpans[0];
    htmlBody = spanText(chosen);
    if (bodySpans.length > 1) {
      warnings.push({
        code: "MULTIPLE_BODY_TAGS_FOUND",
        message: "Phát hiện nhiều hơn 1 thẻ <body> — đã dùng nội dung <body> đầu tiên KHÔNG rỗng.",
      });
    }
  } else {
    // No <body> tag at all: treat the whole paste as the body content. This
    // is the expected, non-error path for an operator pasting a bare
    // fragment (the H1 "advanced" split-editor case) — NOT a warning.
    htmlBody = input;
  }

  return {
    htmlBody,
    extractedCss: styleChunks.join("\n\n"),
    warnings,
  };
}
