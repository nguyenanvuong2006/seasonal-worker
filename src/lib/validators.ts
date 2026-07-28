/**
 * VALIDATORS — nguồn DUY NHẤT cho việc kiểm tra định dạng dữ liệu trước khi Merge.
 * Không rải regex rời rạc trong SQL/route handlers — mọi nơi cần kiểm tra Phone/CCCD/
 * Email/Number/Boolean/Enum đều gọi qua đây (tránh trùng lặp, dễ audit, dễ sửa 1 chỗ).
 *
 * Với các bước VALIDATING chạy set-based (SQL, không phải vòng lặp JS — xem
 * src/lib/import-jobs.ts), TypeScript function không gọi trực tiếp được từ SQL — nên các
 * PATTERN (chuỗi regex thô) được export riêng để SQL dùng LẠI ĐÚNG pattern này (không viết
 * lại regex 1 lần nữa trong SQL), giữ 1 nguồn sự thật cho định dạng dù chạy ở tầng nào.
 */

export const CCCD_PATTERN = "^[0-9]{9,12}$";
export const VN_PHONE_PATTERN = "^0[0-9]{8,10}$";
export const NUMBER_PATTERN = "^-?[0-9]+(\\.[0-9]+)?$";

export function isValidCccd(v: string | null | undefined): boolean {
  return new RegExp(CCCD_PATTERN).test(String(v ?? "").trim());
}

export function isValidVietnamesePhone(v: string | null | undefined): boolean {
  return new RegExp(VN_PHONE_PATTERN).test(String(v ?? "").trim());
}

export function isValidEmail(v: string | null | undefined): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v ?? "").trim());
}

export function isValidNumber(v: string | null | undefined): boolean {
  const s = String(v ?? "").trim();
  return s !== "" && new RegExp(NUMBER_PATTERN).test(s);
}

const TRUE_VALUES = new Set(["true", "1", "yes", "có", "co", "x"]);
const FALSE_VALUES = new Set(["false", "0", "no", "không", "khong", ""]);
export function isValidBoolean(v: string | null | undefined): boolean {
  const s = String(v ?? "").trim().toLowerCase();
  return TRUE_VALUES.has(s) || FALSE_VALUES.has(s);
}
export function toBoolean(v: string | null | undefined): boolean {
  return TRUE_VALUES.has(String(v ?? "").trim().toLowerCase());
}

export function isValidEnum(v: string | null | undefined, allowed: readonly string[]): boolean {
  return allowed.includes(String(v ?? "").trim());
}

export function isRequired(v: string | null | undefined): boolean {
  return String(v ?? "").trim() !== "";
}

export function isReasonableAge(age: number | null): boolean {
  return age !== null && age >= 15 && age <= 70;
}
