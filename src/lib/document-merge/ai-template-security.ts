/**
 * AI TEMPLATE SECURITY SCANNER (H1) — advisory, read-only, parser-driven
 * detection of unsafe constructs in operator-pasted HTML/CSS, before it is
 * ever saved to a DRAFT.
 *
 * This module NEVER executes/renders the input (no Playwright, no DOM,
 * no eval). It only tokenizes (html-scanner.ts / css-scanner.ts) and pattern
 * matches over the resulting structured tokens.
 *
 * ACTUAL RENDERER SECURITY BOUNDARY (audited — see html-renderer.ts and
 * worker/src/index.ts):
 *   - `stripPreviewOnlyMarkup()` in html-renderer.ts already REMOVES
 *     <script>, <iframe>/<object>/<embed>, inline `on*=` event attributes,
 *     and <nav>/<button> from the canonical body before it is ever rendered.
 *   - The Cloud Run worker's Playwright/Chromium instance additionally
 *     blocks ALL network requests as defence in depth (see worker/src/index.ts
 *     request interception), which is the real backstop against any
 *     `url()`/`@import`/navigation-based exfiltration — not a CSS sanitizer.
 *   - Neither the renderer nor the worker currently inspects CSS for
 *     `expression()`, `-moz-binding`, or scheme-based `url()` payloads;
 *     these are dead in Chromium's print pipeline (no legacy IE CSS
 *     expressions, no XBL) and network is blocked, but pasting them signals
 *     the source HTML/CSS was not authored for a static print document, so
 *     this scanner still flags them for operator awareness before they
 *     silently do nothing (or get silently stripped) in production.
 *   - `<meta http-equiv="refresh">` is NOT currently stripped by the
 *     renderer. It has no effect in a one-shot Chromium PDF print (no
 *     interactive navigation occurs), so it is reported as a WARNING, not an
 *     ERROR — informational, not a demonstrated bypass of the render
 *     pipeline's own guarantees.
 *
 * This module therefore reports what an authoring/AI-revision workflow
 * should never introduce, not a claim that unpatched HTML is unsafe to
 * render — the renderer's own stripping + network blocking remain the real
 * enforcement boundary and are untouched by H1.
 */

import { tokenizeHtml, decodeBasicEntities, type HtmlToken } from "./html-scanner.ts";
import { parseCss, extractCssUrls } from "./css-scanner.ts";

export type SecuritySeverity = "ERROR" | "WARNING";

export interface SecurityFinding {
  severity: SecuritySeverity;
  code: string;
  message: string;
  /** Best-effort human-readable location (tag name, selector, or property). */
  location?: string;
}

const DANGEROUS_URL_SCHEMES = ["javascript:", "vbscript:"];

function normalizeForSchemeCheck(value: string): string {
  // Strip control/whitespace chars commonly used to defeat naive prefix
  // checks (e.g. "java\tscript:", "  javascript:") and decode simple entities.
  return decodeBasicEntities(value)
    .replace(/\s+/g, "")
    .toLowerCase();
}

function hasDangerousScheme(rawValue: string): string | null {
  const normalized = normalizeForSchemeCheck(rawValue);
  for (const scheme of DANGEROUS_URL_SCHEMES) {
    if (normalized.startsWith(scheme)) return scheme;
  }
  return null;
}

const EVENT_ATTR_RE = /^on[a-z]+$/i;

