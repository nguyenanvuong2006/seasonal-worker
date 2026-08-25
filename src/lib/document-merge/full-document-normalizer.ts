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
export function normalizeFullHtmlDocument(raw: string): NormalizedDocument {
  const input = raw ?? "";
  const tokens = tokenizeHtml(input);
  const warnings: NormalizationWarning[] = [];

  const styleChunks: string[] = [];
  let bodyOpenCount = 0;
  let bodyStart: number | null = null;
  let bodyEnd: number | null = null;

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
      bodyOpenCount += 1;
      // Only the FIRST <body> tag defines the extraction boundary — a second
      // one (malformed input) is counted for the warning below but ignored
      // for boundary purposes.
      if (bodyStart === null) bodyStart = token.end;
      continue;
    }
    if (token.type === "close-tag" && token.name === "body") {
      // The FIRST </body> AFTER the first <body> closes the boundary.
      if (bodyStart !== null && bodyEnd === null && token.start >= bodyStart) bodyEnd = token.start;
      continue;
    }
  }

  let htmlBody: string;
  if (bodyStart !== null) {
    htmlBody = input.slice(bodyStart, bodyEnd ?? input.length);
    if (bodyOpenCount > 1) {
      warnings.push({
        code: "MULTIPLE_BODY_TAGS_FOUND",
        message: "Phát hiện nhiều hơn 1 thẻ <body> — đã dùng thẻ <body> đầu tiên.",
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
