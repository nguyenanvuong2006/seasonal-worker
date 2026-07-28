import "server-only";
import { parse as parseCsvSync } from "csv-parse/sync";
import * as XLSX from "xlsx";

/**
 * UNIFIED FILE PARSER — 1 pipeline DUY NHẤT đọc file import trong toàn bộ hệ thống
 * (chỉ dùng ở server, xem src/app/api/import/upload/route.ts — client KHÔNG parse file,
 * chỉ upload nguyên file, nên không có chuyện "client parse 1 kiểu, server parse 1 kiểu").
 *
 * NGUYÊN NHÂN GỐC của lỗi hiển thị "ÄĐịa chỉ", "SÄĐT", "Tuá»•i" (mojibake):
 * code cũ gọi `XLSX.read(buf, { type: "buffer" })` cho MỌI loại file, kể cả .csv. SheetJS
 * xử lý .xlsx/.xls (định dạng nhị phân/OOXML — bản thân đã tự mã hoá UTF-8 trong XML) đúng
 * với `type:"buffer"`, nhưng với .csv (văn bản thuần), SheetJS không có cách nào biết bytes
 * đó là UTF-8 nếu không được yêu cầu tường minh — bytes UTF-8 tiếng Việt (2-3 byte/ký tự) bị
 * đọc như thể là Windows-1252/Latin-1 (1 byte/ký tự), ra đúng dạng lỗi "Đ" (UTF-8: C4 90)
 * hiển thị thành "Ä" + ký tự lạ.
 *
 * FIX TẬN GỐC (không phải hack/replace chuỗi): tách rõ 2 pipeline theo ĐÚNG định dạng file:
 *   - .csv  → decode buffer thành chuỗi UTF-8 tường minh (`buf.toString("utf-8")`, tự động
 *             loại BOM nếu có) rồi đưa qua `csv-parse` (thư viện CSV chuyên dụng, đã có sẵn
 *             trong stack — không thêm dependency mới) — không đi qua SheetJS.
 *   - .xlsx/.xls → vẫn dùng SheetJS (đúng công cụ cho định dạng nhị phân/OOXML).
 * Toàn hệ thống thống nhất UTF-8 từ bước đọc file này trở đi — không encode/decode lại ở
 * bất kỳ tầng nào khác (staging, API, React UI đều chỉ truyền nguyên chuỗi UTF-8 đã đúng).
 */
export async function parseImportFile(buf: Buffer, fileName: string): Promise<Record<string, string>[]> {
  const ext = fileName.toLowerCase().split(".").pop();

  if (ext === "csv") {
    // Bỏ BOM (U+FEFF) nếu có — Excel/Google Sheets thường xuất CSV kèm BOM UTF-8.
    let text = buf.toString("utf-8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

    const records: Record<string, string>[] = parseCsvSync(text, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
      bom: true,
    });
    return records.map((r) => {
      const obj: Record<string, string> = {};
      for (const k of Object.keys(r)) obj[k] = String(r[k] ?? "");
      return obj;
    });
  }

  // .xlsx / .xls — định dạng nhị phân, dùng SheetJS (KHÔNG dùng cho .csv, xem ghi chú ở trên).
  const wb = XLSX.read(buf, { type: "buffer" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const parsed = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: false });
  return parsed.map((r) => {
    const obj: Record<string, string> = {};
    for (const k of Object.keys(r)) obj[k] = String(r[k] ?? "");
    return obj;
  });
}
