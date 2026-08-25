/**
 * HTML SCANNER — deterministic, dependency-free HTML tokenizer for the AI
 * Template Analyze workflow (H1).
 *
 * This is NOT a rendering engine and NEVER executes/evaluates the input. It
 * only tokenizes text into a flat, ordered token stream so callers (security
 * scanner, layout scanner, well-formedness check) can reason about structure
 * without regex-over-the-whole-document, which is fragile around:
 *   - quoted attribute values that themselves contain '>' or 'on...=';
 *   - HTML comments containing tag-like text;
 *   - <script>/<style> raw-text content (must NOT be tag-parsed — the HTML
 *     spec treats everything up to the matching closing tag as opaque text);
 *   - placeholder tokens such as <<Ho_ten>> or {{Ho_ten}}, which must NEVER
 *     be misread as an HTML tag. A '<' is only ever treated as the start of a
 *     tag/comment/doctype when immediately followed by a valid tag-name-start
 *     character, '!', or '/'. '<<Ho_ten>>' fails that test (second char is
 *     '<'), so it is correctly scanned as literal text.
 *
 * Deliberately NOT a full HTML5 parser: no implicit tag closing, no foster
 * parenting, no entity table beyond the 5 predefined XML entities + numeric
 * refs (sufficient for detecting encoded bypass attempts in attribute
 * values). This is an advisory linter, not a browser.
 */

export type HtmlAttr = { name: string; value: string | null; raw: string };

export type HtmlToken =
  | { type: "doctype"; raw: string }
  | { type: "comment"; content: string }
  | { type: "text"; content: string; start: number; end: number }
  | {
      type: "open-tag";
      name: string;
      attrs: HtmlAttr[];
      selfClosing: boolean;
      raw: string;
      start: number;
      end: number;
    }
  | { type: "close-tag"; name: string; start: number; end: number }
  | { type: "raw-text"; tagName: string; content: string; start: number; end: number };

/** HTML5 "raw text" elements: content is opaque until the matching close tag. */
const RAW_TEXT_ELEMENTS = new Set(["script", "style"]);

/** Void elements never have a matching close tag / raw-text body. */
const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

function isTagNameStart(ch: string): boolean {
  return /[a-zA-Z]/.test(ch);
}

function isTagNameChar(ch: string): boolean {
  return /[a-zA-Z0-9:_-]/.test(ch);
}

/** Decode the 5 XML predefined entities + numeric character references. Best-effort, advisory only. */
export function decodeBasicEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    })
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

