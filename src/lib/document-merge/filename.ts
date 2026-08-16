/**
 * Deterministic + safe PDF filenames cho batch merge.
 *
 * Ví dụ: 001_Nguyen_Van_A.pdf, 002_Tran_Thi_B.pdf
 * Sanitize ký tự không an toàn, giữ tiếng Việt có dấu (Unicode hợp lệ).
 * Nếu trùng tên vẫn không overwrite nhầm vì key luôn kèm sequence + jobId prefix.
 */

export function sanitizeFilenamePart(input: string | null | undefined, fallback = "ung-vien"): string {
  const raw = String(input ?? "").trim();
  // Loại bỏ ký tự nguy hiểm cho filesystem/object-storage path + ký tự đặc biệt URL.
  const cleaned = raw
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\.+$/g, "")
    .trim();
  if (!cleaned) return fallback;
  // Giới hạn độ dài tránh vượt giới hạn object key / filesystem path.
  return cleaned.length > 120 ? cleaned.slice(0, 120) : cleaned;
}

export function buildIndividualPdfFilename(
  sequence: number,
  fullName: string | null | undefined,
  cccd: string | null | undefined,
): string {
  const seq = String(sequence).padStart(3, "0");
  const name = sanitizeFilenamePart(fullName);
  const id = sanitizeFilenamePart(cccd, "").replace(/\s+/g, "");
  const candidate = id ? `${name}_${id}` : name;
  return `${seq}_${candidate}.pdf`;
}

export function buildBatchPdfFilename(templateName: string, count: number): string {
  return `${sanitizeFilenamePart(templateName, "batch")}_${count}_ung_vien.pdf`;
}

export function buildBatchZipFilename(templateName: string, count: number): string {
  return `${sanitizeFilenamePart(templateName, "batch")}_${count}_ung_vien.zip`;
}

/** Object-storage key layout: document-merge/{jobId}/individual|batch/... */
export function buildStorageKey(jobId: string, kind: "individual" | "batch", filename: string): string {
  return `document-merge/${jobId}/${kind}/${filename}`;
}
