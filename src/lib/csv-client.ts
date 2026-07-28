/**
 * Parser CSV chạy ngay trên trình duyệt (không cần cài thư viện, không cần Node.js
 * trên máy người dùng). Hỗ trợ dấu ngoặc kép bao quanh field có chứa dấu phẩy/xuống
 * dòng (đúng chuẩn RFC 4180), giống định dạng CSV xuất ra từ Google Sheets.
 */
export function parseCsvClient(text: string): Record<string, string>[] {
  // Bỏ BOM nếu có (Google Sheets thường xuất kèm BOM)
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c === "\r") {
      // bỏ qua, \n sẽ xử lý xuống dòng
    } else {
      field += c;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  const dataRows = rows.filter((r) => r.some((v) => v.trim() !== ""));
  if (dataRows.length === 0) return [];
  const header = dataRows[0];
  return dataRows.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    header.forEach((h, idx) => {
      obj[h] = r[idx] ?? "";
    });
    return obj;
  });
}

export function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Đọc file .csv HOẶC .xlsx/.xls ngay trên trình duyệt và trả về cùng 1 định dạng
 * Record<string,string>[] (khoá = tên cột ở hàng đầu tiên) — để phần còn lại của
 * app (batch, gửi lên /api/admin/import-data) không cần quan tâm định dạng gốc.
 * Dùng thư viện "xlsx" (SheetJS) — chỉ chạy trong trình duyệt, không cần cài gì
 * trên máy người dùng.
 */
export async function parseSpreadsheetFile(file: File): Promise<Record<string, string>[]> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
    const XLSX = await import("xlsx");
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: false });
    return rows.map((r) => {
      const obj: Record<string, string> = {};
      for (const k of Object.keys(r)) obj[k] = String(r[k] ?? "");
      return obj;
    });
  }
  const text = await file.text();
  return parseCsvClient(text);
}
