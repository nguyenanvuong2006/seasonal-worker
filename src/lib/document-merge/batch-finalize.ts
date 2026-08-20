/**
 * Document Merge — Batch finalize (Phase 10).
 *
 * Sau khi individual PDFs hoàn thành:
 *   1. PDF tổng  : Dang-ky-tap-nghe_500_ung-vien.pdf (pdf-lib merge theo sort_order)
 *   2. ZIP       : Dang-ky-tap-nghe_500_ung-vien.zip (001_<file>.pdf, 002_...)
 *
 * - Batch outputs là TEMPORARY: batchExpiresAt = now + MERGE_JOB_BATCH_TTL_DAYS (7–30).
 * - Upload qua StorageProvider (không hardcode Drive).
 * - Ghi output_pdf/zip_url + file_id vào merge_jobs.
 * - KHÔNG giữ PDF tổng/ZIP 3 năm nếu individual PDFs đã lưu.
 */

import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { mergeJobRecords, mergeJobs } from "../../db/schema";
import { mergePdfBuffers } from "./batch-pdf.ts";
import { buildBatchPdfFilename, buildBatchStorageKey, buildBatchZipFilename } from "./filename.ts";
import { getStorageProvider } from "../storage/index.ts";
import { ITEM_STATUS } from "./queue-types.ts";
import * as yazl from "yazl";

export class BatchFinalizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BatchFinalizeError";
  }
}

function batchTtlMs(): number {
  const days = Number(process.env.MERGE_JOB_BATCH_TTL_DAYS ?? 14);
  const safe = Number.isFinite(days) && days >= 1 && days <= 90 ? Math.floor(days) : 14;
  return safe * 24 * 60 * 60 * 1000;
}

function padSequence(index: number): string {
  return String(index).padStart(3, "0");
}

/** Tạo ZIP từ danh sách {filename, bytes} theo thứ tự (entry name = 001_...). */
export async function buildZipBuffer(
  entries: { filename: string; bytes: Uint8Array }[],
): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (let i = 0; i < entries.length; i++) {
    zip.addBuffer(Buffer.from(entries[i].bytes), `${padSequence(i + 1)}_${entries[i].filename}`);
  }
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export type FinalizeResult = {
  pdfUrl: string;
  zipUrl: string;
  pdfFileId: string;
  zipFileId: string;
  pdfKey: string;
  zipKey: string;
  pdfBytes: number;
  zipBytes: number;
  itemCount: number;
};

/**
 * Finalize job: gộp PDF cá nhân (theo sort_order) → PDF tổng + ZIP → upload.
 * Gọi khi job hết pending items (worker loop break).
 */
export async function finalizeBatchOutputs(
  jobId: string,
  opts: { documentType?: string | null; storage?: ReturnType<typeof getStorageProvider> } = {},
): Promise<FinalizeResult> {
  const [job] = await db.select().from(mergeJobs).where(eq(mergeJobs.id, jobId)).limit(1);
  if (!job) throw new BatchFinalizeError(`Job ${jobId} not found`);

  const items = await db
    .select({
      id: mergeJobRecords.id,
      sortOrder: mergeJobRecords.sortOrder,
      storageKey: mergeJobRecords.storageKey,
      filename: mergeJobRecords.filename,
    })
    .from(mergeJobRecords)
    .where(and(eq(mergeJobRecords.mergeJobId, jobId), eq(mergeJobRecords.status, ITEM_STATUS.COMPLETED)))
    .orderBy(mergeJobRecords.sortOrder);

  if (items.length === 0) {
    throw new BatchFinalizeError("BATCH_FINALIZE_EMPTY: không có PDF cá nhân nào COMPLETED để gộp.");
  }

  const storage = opts.storage ?? getStorageProvider();
  const documentType = opts.documentType || job.templateNameSnapshot || "Tai-lieu-merge";

  // Download từng PDF cá nhân (theo storageKey — không phụ thuộc URL).
  const downloaded: { filename: string; bytes: Uint8Array }[] = [];
  for (const item of items) {
    if (!item.storageKey) {
      throw new BatchFinalizeError(`ITEM_MISSING_STORAGE_KEY: item ${item.id}`);
    }
    const bytes = await storage.get(item.storageKey);
    downloaded.push({ filename: item.filename ?? `${padSequence(item.sortOrder)}.pdf`, bytes });
  }

  // 1. PDF tổng
  const mergedPdf = await mergePdfBuffers(downloaded.map((d) => d.bytes));
  const pdfFilename = buildBatchPdfFilename(documentType, items.length);
  const now = new Date();
  const pdfKey = buildBatchStorageKey(now, jobId, pdfFilename);
  const storedPdf = await storage.put(pdfKey, mergedPdf, "application/pdf");

  // 2. ZIP (entry 001_..., 002_... theo sort_order)
  const zipFilename = buildBatchZipFilename(documentType, items.length);
  const zipBytes = await buildZipBuffer(downloaded);
  const zipKey = buildBatchStorageKey(now, jobId, zipFilename);
  const storedZip = await storage.put(zipKey, zipBytes, "application/zip");

  // 3. Ghi job: URL + file id + TTL (batch outputs temporary).
  await db
    .update(mergeJobs)
    .set({
      outputPdfUrl: storedPdf.url,
      outputZipUrl: storedZip.url,
      outputPdfFileId: storedPdf.key,
      outputZipFileId: storedZip.key,
      batchExpiresAt: new Date(Date.now() + batchTtlMs()),
      updatedAt: new Date(),
    })
    .where(eq(mergeJobs.id, jobId));

  return {
    pdfUrl: storedPdf.url,
    zipUrl: storedZip.url,
    pdfFileId: storedPdf.key,
    zipFileId: storedZip.key,
    pdfKey,
    zipKey,
    pdfBytes: mergedPdf.byteLength,
    zipBytes: zipBytes.byteLength,
    itemCount: items.length,
  };
}
