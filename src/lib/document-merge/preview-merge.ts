/**
 * Pure preview / fallback helpers for Document Merge.
 * Used by the Preview API and unit tests — no I/O.
 */

import {
  extractUniquePlaceholders,
  replaceMultiplePlaceholders,
} from "./placeholder-extractor.ts";
import { PAGE_BREAK_TEXT } from "./google-docs-service.ts";
import {
  FALLBACK_PLACEHOLDER_MAP,
  CUSTOM_ANSWER_PLACEHOLDER_MAP,
} from "./placeholder-aliases.ts";

// Re-exported for backward compatibility (existing callers / tests import these
// aliases from preview-merge.ts). The authoritative definitions now live in the
// dependency-free placeholder-aliases.ts, which the Template Diff Engine reuses.
export { FALLBACK_PLACEHOLDER_MAP, CUSTOM_ANSWER_PLACEHOLDER_MAP };

function readPath(record: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = record;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function asDisplayString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${d}/${m}/${y}`;
  }
  if (typeof value === "object") return "";
  return String(value);
}

/**
 * Fill unmapped placeholders from well-known aliases on the flattened record.
 * Existing mapped values win — fallback never overwrites a non-empty mapping.
 */
export function applyFallbackPlaceholders(
  record: Record<string, unknown>,
  existing: Record<string, string> = {},
): Record<string, string> {
  const result = { ...existing };

  for (const [placeholder, field] of Object.entries(FALLBACK_PLACEHOLDER_MAP)) {
    if (result[placeholder]?.trim()) continue;
    const direct = record[placeholder];
    const mapped = readPath(record, field);
    const value = asDisplayString(direct ?? mapped);
    if (value) result[placeholder] = value;
  }

  const custom = record.customAnswers;
  if (custom && typeof custom === "object" && !Array.isArray(custom)) {
    const customRecord = custom as Record<string, unknown>;
    for (const [placeholder, fieldKey] of Object.entries(CUSTOM_ANSWER_PLACEHOLDER_MAP)) {
      if (result[placeholder]?.trim()) continue;
      const value = asDisplayString(customRecord[fieldKey]);
      if (value) result[placeholder] = value;
    }
    for (const [key, raw] of Object.entries(customRecord)) {
      if (!result[key]?.trim()) {
        const value = asDisplayString(raw);
        if (value) result[key] = value;
      }
    }
  }

  // Also expose flattened core fields under their own names.
  for (const key of [
    "fullName",
    "cccd",
    "dob",
    "gender",
    "phone",
    "permanentAddress",
    "residentialAddress",
    "dateOfIssue",
    "placeOfIssue",
    "code",
    "email",
    "deptName",
    "groupName",
    "location",
    "startingDate",
    "regDate",
  ]) {
    if (!result[key]?.trim()) {
      const value = asDisplayString(record[key]);
      if (value) result[key] = value;
    }
  }

  return result;
}

export function buildPreviewContent(
  templateContent: string,
  fieldValues: Record<string, string>,
): { content: string; unreplaced: string[] } {
  const content = replaceMultiplePlaceholders(templateContent, fieldValues);
  return {
    content,
    unreplaced: extractUniquePlaceholders(content),
  };
}

export function joinWithPageBreaks(sections: string[]): string {
  return sections.filter((section) => section.trim().length > 0).join(PAGE_BREAK_TEXT);
}

export function countPageBreaks(content: string): number {
  if (!content) return 0;
  // Đếm theo đúng hằng số `PAGE_BREAK_TEXT` (cùng dòng với `joinWithPageBreaks`)
  // để tránh lệch khi cấu trúc marker đổi. Marker cũ "--- PAGE BREAK ---" đã
  // được thay bằng `--- DOCUMENT_MERGE_PAGE_BREAK ---` để tăng uniqueness.
  return content.split(PAGE_BREAK_TEXT).length - 1;
}
