/**
 * AI TEMPLATE LAYOUT SCANNER (H1) — advisory, read-only detection of print
 * layout patterns that are risky specifically AROUND a dynamic placeholder
 * (candidate data varies in length: short data should sit on one line, long
 * data should wrap and let its container grow, pushing following content
 * down — never get clipped, overlap, or force a fixed page count).
 *
 * HEURISTIC CSS RESOLUTION (documented limitation, intentional):
 * this module does NOT implement real CSS cascade/specificity. A rule's
 * declarations apply to an element if the rule's selector chain matches the
 * element's ancestor stack (descendant-only matching — child/sibling
 * combinators are treated as "somewhere in the ancestor chain", which is a
 * conservative over-match, not an under-match). Matching rules apply in
 * source order (later wins on the same property); inline `style="..."`
 * always wins last, matching real authoring intent for a print template
 * authored primarily by pasting HTML/CSS rather than a large stylesheet with
 * competing specificity. This is sufficient for advisory warnings; it is not
 * a browser and must never be treated as ground truth for what will render.
 *
 * PLACEHOLDER-GATING (the important product rule): height/overflow/nowrap/
 * absolute-position warnings ONLY fire for an element whose subtree actually
 * contains a placeholder token. A fixed-height photo box or a blank
 * signature-space cell with no placeholder inside is never flagged — see
 * tests. Table-width and global break-inside warnings are structural and are
 * NOT placeholder-gated (they are risky regardless of what is inside).
 */

import { tokenizeHtml, type HtmlToken } from "./html-scanner.ts";
import { parseCss, type CssDeclaration, type CssRule } from "./css-scanner.ts";
import { extractUniquePlaceholders } from "./placeholder-extractor.ts";

export type LayoutWarningCode =
  | "FIXED_HEIGHT_DYNAMIC_CONTENT"
  | "OVERFLOW_HIDDEN_DYNAMIC_CONTENT"
  | "NOWRAP_DYNAMIC_CONTENT"
  | "ABSOLUTE_POSITION_DYNAMIC_CONTENT"
  | "TABLE_WIDTH_EXCEEDS_A4"
  | "GLOBAL_BREAK_INSIDE_AVOID";

export interface LayoutWarning {
  code: LayoutWarningCode;
  message: string;
  /** Tag name of the offending element, when applicable. */
  tagName?: string;
  /** Placeholder(s) affected, when the warning is placeholder-gated. */
  placeholders?: string[];
}

interface SimpleSelector {
  tag: string | null;
  id: string | null;
  classes: string[];
}

