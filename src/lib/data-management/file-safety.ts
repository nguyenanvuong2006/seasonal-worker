/**
 * WORKFORCE DATA MANAGEMENT — upload safety (mission section 34). The
 * reused parseImportFile()/file-parser.ts has no size/extension guard of
 * its own (neither does the existing /api/import/upload route) — this
 * mission explicitly calls out file safety as a requirement for the NEW
 * Data Management import surface, so the guard lives here rather than
 * silently inheriting that pre-existing gap.
 */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20MB
export const ALLOWED_UPLOAD_EXTENSIONS = [".xlsx", ".xls", ".csv"];

export function validateUploadFile(file: { name: string; size: number }): { ok: true } | { ok: false; message: string } {
  if (file.size > MAX_UPLOAD_BYTES) {
    return { ok: false, message: `File vượt quá giới hạn ${MAX_UPLOAD_BYTES / (1024 * 1024)}MB.` };
  }
  const lower = file.name.toLowerCase();
  if (!ALLOWED_UPLOAD_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return { ok: false, message: `Định dạng file không được hỗ trợ. Chỉ chấp nhận: ${ALLOWED_UPLOAD_EXTENSIONS.join(", ")}.` };
  }
  return { ok: true };
}
