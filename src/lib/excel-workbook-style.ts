import "server-only";
import ExcelJS from "exceljs";

/**
 * DOMAIN-AGNOSTIC EXCEL WORKBOOK STYLING (Phase 2B mục 6 — export).
 * ------------------------------------------------------------
 * Extracted from daily-operations-export.ts's single-sheet builder so a
 * MULTI-sheet workbook (e.g. canonical Request Detail export) can reuse the
 * exact same visual style (title row, green header, alternating rows, frozen
 * header, autofilter) per-sheet instead of a second hand-rolled ExcelJS
 * implementation. daily-operations-export.ts's own public API/behavior for
 * its 3 existing callers is unchanged — it now calls addStyledSheet()
 * internally instead of duplicating this logic.
 */

export const EXCEL_GREEN = "FF115830";
export const EXCEL_LIGHT = "FFEFF6F0";

export type StyledSheetColumn<T> = {
  header: string;
  width: number;
  value: (row: T, index: number) => string | number;
};

export function createStyledWorkbook(): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Dalat Hasfarm Seasonal HR";
  wb.created = new Date();
  return wb;
}

/** Adds ONE styled sheet (title row + header row + alternating data rows) to an existing workbook. */
export function addStyledSheet<T>(
  wb: ExcelJS.Workbook,
  opts: { sheetName: string; title: string; columns: StyledSheetColumn<T>[]; rows: T[]; emptyMessage?: string },
): ExcelJS.Worksheet {
  const { sheetName, title, columns, rows, emptyMessage } = opts;
  const ws = wb.addWorksheet(sheetName, { pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1 } });

  ws.mergeCells(1, 1, 1, columns.length);
  ws.getCell(1, 1).value = title;
  ws.getCell(1, 1).font = { bold: true, size: 14, color: { argb: EXCEL_GREEN } };

  const headerRow = ws.getRow(3);
  columns.forEach((col, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = col.header;
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: EXCEL_GREEN } };
    cell.alignment = { horizontal: "center", vertical: "middle" };
  });
  headerRow.commit();

  if (rows.length === 0 && emptyMessage) {
    const emptyRow = ws.getRow(4);
    emptyRow.getCell(1).value = emptyMessage;
    emptyRow.getCell(1).font = { italic: true, color: { argb: "FF6B7F72" } };
    emptyRow.commit();
  } else {
    rows.forEach((row, idx) => {
      const excelRow = ws.getRow(idx + 4);
      excelRow.values = columns.map((col) => col.value(row, idx));
      if (idx % 2 === 1) {
        for (let c = 1; c <= columns.length; c++) {
          excelRow.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: EXCEL_LIGHT } };
        }
      }
      excelRow.commit();
    });
  }

  ws.columns = columns.map((col) => ({ width: col.width }));
  ws.views = [{ state: "frozen", ySplit: 3 }];
  ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: columns.length } };

  return ws;
}

export async function workbookToBuffer(wb: ExcelJS.Workbook): Promise<Buffer> {
  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer as ArrayBuffer);
}
