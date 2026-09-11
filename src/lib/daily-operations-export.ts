import "server-only";
import { addStyledSheet, createStyledWorkbook, workbookToBuffer, type StyledSheetColumn } from "./excel-workbook-style";

/**
 * DAILY OPERATIONS — shared Excel export builder ("Vận hành trong ngày":
 * Nhập mã công nhật / IT Code-Vân tay / Báo cơm). ONE workbook-styling
 * implementation instead of three near-identical ExcelJS blocks — each
 * route only supplies its own headers/rows/filename; RBAC + Data Scope +
 * the current list filters are still the caller's responsibility (this
 * module never queries the database itself, it only renders rows already
 * fetched through the SAME canonical, authorized query the on-screen list
 * uses — see each route's own doc comment for its canonical service).
 *
 * The actual per-sheet styling (title/header/alternating rows) now lives in
 * the domain-agnostic excel-workbook-style.ts (Phase 2B mục 6 — reused by
 * the canonical Request Detail export, which needs MULTIPLE sheets). This
 * module's own public API/behavior is unchanged for its 3 existing callers.
 */

export type ExportColumn<T> = StyledSheetColumn<T>;

export async function buildDailyOperationsWorkbook<T>(opts: {
  sheetName: string;
  title: string;
  columns: ExportColumn<T>[];
  rows: T[];
}): Promise<Buffer> {
  const wb = createStyledWorkbook();
  addStyledSheet(wb, opts);
  return workbookToBuffer(wb);
}

export function exportFilenameHeaders(baseName: string, date: string): Record<string, string> {
  const ascii = baseName;
  const utf8 = encodeURIComponent(`${baseName}-${date}.xlsx`);
  return {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="${ascii}-${date}.xlsx"; filename*=UTF-8''${utf8}`,
  };
}