function parseAttributes(raw: string): HtmlAttr[] {
  const attrs: HtmlAttr[] = [];
  const re = /([^\s"'>/=]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|[^\s"'=<>`]+))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const name = m[1];
    if (!name || name === "/") continue;
    let value: string | null = null;
    if (m[2] !== undefined) {
      value = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[2];
    }
    attrs.push({ name: name.toLowerCase(), value, raw: m[0] });
  }
  return attrs;
}

/**
 * Tokenize an HTML string. Pure function, no I/O, no execution of any script
 * or style content — script/style bodies are returned as opaque raw-text
 * tokens for the security scanner to inspect as plain text.
 */
export function tokenizeHtml(html: string): HtmlToken[] {
  const tokens: HtmlToken[] = [];
  const len = html.length;
  let i = 0;
  let textStart = 0;

  function flushText(end: number) {
    if (end > textStart) {
      tokens.push({ type: "text", content: html.slice(textStart, end), start: textStart, end });
    }
  }

  while (i < len) {
    if (html[i] !== "<") {
      i += 1;
      continue;
    }

    // Comment: <!-- ... -->
    if (html.startsWith("<!--", i)) {
      flushText(i);
      const close = html.indexOf("-->", i + 4);
      const end = close === -1 ? len : close + 3;
      tokens.push({ type: "comment", content: html.slice(i + 4, close === -1 ? len : close) });
      i = end;
      textStart = i;
      continue;
    }

    // DOCTYPE: <!DOCTYPE ...>
    if (/^<!doctype/i.test(html.slice(i, i + 9))) {
      flushText(i);
      const close = html.indexOf(">", i);
      const end = close === -1 ? len : close + 1;
      tokens.push({ type: "doctype", raw: html.slice(i, end) });
      i = end;
      textStart = i;
      continue;
    }

    // Close tag: </name>
    if (html[i + 1] === "/" && isTagNameStart(html[i + 2] ?? "")) {
      flushText(i);
      let j = i + 2;
      let name = "";
      while (j < len && isTagNameChar(html[j])) {
        name += html[j];
        j += 1;
      }
      const close = html.indexOf(">", j);
      const end = close === -1 ? len : close + 1;
      tokens.push({ type: "close-tag", name: name.toLowerCase(), start: i, end });
      i = end;
      textStart = i;
      continue;
    }

    // Open tag: <name ...> or <name .../>
    if (isTagNameStart(html[i + 1] ?? "")) {
      flushText(i);
      let j = i + 1;
      let name = "";
      while (j < len && isTagNameChar(html[j])) {
        name += html[j];
        j += 1;
      }
      const tagNameLower = name.toLowerCase();

      // Scan forward to the matching unquoted '>' — quotes may contain '>'.
      let k = j;
      let quote: string | null = null;
      while (k < len) {
        const ch = html[k];
        if (quote) {
          if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'") {
          quote = ch;
        } else if (ch === ">") {
          break;
        }
        k += 1;
      }
      const tagEnd = k < len ? k + 1 : len;
      const attrsRaw = html.slice(j, k < len && html[k - 1] === "/" ? k - 1 : k);
      const selfClosing = k < len && html[k - 1] === "/";
      const attrs = parseAttributes(attrsRaw);
      const rawTag = html.slice(i, tagEnd);

      tokens.push({
        type: "open-tag",
        name: tagNameLower,
        attrs,
        selfClosing: selfClosing || VOID_ELEMENTS.has(tagNameLower),
        raw: rawTag,
        start: i,
        end: tagEnd,
      });
      i = tagEnd;
      textStart = i;

      // Raw-text elements: everything up to the matching close tag is opaque.
      if (!selfClosing && RAW_TEXT_ELEMENTS.has(tagNameLower)) {
        const closeRe = new RegExp(`</${tagNameLower}\\s*>`, "i");
        const rest = html.slice(i);
        const match = closeRe.exec(rest);
        const contentEnd = match ? i + match.index : len;
        tokens.push({
          type: "raw-text",
          tagName: tagNameLower,
          content: html.slice(i, contentEnd),
          start: i,
          end: contentEnd,
        });
        const afterClose = match ? contentEnd + match[0].length : len;
        if (match) {
          tokens.push({ type: "close-tag", name: tagNameLower, start: contentEnd, end: afterClose });
        }
        i = afterClose;
        textStart = i;
      }
      continue;
    }

    // '<' not followed by a valid tag-name-start/'/'/'!' — e.g. '<<Ho_ten>>',
    // stray '<', or '< 5'. Treat as literal text and keep scanning.
    //
    // IMPORTANT: advance past EVERY contiguous '<' here, not just one. If we
    // stopped after a single '<', the next loop iteration would land on the
    // second '<' of '<<Ho_ten>>' and — read in isolation — 'Ho_ten>>' DOES
    // look like a valid open-tag start ('H' is a tag-name-start char), which
    // would wrongly emit an <ho_ten> tag token. Skipping the whole run of
    // '<' characters in one step keeps the placeholder as a single text run.
    while (i < len && html[i] === "<") i += 1;
  }

  flushText(len);
  return tokens;
}

export interface WellFormednessIssue {
  code: "UNCLOSED_TAG" | "MISMATCHED_CLOSE_TAG" | "UNEXPECTED_CLOSE_TAG";
  tagName: string;
  message: string;
}

/**
 * Stack-based well-formedness check. This intentionally does NOT implement
 * HTML5's implicit-closing rules (e.g. <p> auto-closing before another <p>) —
 * it only reports tags that are structurally unbalanced, which is what an
 * operator pasting AI-revised HTML actually needs to know about.
 */
export function checkWellFormedness(tokens: HtmlToken[]): WellFormednessIssue[] {
  const issues: WellFormednessIssue[] = [];
  const stack: string[] = [];

  for (const token of tokens) {
    if (token.type === "open-tag" && !token.selfClosing) {
      stack.push(token.name);
    } else if (token.type === "close-tag") {
      if (stack.length === 0) {
        issues.push({
          code: "UNEXPECTED_CLOSE_TAG",
          tagName: token.name,
          message: `Thẻ đóng </${token.name}> không có thẻ mở tương ứng.`,
        });
        continue;
      }
      const top = stack[stack.length - 1];
      if (top === token.name) {
        stack.pop();
      } else {
        // Look further down the stack for a matching open tag (tolerant of
        // one mis-ordered pair) before declaring it fully unmatched.
        const idx = stack.lastIndexOf(token.name);
        if (idx === -1) {
          issues.push({
            code: "UNEXPECTED_CLOSE_TAG",
            tagName: token.name,
            message: `Thẻ đóng </${token.name}> không khớp thẻ mở đang mở (<${top}>).`,
          });
        } else {
          issues.push({
            code: "MISMATCHED_CLOSE_TAG",
            tagName: token.name,
            message: `Thẻ đóng </${token.name}> không đúng thứ tự — đang mong đợi </${top}>.`,
          });
          stack.length = idx;
        }
      }
    }
  }

  for (const remaining of stack) {
    issues.push({
      code: "UNCLOSED_TAG",
      tagName: remaining,
      message: `Thẻ <${remaining}> chưa được đóng.`,
    });
  }

  return issues;
}
