/**
 * UNIFIED DATE/TIME PARSER
 * -------------------------
 * NGUYÊN NHÂN GỐC của lỗi "invalid input syntax for type timestamp with time zone:
 * 13/08/2024 07:08:45T00:00:00+07:00": import-jobs.ts (giai đoạn MERGING) nối chuỗi
 * `reg_date_raw || 'T00:00:00+07:00'` trực tiếp trong SQL, giả định `reg_date_raw` luôn
 * ở dạng `YYYY-MM-DD` — nhưng dữ liệu staging (từ file gốc) có thể ở `dd/MM/yyyy HH:mm:ss`
 * hoặc nhiều định dạng khác, chưa từng được chuẩn hoá trước khi staging.
 *
 * FIX TẬN GỐC: 1 parser DUY NHẤT, chạy ở tầng ứng dụng (TypeScript) TẠI THỜI ĐIỂM STAGING
 * (trước khi ghi vào staging_*), để cột ngày trong staging LUÔN là ISO hợp lệ hoặc NULL.
 * SQL ở giai đoạn MERGING chỉ còn CAST trực tiếp (`::date`, `::timestamptz`), không còn
 * nối chuỗi thủ công ở bất kỳ đâu.
 */

export type ParsedDateTime = {
  /** yyyy-MM-dd — luôn hợp lệ, dùng cho cột `date`. */
  dateOnly: string;
  /** ISO 8601 đầy đủ (có giờ, có timezone) — dùng cho cột `timestamptz`. */
  iso: string;
};

const PATTERNS: { re: RegExp; build: (m: RegExpMatchArray) => ParsedDateTime | null }[] = [
  // ISO 8601 (có thể có 'T' hoặc khoảng trắng, có hoặc không có giờ/timezone) — thử trước tiên.
  {
    re: /^(\d{4})-(\d{2})-(\d{2})([T ](\d{2}):(\d{2})(:(\d{2}))?)?(Z|[+-]\d{2}:?\d{2})?$/,
    build: (m) => {
      const [, y, mo, d, , h, mi, , s] = m;
      if (!isValidYmd(+y, +mo, +d)) return null;
      const hh = h ?? "00";
      const mm = mi ?? "00";
      const ss = s ?? "00";
      return { dateOnly: `${y}-${mo}-${d}`, iso: `${y}-${mo}-${d}T${hh}:${mm}:${ss}+07:00` };
    },
  },
  // dd/MM/yyyy [HH:mm[:ss]]
  {
    re: /^(\d{1,2})\/(\d{1,2})\/(\d{4})(\s+(\d{1,2}):(\d{2})(:(\d{2}))?)?$/,
    build: (m) => {
      const [, d, mo, y, , h, mi, , s] = m;
      if (!isValidYmd(+y, +mo, +d)) return null;
      const dd = d.padStart(2, "0");
      const mm2 = mo.padStart(2, "0");
      const hh = (h ?? "00").padStart(2, "0");
      const mi2 = (mi ?? "00").padStart(2, "0");
      const ss = (s ?? "00").padStart(2, "0");
      return { dateOnly: `${y}-${mm2}-${dd}`, iso: `${y}-${mm2}-${dd}T${hh}:${mi2}:${ss}+07:00` };
    },
  },
  // Excel serial date number (SheetJS đôi khi trả số thay vì chuỗi khi cell định dạng Date).
  {
    re: /^\d{4,6}(\.\d+)?$/,
    build: (m) => {
      const serial = parseFloat(m[0]);
      if (serial < 1 || serial > 100000) return null; // ngoài phạm vi hợp lý — không phải Excel date
      const epoch = Date.UTC(1899, 11, 30); // mốc Excel (đã bù lỗi năm nhuận 1900 của Excel)
      const ms = epoch + serial * 86400000;
      const d = new Date(ms);
      if (Number.isNaN(d.getTime())) return null;
      const y = d.getUTCFullYear();
      const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
      const dd = String(d.getUTCDate()).padStart(2, "0");
      return { dateOnly: `${y}-${mo}-${dd}`, iso: `${y}-${mo}-${dd}T00:00:00+07:00` };
    },
  },
];

function isValidYmd(y: number, mo: number, d: number): boolean {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1900 || y > 2100) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/**
 * Parse 1 giá trị ngày/giờ từ file import — hỗ trợ đúng danh sách định dạng yêu cầu:
 * dd/MM/yyyy · dd/MM/yyyy HH:mm · dd/MM/yyyy HH:mm:ss · yyyy-MM-dd · yyyy-MM-dd HH:mm:ss · ISO8601.
 * Trả về `null` nếu không parse được (KHÔNG BAO GIỜ trả về chuỗi timestamp sai) — nơi gọi phải
 * coi `null` là "thiếu/không hợp lệ" và xử lý bằng validation, không được tự nối chuỗi thay thế.
 */
export function parseFlexibleDateTime(raw: string | null | undefined): ParsedDateTime | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  for (const p of PATTERNS) {
    const m = s.match(p.re);
    if (m) {
      const result = p.build(m);
      if (result) return result;
    }
  }
  return null;
}

/** Chỉ lấy phần ngày (yyyy-MM-dd) — dùng cho các cột `date` không cần giờ (dob, starting_date...). */
export function parseFlexibleDate(raw: string | null | undefined): string | null {
  return parseFlexibleDateTime(raw)?.dateOnly ?? null;
}