function scanHtmlTokens(tokens: HtmlToken[]): SecurityFinding[] {
  const findings: SecurityFinding[] = [];

  for (const token of tokens) {
    if (token.type === "raw-text" && token.tagName === "script") {
      findings.push({
        severity: "ERROR",
        code: "SCRIPT_TAG",
        message: "Không được dùng thẻ <script> trong template — mã sẽ bị chặn khi render và không có tác dụng trong tài liệu in tĩnh.",
        location: "<script>",
      });
      continue;
    }

    if (token.type !== "open-tag") continue;

    if (token.name === "iframe" || token.name === "object" || token.name === "embed") {
      findings.push({
        severity: "ERROR",
        code: "UNSUPPORTED_EMBED",
        message: `Thẻ <${token.name}> không được hỗ trợ — renderer sẽ loại bỏ toàn bộ nội dung bên trong, có thể làm mất dữ liệu/layout mà không báo lỗi.`,
        location: `<${token.name}>`,
      });
    }

    if (token.name === "meta") {
      const httpEquiv = token.attrs.find((a) => a.name === "http-equiv")?.value ?? "";
      if (httpEquiv.trim().toLowerCase() === "refresh") {
        findings.push({
          severity: "WARNING",
          code: "META_REFRESH",
          message: '<meta http-equiv="refresh"> không có tác dụng khi in PDF tĩnh (không có điều hướng) — nên xoá.',
          location: "<meta http-equiv=\"refresh\">",
        });
      }
    }

    for (const attr of token.attrs) {
      if (EVENT_ATTR_RE.test(attr.name)) {
        findings.push({
          severity: "ERROR",
          code: "INLINE_EVENT_HANDLER",
          message: `Thuộc tính sự kiện nội tuyến "${attr.name}" trên <${token.name}> sẽ bị loại bỏ khi render — không dùng.`,
          location: `<${token.name} ${attr.name}>`,
        });
        continue;
      }
      if (attr.value == null) continue;
      const scheme = hasDangerousScheme(attr.value);
      if (scheme) {
        findings.push({
          severity: "ERROR",
          code: scheme === "javascript:" ? "JAVASCRIPT_URL" : "VBSCRIPT_URL",
          message: `Thuộc tính "${attr.name}" trên <${token.name}> dùng scheme "${scheme}" — không được phép.`,
          location: `<${token.name} ${attr.name}>`,
        });
      }
    }
  }

  return findings;
}

function scanCss(css: string): SecurityFinding[] {
  if (!css || !css.trim()) return [];
  const findings: SecurityFinding[] = [];
  const { rules, atStatements, sourceWithoutComments } = parseCss(css);

  const checkValue = (property: string, value: string, location: string) => {
    if (/expression\s*\(/i.test(value)) {
      findings.push({
        severity: "ERROR",
        code: "CSS_EXPRESSION",
        message: `CSS expression() trong "${property}" (${location}) không được phép — cú pháp legacy Internet Explorer, không có tác dụng và không an toàn.`,
        location,
      });
    }
    if (/-moz-binding/i.test(property) || /-moz-binding/i.test(value)) {
      findings.push({
        severity: "ERROR",
        code: "MOZ_BINDING",
        message: `-moz-binding (${location}) không được phép — cơ chế XBL legacy Firefox có thể tải mã ngoài.`,
        location,
      });
    }
    for (const url of extractCssUrls(value)) {
      const scheme = hasDangerousScheme(url);
      if (scheme) {
        findings.push({
          severity: "ERROR",
          code: "DANGEROUS_CSS_URL",
          message: `url(...) trong "${property}" (${location}) dùng scheme "${scheme}" — không được phép.`,
          location,
        });
      }
    }
  };

  for (const rule of rules) {
    for (const decl of rule.declarations) {
      checkValue(decl.property, decl.value, rule.selectorText || "(inline)");
    }
  }

  for (const statement of atStatements) {
    if (/^@import\b/i.test(statement)) {
      findings.push({
        severity: "WARNING",
        code: "UNSAFE_CSS_IMPORT",
        message: `@import (${statement.trim()}) sẽ không tải được — worker chặn toàn bộ network request. Style từ nguồn ngoài sẽ không xuất hiện trong PDF; nên nhúng CSS trực tiếp thay vì @import.`,
        location: statement.trim(),
      });
    }
  }

  // Belt-and-suspenders scan over the whole comment-stripped source for
  // dangerous schemes that might sit outside a recognized declaration (e.g.
  // a malformed rule the structural parser could not fully attribute).
  for (const scheme of DANGEROUS_URL_SCHEMES) {
    if (normalizeForSchemeCheck(sourceWithoutComments).includes(scheme)) {
      const already = findings.some((f) => f.code === "DANGEROUS_CSS_URL");
      if (!already) {
        findings.push({
          severity: "ERROR",
          code: "DANGEROUS_CSS_URL",
          message: `Phát hiện scheme "${scheme}" trong CSS — không được phép.`,
          location: "(css)",
        });
      }
    }
  }

  return findings;
}

export interface SecurityAnalysis {
  errors: SecurityFinding[];
  warnings: SecurityFinding[];
}

/** Analyze HTML + CSS for unsafe constructs. Pure, read-only, never executes input. */
export function analyzeTemplateSecurity(html: string, css: string): SecurityAnalysis {
  const tokens = tokenizeHtml(html ?? "");
  const findings = [...scanHtmlTokens(tokens), ...scanCss(css ?? "")];
  return {
    errors: findings.filter((f) => f.severity === "ERROR"),
    warnings: findings.filter((f) => f.severity === "WARNING"),
  };
}