function parseSimpleSelector(chunk: string): SimpleSelector {
  const tagMatch = chunk.match(/^[a-zA-Z][\w-]*/);
  const tag = tagMatch ? tagMatch[0].toLowerCase() : null;
  const idMatch = chunk.match(/#([\w-]+)/);
  const classes = [...chunk.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
  return { tag, id: idMatch ? idMatch[1] : null, classes };
}

/** Split a full selector into ordered compound-selector chunks (descendant chain). */
function splitSelectorChain(selector: string): SimpleSelector[] {
  return selector
    .trim()
    .split(/\s*[>+~]\s*|\s+/)
    .filter(Boolean)
    .map(parseSimpleSelector);
}

interface ElementFrame {
  tagName: string;
  id: string | null;
  classes: string[];
}

function selectorMatchesElement(sel: SimpleSelector, el: ElementFrame): boolean {
  if (sel.tag && sel.tag !== el.tagName) return false;
  if (sel.id && sel.id !== el.id) return false;
  if (sel.classes.length > 0 && !sel.classes.every((c) => el.classes.includes(c))) return false;
  if (!sel.tag && !sel.id && sel.classes.length === 0) return false;
  return true;
}

/** Does the selector chain match, ending at the current (last) element in the stack? */
function selectorChainMatches(chain: SimpleSelector[], stack: ElementFrame[]): boolean {
  if (chain.length === 0 || stack.length === 0) return false;
  const last = chain[chain.length - 1];
  const current = stack[stack.length - 1];
  if (!selectorMatchesElement(last, current)) return false;

  let stackIdx = stack.length - 2;
  for (let chainIdx = chain.length - 2; chainIdx >= 0; chainIdx -= 1) {
    let found = false;
    while (stackIdx >= 0) {
      if (selectorMatchesElement(chain[chainIdx], stack[stackIdx])) {
        found = true;
        stackIdx -= 1;
        break;
      }
      stackIdx -= 1;
    }
    if (!found) return false;
  }
  return true;
}

function parseInlineStyle(styleAttr: string | null): CssDeclaration[] {
  if (!styleAttr) return [];
  return styleAttr
    .split(";")
    .map((part) => {
      const colon = part.indexOf(":");
      if (colon === -1) return null;
      const property = part.slice(0, colon).trim().toLowerCase();
      const value = part.slice(colon + 1).trim();
      return property ? { property, value } : null;
    })
    .filter((d): d is CssDeclaration => d !== null);
}

/** Resolve the effective declarations for an element given its ancestor stack + parsed CSS rules. */
function resolveDeclarations(
  stack: ElementFrame[],
  rules: CssRule[],
  inlineStyle: CssDeclaration[],
): Map<string, string> {
  const resolved = new Map<string, string>();
  for (const rule of rules) {
    const matches = rule.selectors.some((sel) => selectorChainMatches(splitSelectorChain(sel), stack));
    if (!matches) continue;
    for (const decl of rule.declarations) resolved.set(decl.property, decl.value);
  }
  for (const decl of inlineStyle) resolved.set(decl.property, decl.value);
  return resolved;
}

const FIXED_LENGTH_RE = /^-?\d*\.?\d+(px|pt|mm|cm|in|pc)$/i;

function isFixedLength(value: string): boolean {
  return FIXED_LENGTH_RE.test(value.trim());
}

function toMillimeters(value: string): number | null {
  const m = value.trim().match(/^(-?\d*\.?\d+)(px|pt|mm|cm|in|pc)$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  switch (unit) {
    case "mm": return n;
    case "cm": return n * 10;
    case "in": return n * 25.4;
    case "pt": return (n * 25.4) / 72;
    case "pc": return (n * 25.4) / 6;
    case "px": return (n * 25.4) / 96;
    default: return null;
  }
}

/** Printable A4 width used by A4_PRINT_CSS (210mm - 12mm - 12mm margins), with a small tolerance. */
const A4_PRINTABLE_WIDTH_MM = 210 - 12 - 12;
const WIDTH_WARNING_THRESHOLD_MM = A4_PRINTABLE_WIDTH_MM + 4; // small tolerance before warning

/**
 * Physical A4 page width. An element that IS the page wrapper itself (see
 * PAGE_CONTAINER_CLASSES below) legitimately spans this width — it is the
 * printed sheet, not content that must additionally fit inside the printable
 * area after margins. Distinct, wider tolerance than WIDTH_WARNING_THRESHOLD_MM.
 */
const A4_PAGE_WIDTH_MM = 210;
const PAGE_WIDTH_WARNING_THRESHOLD_MM = A4_PAGE_WIDTH_MM + 4;

/**
 * Elements carrying one of these classes are treated as the physical A4 page
 * container — the SAME class convention `countCanonicalPages()` (in
 * canonical-document.ts) already uses to count pages ("the historical
 * canonical body used `.page`; the operator-provided test(2).html body (v7)
 * uses the authoring shell's `.paper` marker. Both are recognised"). A
 * `.page`/`.paper` element at ~210mm is the page itself, not a content block
 * that must fit inside the printable width — see PHASE 8 (A4 width model).
 */
const PAGE_CONTAINER_CLASSES = new Set(["page", "paper"]);

function isPageContainerElement(el: { classes: string[] }): boolean {
  return el.classes.some((c) => PAGE_CONTAINER_CLASSES.has(c));
}

/** "Broad" selector = would match many/most elements, making a break-inside:avoid dangerous. */
function isBroadSelector(selector: string): boolean {
  return splitSelectorChain(selector).some((chunk) => {
    if (chunk.id || chunk.classes.length > 0) return false; // scoped — never broad
    return chunk.tag === null || ["*", "html", "body", "div", "td", "tr", "p", "table", "span", "section"].includes(chunk.tag);
  }) || selector.trim() === "*";
}

export function analyzeTemplateLayout(html: string, css: string): LayoutWarning[] {
  const warnings: LayoutWarning[] = [];
  const tokens = tokenizeHtml(html ?? "");
  const { rules } = parseCss(css ?? "");

  type Frame = ElementFrame & { containsPlaceholder: boolean; placeholders: Set<string>; declarations: Map<string, string> };
  const stack: Frame[] = [];

  const markPlaceholderOnStack = (placeholders: string[]) => {
    for (const frame of stack) {
      frame.containsPlaceholder = true;
      for (const p of placeholders) frame.placeholders.add(p);
    }
  };

  const evaluateFrame = (frame: Frame) => {
    const decl = frame.declarations;
    const placeholders = [...frame.placeholders];

    if (frame.containsPlaceholder) {
      const height = decl.get("height");
      if (height && isFixedLength(height)) {
        warnings.push({
          code: "FIXED_HEIGHT_DYNAMIC_CONTENT",
          message: `<${frame.tagName}> có height cố định (${height}) nhưng chứa dữ liệu động (${placeholders.join(", ")}) — dữ liệu dài có thể bị tràn/che khuất. Dùng min-height thay vì height, hoặc bỏ height để ô tự giãn theo nội dung.`,
          tagName: frame.tagName,
          placeholders,
        });
      }
      const overflow = decl.get("overflow") ?? decl.get("overflow-y");
      if (overflow && /hidden/i.test(overflow)) {
        warnings.push({
          code: "OVERFLOW_HIDDEN_DYNAMIC_CONTENT",
          message: `<${frame.tagName}> có overflow:hidden nhưng chứa dữ liệu động (${placeholders.join(", ")}) — dữ liệu dài sẽ bị CẮT MẤT thay vì xuống dòng. Bỏ overflow:hidden quanh vùng dữ liệu động.`,
          tagName: frame.tagName,
          placeholders,
        });
      }
      const whiteSpace = decl.get("white-space");
      if (whiteSpace && /nowrap/i.test(whiteSpace)) {
        warnings.push({
          code: "NOWRAP_DYNAMIC_CONTENT",
          message: `<${frame.tagName}> có white-space:nowrap nhưng chứa dữ liệu động (${placeholders.join(", ")}) — địa chỉ/tên dài sẽ tràn ra ngoài thay vì xuống dòng tự nhiên.`,
          tagName: frame.tagName,
          placeholders,
        });
      }
      const position = decl.get("position");
      if (position && /^(absolute|fixed)$/i.test(position.trim())) {
        warnings.push({
          code: "ABSOLUTE_POSITION_DYNAMIC_CONTENT",
          message: `<${frame.tagName}> dùng position:${position.trim()} nhưng chứa dữ liệu động (${placeholders.join(", ")}) — dữ liệu dài có thể đè lên nội dung khác vì không tham gia dòng chảy layout bình thường.`,
          tagName: frame.tagName,
          placeholders,
        });
      }
    }

    const width = decl.get("width");
    if (width && isFixedLength(width)) {
      const mm = toMillimeters(width);
      if (mm !== null) {
        // PAGE_CONTAINER (.page/.paper — the A4 sheet itself) is legitimately
        // ~210mm; only CONTENT/DYNAMIC_CONTENT_BLOCK elements must fit inside
        // the printable area (~186mm after 12mm margins each side).
        if (isPageContainerElement(frame)) {
          if (mm > PAGE_WIDTH_WARNING_THRESHOLD_MM) {
            warnings.push({
              code: "TABLE_WIDTH_EXCEEDS_A4",
              message: `<${frame.tagName}> (khối trang .page/.paper) có width=${width} (~${mm.toFixed(0)}mm), vượt cả khổ giấy A4 vật lý (~${A4_PAGE_WIDTH_MM}mm) — kiểm tra lại kích thước khối trang.`,
              tagName: frame.tagName,
            });
          }
        } else if (mm > WIDTH_WARNING_THRESHOLD_MM) {
          warnings.push({
            code: "TABLE_WIDTH_EXCEEDS_A4",
            message: `<${frame.tagName}> có width=${width} (~${mm.toFixed(0)}mm), vượt vùng in A4 (~${A4_PRINTABLE_WIDTH_MM}mm sau margin 12mm mỗi bên) — nội dung có thể bị cắt khi in.`,
            tagName: frame.tagName,
          });
        }
      }
    }
  };

  for (const token of tokens) {
    if (token.type === "open-tag") {
      const idAttr = token.attrs.find((a) => a.name === "id")?.value ?? null;
      const classAttr = token.attrs.find((a) => a.name === "class")?.value ?? "";
      const styleAttr = token.attrs.find((a) => a.name === "style")?.value ?? null;
      const el: ElementFrame = { tagName: token.name, id: idAttr, classes: classAttr.split(/\s+/).filter(Boolean) };

      if (token.selfClosing) {
        // No subtree; still worth a width check for e.g. <img style="width:...">.
        const declarations = resolveDeclarations([...stack, el], rules, parseInlineStyle(styleAttr));
        evaluateFrame({ ...el, containsPlaceholder: false, placeholders: new Set(), declarations });
        continue;
      }

      const declarations = resolveDeclarations([...stack, el], rules, parseInlineStyle(styleAttr));
      stack.push({ ...el, containsPlaceholder: false, placeholders: new Set(), declarations });
      continue;
    }

    if (token.type === "close-tag") {
      // Pop the nearest matching open frame (tolerant of already-reported mismatches).
      const idx = [...stack].reverse().findIndex((f) => f.tagName === token.name);
      if (idx === -1) continue;
      const realIdx = stack.length - 1 - idx;
      const [frame] = stack.splice(realIdx, 1);
      evaluateFrame(frame);
      continue;
    }

    if (token.type === "text") {
      const placeholders = extractUniquePlaceholders(token.content);
      if (placeholders.length > 0) markPlaceholderOnStack(placeholders);
    }
  }

  // Any still-open frames at EOF (malformed HTML) — evaluate them too so a
  // warning is not silently lost just because the document was truncated.
  for (const frame of stack) evaluateFrame(frame);

  // Global break-inside: structural, not placeholder-gated.
  for (const rule of rules) {
    const breakValue = rule.declarations.find((d) => /^(break-inside|page-break-inside)$/i.test(d.property))?.value;
    if (!breakValue || !/avoid/i.test(breakValue)) continue;
    for (const selector of rule.selectors) {
      if (isBroadSelector(selector)) {
        warnings.push({
          code: "GLOBAL_BREAK_INSIDE_AVOID",
          message: `Quy tắc CSS "${selector} { ${breakValue.includes("page-break") ? "page-break-inside" : "break-inside"}: ${breakValue} }" áp dụng RỘNG (không giới hạn class/id cụ thể) — có thể ép 1 khối chứa dữ liệu dài không được ngắt trang, gây tràn/mất nội dung. Giới hạn quy tắc này vào 1 class cụ thể (vd .signature-block) thay vì áp dụng toàn cục.`,
        });
      }
    }
  }

  return warnings;
}
