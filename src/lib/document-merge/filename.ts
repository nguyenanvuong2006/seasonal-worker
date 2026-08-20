/**
 * Document Merge — filename utilities (Phase 2).
 *
 * Tên file chuẩn:
 *   YYYYMMDD_HoTen_TenTaiLieu_ApplicationID.pdf
 *   vd: 20260817_Nguyen-Van-An_Dang-ky-tap-nghe_APP001928.pdf
 *
 * - Sanitize: bỏ ký tự không hợp lệ cho filesystem + Drive, chuẩn hoá khoảng trắng.
 * - Uniqueness: ApplicationID/document UUID là hậu tố bắt buộc → không overwrite.
 */

/** Ký tự không hợp lệ trong tên file (Windows + Drive + URL). */
const INVALID_FILENAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;
/** Nhiều khoảng trắng / dấu gạch liên tiếp → 1. */
const COLLAPSE_SEPARATORS = /[\s_]+/g;
/** Khoảng trắng giữa chữ → gạch nối. */
const SPACE_TO_DASH = /[-\s]+/g;

/** Bỏ dấu tiếng Việt (chỉ cho tên file, không dùng cho nội dung). */
export function stripVietnameseDiacritics(input: string): string {
  return String(input)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

/** Sanitize một segment (tên, loại tài liệu...) thành slug an toàn. */
export function sanitizeFilenameSegment(input: string, maxLength = 80): string {
  const cleaned = String(input ?? "")
    .normalize("NFC")
    .replace(INVALID_FILENAME_CHARS, " ")
    .replace(COLLAPSE_SEPARATORS, " ")
    .trim();
  if (!cleaned) return "ung-vien";
  return stripVietnameseDiacritics(cleaned)
    .replace(SPACE_TO_DASH, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, maxLength);
}

/**
 * Build filename chuẩn cho 1 PDF cá nhân.
 *
 * @param date        Ngày tạo (YYYYMMDD).
 * @param fullName    Họ tên ứng viên (đã sanitize).
 * @param documentType Loại tài liệu (slug).
 * @param applicationId Mã hồ sơ — đảm bảo uniqueness (không overwrite file khác).
 */
export function buildIndividualPdfFilename(
  date: Date,
  fullName: string,
  documentType: string,
  applicationId: string,
): string {
  const ymd = date.toISOString().slice(0, 10).replace(/-/g, "");
  const name = sanitizeFilenameSegment(fullName, 60);
  const type = sanitizeFilenameSegment(documentType, 60);
  const appId = sanitizeFilenameSegment(applicationId, 40);
  return `${ymd}_${name}_${type}_${appId}.pdf`;
}

/** Build storage key theo folder structure: Candidate Documents/YYYY/MM/DD/<filename>. */
export function buildIndividualStorageKey(date: Date, filename: string): string {
  const iso = date.toISOString().slice(0, 10).split("-");
  return `Candidate Documents/${iso[0]}/${iso[1]}/${iso[2]}/${filename}`;
}

/** Build storage key cho batch output: Batch Outputs/YYYY/MM/<jobId>/<filename>. */
export function buildBatchStorageKey(date: Date, jobId: string, filename: string): string {
  const iso = date.toISOString().slice(0, 10).split("-");
  return `Batch Outputs/${iso[0]}/${iso[1]}/${jobId}/${filename}`;
}

/** Tên file PDF tổng: Dang_ky_tap_nghe_500_ung_vien.pdf */
export function buildBatchPdfFilename(documentType: string, count: number): string {
  return `${sanitizeFilenameSegment(documentType, 60)}_${count}_ung-vien.pdf`;
}

/** Tên file ZIP: Dang_ky_tap_nghe_500_ung_vien.zip */
export function buildBatchZipFilename(documentType: string, count: number): string {
  return `${sanitizeFilenameSegment(documentType, 60)}_${count}_ung-vien.zip`;
}
