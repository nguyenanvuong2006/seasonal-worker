/**
 * PERSON NAME NORMALIZATION — nguồn DUY NHẤT để chuẩn hoá họ tên cá nhân.
 * ----------------------------------------------------------------------
 * Chuẩn hoá về dạng "Viết Hoa Chữ Cái Đầu Mỗi Từ, Các Chữ Còn Lại Viết Thường",
 * hỗ trợ đúng Unicode tiếng Việt (bao gồm chữ Đ), KHÔNG làm mất dấu.
 *
 *   "nguyen van tri"        -> "Nguyen Van Tri"
 *   "NGUYEN VAN TRI"        -> "Nguyen Van Tri"
 *   "NGUYEN Van TRi"        -> "Nguyen Van Tri"
 *   "đẶNG tHỊ tHÚY nGA"     -> "Đặng Thị Thúy Nga"
 *
 * Quy tắc:
 *   1. Gộp khoảng trắng thừa (kể cả đầu/cuối chuỗi).
 *   2. Hạ toàn bộ về chữ thường trước (Unicode-aware — "Đ" -> "đ").
 *   3. Viết hoa chữ cái đầu mỗi từ, và cả chữ cái đứng sau gạch nối /
 *      dấu nháy / dấu chấm (vd "nguyễn-thị" -> "Nguyễn-Thị",
 *      "d'artagnan" -> "D'Artagnan", "trần t. minh" -> "Trần T. Minh").
 *
 * File này thuần TypeScript (KHÔNG import "server-only"/Next/DB) nên import
 * được ở cả server (route handlers, import engines) lẫn client (form công khai,
 * bảng Daily Application, trình quét QR CCCD).
 */

/** Một từ mới bắt đầu tại: đầu chuỗi, sau khoảng trắng, hoặc sau gạch nối/nháy/chấm. */
const WORD_START = /(^|[-'’‘.\s])([\p{L}])/gu;

/**
 * Chuẩn hoá 1 họ tên cá nhân.
 * - Giá trị không phải chuỗi (null/undefined/số...) trả về chuỗi rỗng "".
 * - Không bao giờ ném lỗi; luôn trả về chuỗi.
 */
export function normalizePersonName(value: unknown): string {
  if (typeof value !== "string") return "";
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  const lower = collapsed.toLowerCase();
  return lower.replace(WORD_START, (_match, separator: string, letter: string) => separator + letter.toUpperCase());
}
