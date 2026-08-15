/**
 * Pure preview / fallback helpers for Document Merge.
 * Used by the Preview API and unit tests — no I/O.
 */

import {
  extractUniquePlaceholders,
  replaceMultiplePlaceholders,
} from "./placeholder-extractor.ts";
import { PAGE_BREAK_TEXT } from "./google-docs-service.ts";

/** Common Vietnamese / English placeholder aliases → record field. */
export const FALLBACK_PLACEHOLDER_MAP: Record<string, string> = {
  Ho_ten: "fullName",
  HoTen: "fullName",
  ho_ten: "fullName",
  fullName: "fullName",
  Full_Name: "fullName",
  So_CCCD: "cccd",
  SoCCCD: "cccd",
  CCCD: "cccd",
  cccd: "cccd",
  Ngay_sinh: "dob",
  NgaySinh: "dob",
  dob: "dob",
  Date_of_birth: "dob",
  Gioi_tinh: "gender",
  GioiTinh: "gender",
  gender: "gender",
  So_dien_thoai: "phone",
  SoDienThoai: "phone",
  Dien_thoai: "phone",
  phone: "phone",
  Dia_chi: "residentialAddress",
  DiaChi: "residentialAddress",
  Dia_chi_hien_tai: "residentialAddress",
  residentialAddress: "residentialAddress",
  Dia_chi_thuong_tru: "permanentAddress",
  permanentAddress: "permanentAddress",
  Ngay_dang_ky: "regDate",
  NgayDangKy: "regDate",
  regDate: "regDate",
  Ngay_nhan_viec: "startingDate",
  NgayNhanViec: "startingDate",
  startingDate: "startingDate",
  Bo_phan: "deptName",
  BoPhan: "deptName",
  deptName: "deptName",
  Nhom: "groupName",
  groupName: "groupName",
  Ma_DW: "dwCode",
  dwCode: "dwCode",
  IT_CODE: "itCode",
  itCode: "itCode",
};

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

  // Also expose flattened core fields under their own names.
  for (const key of ["fullName", "cccd", "dob", "gender", "phone", "deptName", "groupName", "startingDate", "regDate"]) {
    if (!result[key]?.trim()) {
      const value = asDisplayString(record[key]);
      if (value) result[key] = value;
    }
  }

  const custom = record.customAnswers;
  if (custom && typeof custom === "object" && !Array.isArray(custom)) {
    for (const [key, raw] of Object.entries(custom as Record<string, unknown>)) {
      if (!result[key]?.trim()) {
        const value = asDisplayString(raw);
        if (value) result[key] = value;
      }
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
  return content.split("--- PAGE BREAK ---").length - 1;
}
