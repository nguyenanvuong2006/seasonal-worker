/** Tiện ích thuần cho bảng copy/paste; dùng được ở client và trong unit test. */

/**
 * Đọc dữ liệu clipboard từ Excel/Google Sheets. Clipboard của bảng tính dùng
 * tab giữa các ô và xuống dòng giữa các hàng; parser vẫn tôn trọng dấu ngoặc
 * kép để không làm vỡ ô có tab/xuống dòng bên trong.
 */
export function parseClipboardTable(text: string): string[][] {
  const input = String(text ?? "").replace(/^\uFEFF/, "");
  if (!input) return [];

  const delimiter = input.includes("\t") ? "\t" : null;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"' && cell.length === 0) {
      quoted = true;
    } else if (delimiter && char === delimiter) {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  row.push(cell.replace(/\r$/, ""));
  rows.push(row);

  // Excel thường thêm đúng một newline cuối clipboard; không tạo hàng rỗng giả.
  while (rows.length > 0 && rows[rows.length - 1].every((value) => value === "")) rows.pop();
  return rows;
}

export function escapeCsvCell(value: string): string {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

export function serializeCsv(headers: string[], rows: string[][]): string {
  return (
    "\uFEFF" +
    [headers, ...rows]
      .map((row) => row.map((value) => escapeCsvCell(value)).join(","))
      .join("\r\n") +
    "\r\n"
  );
}

export function normalizeGridHeader(value: string): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * Quyết định cột đích mà không làm lệch dữ liệu. Với header, matchedIds giữ
 * nguyên vị trí mọi cột nguồn nhưng cột đang ẩn thành null. Không có header thì
 * vùng copy rộng hơn phần bảng còn lại bị từ chối thay vì âm thầm cắt bớt.
 */
export function resolvePasteTargetIds({
  copiedColumnCount,
  hasHeader,
  matchedIds,
  visibleIds,
  startColumn,
}: {
  copiedColumnCount: number;
  hasHeader: boolean;
  matchedIds: (string | null)[];
  visibleIds: string[];
  startColumn: number;
}): { targetIds: (string | null)[]; error: string | null } {
  if (hasHeader) {
    const visibleSet = new Set(visibleIds);
    return {
      targetIds: matchedIds.map((id) => id && visibleSet.has(id) ? id : null),
      error: null,
    };
  }

  const available = Math.max(0, visibleIds.length - startColumn);
  if (copiedColumnCount > available) {
    return {
      targetIds: [],
      error: `Vùng copy có ${copiedColumnCount} cột nhưng bảng chỉ còn ${available} cột. Hãy copy kèm hàng tiêu đề để hệ thống ghép đúng cột.`,
    };
  }
  return {
    targetIds: Array.from({ length: copiedColumnCount }, (_, index) => visibleIds[startColumn + index] ?? null),
    error: null,
  };
}
