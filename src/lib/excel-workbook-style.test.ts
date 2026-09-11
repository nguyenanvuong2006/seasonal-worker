import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { loadModule, serverOnlyStub } from "./test-support/load-module.ts";

/**
 * Domain-agnostic Excel styling primitive (Phase 2B mục 6) — dùng thật
 * ExcelJS (không mock), đọc lại buffer để chứng minh title/header/rows/
 * multi-sheet đều đúng, và sheet rỗng dùng emptyMessage khi được truyền.
 *
 * Nạp qua loadModule() (như mọi module "server-only" khác trong repo) vì
 * import "server-only" trực tiếp ngoài Next.js runtime sẽ throw.
 */

function loadStyleModule() {
  return loadModule(new URL("./excel-workbook-style.ts", import.meta.url), {
    stubs: { "server-only": serverOnlyStub, exceljs: ExcelJS },
  }) as {
    createStyledWorkbook: () => ExcelJS.Workbook;
    addStyledSheet: <T>(wb: ExcelJS.Workbook, opts: { sheetName: string; title: string; columns: { header: string; width: number; value: (row: T, i: number) => string | number }[]; rows: T[]; emptyMessage?: string }) => ExcelJS.Worksheet;
    workbookToBuffer: (wb: ExcelJS.Workbook) => Promise<Buffer>;
  };
}

test("addStyledSheet: title + header + rows đúng, nhiều sheet trong cùng workbook", async () => {
  const { createStyledWorkbook, addStyledSheet, workbookToBuffer } = loadStyleModule();
  const wb = createStyledWorkbook();
  addStyledSheet(wb, {
    sheetName: "Sheet A",
    title: "Tiêu đề A",
    columns: [
      { header: "Tên", width: 20, value: (r: { name: string; qty: number }) => r.name },
      { header: "Số lượng", width: 10, value: (r: { name: string; qty: number }) => r.qty },
    ],
    rows: [{ name: "X", qty: 1 }, { name: "Y", qty: 2 }],
  });
  addStyledSheet(wb, {
    sheetName: "Sheet B (empty)",
    title: "Tiêu đề B",
    columns: [{ header: "Cột", width: 10, value: (r: unknown) => String(r) }],
    rows: [],
    emptyMessage: "(Không có dữ liệu)",
  });

  const buffer = await workbookToBuffer(wb);
  assert.ok(buffer.length > 0);

  const readBack = new ExcelJS.Workbook();
  await readBack.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  assert.equal(readBack.worksheets.length, 2);

  const wsA = readBack.getWorksheet("Sheet A")!;
  assert.equal(wsA.getCell(1, 1).value, "Tiêu đề A");
  assert.equal(wsA.getCell(3, 1).value, "Tên");
  assert.equal(wsA.getCell(3, 2).value, "Số lượng");
  assert.equal(wsA.getCell(4, 1).value, "X");
  assert.equal(wsA.getCell(4, 2).value, 1);
  assert.equal(wsA.getCell(5, 1).value, "Y");
  assert.equal(wsA.getCell(5, 2).value, 2);

  const wsB = readBack.getWorksheet("Sheet B (empty)")!;
  assert.equal(wsB.getCell(4, 1).value, "(Không có dữ liệu)");
});

test("addStyledSheet: sheet rỗng KHÔNG có emptyMessage -> không synthesize hàng nào (giữ hành vi cũ cho daily-operations-export)", async () => {
  const { createStyledWorkbook, addStyledSheet, workbookToBuffer } = loadStyleModule();
  const wb = createStyledWorkbook();
  addStyledSheet(wb, {
    sheetName: "Sheet Empty",
    title: "T",
    columns: [{ header: "Cột", width: 10, value: (r: unknown) => String(r) }],
    rows: [],
  });
  const buffer = await workbookToBuffer(wb);
  const readBack = new ExcelJS.Workbook();
  await readBack.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const ws = readBack.getWorksheet("Sheet Empty")!;
  assert.equal(ws.getCell(4, 1).value, null);
});
