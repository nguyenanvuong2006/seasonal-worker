/**
 * PDF Overlay Engine — blank PDF storage + integrity (PR2, management layer).
 *
 * Lưu PDF nền (blanked background) lên StorageProvider hiện có (local dev /
 * Google Drive production), KHÔNG lưu vào Git và KHÔNG lưu binary vào DB
 * (đúng convention của repo: Neon chỉ giữ metadata + storage key).
 *
 * Bất biến quan trọng:
 *   - Storage key LÀ VERSIONED (document-templates/pdf/{templateId}/v{version}.pdf)
 *     → KHÔNG bao giờ ghi đè. Asset của version đã PUBLISHED không thể bị thay.
 *   - SHA-256 được tính + lưu lúc upload; mọi lần đọc lại đều verify được.
 *
 * Module này THUẦN ở tầng storage: không import DB/schema. Business orchestration
 * (version lifecycle) nằm ở version-service.ts.
 */

import crypto from "node:crypto";
import { PDFDocument } from "pdf-lib";

import { getStorageProvider, type StorageProvider } from "@/lib/storage";
import type { PageGeometry } from "./types.ts";

export const PDF_TEMPLATE_STORAGE_PREFIX = "document-templates/pdf";
export const PDF_CONTENT_TYPE = "application/pdf";
export const MAX_BLANK_PDF_BYTES = 25 * 1024 * 1024; // 25 MB

/** Lỗi tầng storage/validation của blank PDF — status HTTP gợi ý. */
export class BlankPdfError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = "BlankPdfError";
  }
}

/** SHA-256 hex của bytes (dùng chung cho upload + verify). */
export function sha256Hex(bytes: Uint8Array | Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** Storage key immutable, versioned — KHÔNG bao giờ trùng giữa 2 version. */
export function pdfStorageKey(templateId: string, version: number): string {
  return `${PDF_TEMPLATE_STORAGE_PREFIX}/${templateId}/v${version}.pdf`;
}

/** Kiểm tra header "%PDF-" — chặn sớm file không phải PDF (không cần parse). */
export function assertPdfMagic(bytes: Uint8Array): void {
  if (!bytes || bytes.byteLength === 0) {
    throw new BlankPdfError("File PDF rỗng.", 400);
  }
  const head = Buffer.from(bytes.subarray(0, Math.min(1024, bytes.byteLength))).toString("latin1");
  if (!head.includes("%PDF-")) {
    throw new BlankPdfError("File không phải PDF hợp lệ (thiếu header %PDF-).", 400);
  }
}

/** Kết quả parse/validate nội dung PDF (dùng cho metadata page_count/page_layout). */
export interface BlankPdfInspection {
  pageCount: number;
  pageLayout: PageGeometry[];
}

/**
 * Load bằng pdf-lib để xác nhận PDF hợp lệ (không hỏng/mã hoá) và trích
 * page_count + page_layout (width/height/rotation từng trang, đơn vị pt).
 */
export async function inspectBlankPdf(bytes: Uint8Array): Promise<BlankPdfInspection> {
  assertPdfMagic(bytes);
  try {
    // pdf-lib có thể throw ở load() LẪN getPageCount()/getPage() với file corrupt
    // (catalog undefined) — bao toàn bộ trong try để chuyển thành BlankPdfError.
    const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: false });
    const pageCount = doc.getPageCount();
    if (pageCount < 1) {
      throw new BlankPdfError("PDF không có trang nào.", 400);
    }
    const pageLayout: PageGeometry[] = [];
    for (let i = 0; i < pageCount; i++) {
      const page = doc.getPage(i);
      const { width, height } = page.getSize();
      pageLayout.push({ pageNumber: i + 1, width, height, rotation: page.getRotation().angle });
    }
    return { pageCount, pageLayout };
  } catch (error) {
    if (error instanceof BlankPdfError) throw error;
    throw new BlankPdfError("Không đọc được PDF (file hỏng hoặc bị mã hoá).", 400);
  }
}

/** Kết quả lưu blank PDF thành công. */
export interface StoredBlankPdf {
  key: string;
  sha256: string;
  pageCount: number;
  pageLayout: PageGeometry[];
  size: number;
}

export type BlankPdfStorageOptions = { storage?: StorageProvider };

/**
 * Upload blank PDF lên storage (KHÔNG ghi đè — key versioned + guard exists).
 * Trả về key + sha256 + page_count + page_layout để lưu vào pdf_template_versions.
 */
export async function storeBlankPdf(
  templateId: string,
  version: number,
  bytes: Uint8Array,
  opts: BlankPdfStorageOptions = {},
): Promise<StoredBlankPdf> {
  if (bytes.byteLength > MAX_BLANK_PDF_BYTES) {
    throw new BlankPdfError(`PDF quá lớn (tối đa ${MAX_BLANK_PDF_BYTES / (1024 * 1024)} MB).`, 400);
  }
  const { pageCount, pageLayout } = await inspectBlankPdf(bytes);
  const sha256 = sha256Hex(bytes);
  const key = pdfStorageKey(templateId, version);
  const storage = opts.storage ?? getStorageProvider();

  // Guard chống ghi đè: key đã tồn tại = asset immutable bị đụng tới.
  if (await storage.exists(key)) {
    throw new BlankPdfError(`Storage key đã tồn tại (immutable): ${key}`, 409);
  }

  const stored = await storage.put(key, bytes, PDF_CONTENT_TYPE);
  return {
    key,
    sha256,
    pageCount,
    pageLayout,
    size: stored.size ?? bytes.byteLength,
  };
}

/** Đọc toàn bộ bytes blank PDF từ storage theo key. */
export async function retrieveBlankPdf(
  key: string,
  opts: BlankPdfStorageOptions = {},
): Promise<Buffer> {
  const storage = opts.storage ?? getStorageProvider();
  return storage.get(key);
}

/** Kết quả verify integrity. */
export interface BlankPdfIntegrityResult {
  ok: boolean;
  sha256: string;
  expectedSha256: string;
  pageCount?: number;
  expectedPageCount?: number;
  pageLayout?: PageGeometry[];
}

/**
 * Verify bytes đọc từ storage khớp SHA-256 đã lưu (+ tuỳ chọn khớp page_count).
 * Dùng làm gate trước publish và cho endpoint "verify integrity".
 */
export async function verifyBlankPdfIntegrity(
  key: string,
  expectedSha256: string,
  opts: BlankPdfStorageOptions & { expectedPageCount?: number } = {},
): Promise<BlankPdfIntegrityResult> {
  const storage = opts.storage ?? getStorageProvider();
  const bytes = await storage.get(key);
  const sha256 = sha256Hex(bytes);
  const inspected = await inspectBlankPdf(bytes);
  const shaOk = sha256 === expectedSha256;
  const pageOk = opts.expectedPageCount === undefined || inspected.pageCount === opts.expectedPageCount;
  return {
    ok: shaOk && pageOk,
    sha256,
    expectedSha256,
    pageCount: inspected.pageCount,
    expectedPageCount: opts.expectedPageCount,
    pageLayout: inspected.pageLayout,
  };
}
