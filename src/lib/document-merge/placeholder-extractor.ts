/**
 * Semantic merge-placeholder utilities.
 *
 * New HTML templates use familiar {{Field}} tokens.  Legacy Google Docs and
 * existing published versions use <<Field>>.  Both forms are intentionally
 * accepted and resolve to exactly the same field key, which keeps old template
 * versions renderable while making HTML templates first-class.
 */

/** Matches either {{placeholder}} or <<placeholder>>. */
export const PLACEHOLDER_PATTERN = /(?:<<\s*([^>]+?)\s*>>|\{\{\s*([^{}]+?)\s*\}\})/g;

function placeholderName(match: RegExpMatchArray): string {
  return (match[1] ?? match[2] ?? "").trim();
}

/** Extract unique semantic keys from either supported delimiter style. */
export function extractUniquePlaceholders(content: string): string[] {
  const unique = new Set<string>();
  for (const match of content.matchAll(PLACEHOLDER_PATTERN)) {
    const name = placeholderName(match);
    if (name) unique.add(name);
  }
  return Array.from(unique).sort();
}

/** Check whether a string is exactly one supported placeholder. */
export function isPlaceholder(text: string): boolean {
  return /^(?:<<\s*[^>]+?\s*>>|\{\{\s*[^{}]+?\s*\}\})$/.test(text);
}

/** Extract the first semantic placeholder key from arbitrary text. */
export function extractPlaceholderFromText(text: string): string | null {
  // String#match with a global regex discards capture groups; use a fresh
  // non-global expression so the semantic key is preserved.
  const match = text.match(/(?:<<\s*([^>]+?)\s*>>|\{\{\s*([^{}]+?)\s*\}\})/);
  return match ? placeholderName(match) : null;
}

/** Replace a semantic key in both {{key}} and legacy <<key>> forms. */
export function replacePlaceholder(content: string, placeholder: string, value: string): string {
  const escaped = escapeRegex(placeholder.trim());
  const pattern = new RegExp(`(?:<<\\s*${escaped}\\s*>>|\\{\\{\\s*${escaped}\\s*\\}\\})`, "g");
  return content.replace(pattern, value);
}

/** Replace every supplied semantic key. Values must already be HTML-escaped by the caller. */
export function replaceMultiplePlaceholders(content: string, replacements: Record<string, string>): string {
  let result = content;
  for (const [placeholder, value] of Object.entries(replacements)) {
    result = replacePlaceholder(result, placeholder, value);
  }
  return result;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function getUnmappedPlaceholders(allPlaceholders: string[], mappedPlaceholders: Set<string>): string[] {
  return allPlaceholders.filter((placeholder) => !mappedPlaceholders.has(placeholder));
}

export function hasUnreplacedPlaceholders(content: string): boolean {
  // Do not use a mutable global regex for .test(); callers may invoke this repeatedly.
  return /(?:<<\s*[^>]+?\s*>>|\{\{\s*[^{}]+?\s*\}\})/.test(content);
}

export function countPlaceholders(content: string): number {
  return [...content.matchAll(PLACEHOLDER_PATTERN)].length;
}

/** Conservative validation for database-backed semantic keys. */
export function isValidPlaceholderName(name: string): boolean {
  if (!name || name.length > 255) return false;
  return !/[<>|\\\/:*?"{}]/g.test(name);
}
