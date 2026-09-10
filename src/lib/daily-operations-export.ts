import "server-only";
import ExcelJS from "exceljs";

/**
 * DAILY OPERATIONS — shared Excel export builder ("Vận hành trong ngày":
 * Nhập mã công nhật / IT Code-Vân tay / Báo cơm). ONE workbook-styling
 * implementation instead of three near-identical ExcelJS blocks — each
 * route only supplies its own headers/rows/filename; RBAC + Data Scope +
 * the current list filters are still the caller's responsibility (this
 * module never queries the database itself, it only renders rows already
 * fetched through the SAME canonical, authorized query the on-screen list
 * uses — see each route's own doc comment for its canonical service).
 */

const GREEN = "FF115830";
const LIGHT = "FFEFF6F0";

export type ExportColumn<T> = {
  header: string;
  width: number;
  value: (row: T, index: number) => string | number;
};

export async function buildDailyOperationsWorkbook<T>(opts: {
  sheetName: string;
  title: string;
  columns: ExportColumn<T>[];
  rows: T[];
}): Promise<Buffer> {
  const { sheetName, title, columns, rows } = opts;
  const wb = new ExcelJS.Workbook();
  wb.creator = "Dalat Hasfarm Seasonal HR";
  wb.created = new Date();
  const ws = wb.addWorksheet(sheetName, { pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1 } });

  ws.mergeCells(1, 1, 1, columns.length);
  ws.getCell(1, 1).value = title;
  ws.getCell(1, 1).font = { bold: true, size: 14, color: { argb: GREEN } };

  const headerRow = ws.getRow(3);
  columns.forEach((col, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = col.header;
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: GREEN } };
    cell.alignment = { horizontal: "center", vertical: "middle" };
  });
  headerRow.commit();

  rows.forEach((row, idx) => {
    const excelRow = ws.getRow(idx + 4);
    excelRow.values = columns.map((col) => col.value(row, idx));
    if (idx % 2 === 1) {
      for (let c = 1; c <= columns.length; c++) {
        excelRow.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: LIGHT } };
      }
    }
    excelRow.commit();
  });

  ws.columns = columns.map((col) => ({ width: col.width }));
  ws.views = [{ state: "frozen", ySplit: 3 }];
  ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: columns.length } };

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer as ArrayBuffer);
}

export function exportFilenameHeaders(baseName: string, date: string): Record<string, string> {
  const ascii = baseName;
  const utf8 = encodeURIComponent(`${baseName}-${date}.xlsx`);
  return {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="${ascii}-${date}.xlsx"; filename*=UTF-8''${utf8}`,
  };
}
