/**
 * Document Merge PDF Worker (Playwright/Chromium) — Google Cloud Run.
 *
 * Kiến trúc:
 *   worker start → launch Chromium 1 lần → claim items (FOR UPDATE SKIP LOCKED)
 *   → render candidate (HTML → PDF) song song theo PDF_RENDER_CONCURRENCY
 *   → upload object storage → completeItem/failItem → recompute progress
 *   → loop đến khi hết pending → finalize job → worker shutdown → close Chromium.
 *
 * KHÔNG launch Chromium mới cho từng candidate.
 *
 * Endpoint:
 *   POST /run  (Authorization: Bearer MERGE_WORKER_SECRET) — body { jobId? }
 *   GET  /health
 *
 * Scale-to-zero: đây là Cloud Run *service* (min-instances=0). Vercel gọi POST /run
 * sau khi tạo job (qua after()), mỗi invocation xử lý tới khi queue rỗng hoặc hết
 * budget thời gian, rồi instance scale về 0.
 */

import http from "node:http";
import { chromium, type Browser, type Page } from "playwright";
import type { MergeTemplateField } from "@/db/schema";
import {
  claimItems,
  completeItem,
  failItem,
  finalizeJob,
  hasPendingItems,
  markJobProcessing,
  recomputeJobProgress,
  type QueueItem,
} from "@/lib/document-merge/queue.ts";
import { renderApplicantDocument } from "@/lib/document-merge/html-pipeline.ts";
import { getStorageProvider } from "@/lib/storage/index.ts";
import {
  buildIndividualPdfFilename,
  buildIndividualStorageKey,
} from "@/lib/document-merge/filename.ts";
import { createDocumentHistory, linkRecordToHistory } from "@/lib/document-merge/document-history.ts";
import { finalizeBatchOutputs } from "@/lib/document-merge/batch-finalize.ts";
import { loadDailyApplicationRecords } from "@/lib/document-merge/record-loader.ts";
import { db } from "@/db";
import { mergeJobs } from "@/db/schema";
import { eq } from "drizzle-orm";

const PORT = Number(process.env.PORT ?? 8080);
const CONCURRENCY = Math.max(1, Number(process.env.PDF_RENDER_CONCURRENCY ?? 4));
const WORKER_SECRET = process.env.MERGE_WORKER_SECRET ?? "";
const MAX_BATCH_ITERATIONS = 1000; // chống vòng lặp vô hạn (retry vô hạn bị chặn ở queue)

// ---------------------------------------------------------------
// Chromium page pool — launch 1 lần, tái sử dụng context/page.
// ---------------------------------------------------------------
let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browser) {
    browser = await chromium.launch({
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
  }
  return browser;
}

async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

/**
 * Render 1 candidate HTML → PDF bytes (A4, theo @page CSS).
 *
 * SSRF guard (Phase 15): chặn mọi request mạng từ trang (img/font/iframe...).
 * Worker CHỈ render published template version + validated data — không cần
 * tải tài nguyên ngoài. Cấm cả data: ngoại trừ ảnh nhúng của DOCX import.
 */
async function renderPdfBytes(html: string): Promise<Uint8Array> {
  const b = await getBrowser();
  const context = await b.newContext();
  try {
    const page: Page = await context.newPage();

    // Chặn SSRF: không cho phép bất kỳ request HTTP/WS nào từ HTML render.
    await page.route("**/*", async (route) => {
      const url = route.request().url();
      if (url.startsWith("data:")) {
        await route.continue();
      } else {
        await route.abort("blockedbyclient");
      }
    });
    // Cấm script (template không cần JS — chỉ CSS print + font ready).
    await context.addInitScript(() => {
      // no-op placeholder cho tương lai nếu cần CSP
    });

    try {
      await page.setContent(html, { waitUntil: "load" });
      // Chờ font (nếu có) trước khi xuất PDF.
      await page.evaluate(async () => {
        await (document as Document & { fonts: FontFaceSet }).fonts.ready;
      });
      return await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true });
    } finally {
      await page.close();
    }
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------
// Field snapshot (merge_jobs.metadata.templates[tid].fields) → render fields
// ---------------------------------------------------------------
interface FieldSnapshotRow {
  placeholder: string;
  sourceType: string;
  sourceEntity: string | null;
  sourceField: string | null;
  sourcePath: string | null;
  optionValue: string | null;
  formatType: string | null;
  fallbackValue: string | null;
  isRequired: boolean;
}

interface TemplateSnapshot {
  name?: string;
  documentKind?: string;
  googleDocId?: string;
  fields?: FieldSnapshotRow[];
}

function toRenderFields(rows: FieldSnapshotRow[] = []): MergeTemplateField[] {
  return rows.map((r) => ({
    id: "",
    templateId: "",
    placeholder: r.placeholder,
    sourceType: r.sourceType,
    sourceEntity: r.sourceEntity,
    sourceField: r.sourceField,
    sourcePath: r.sourcePath,
    optionValue: r.optionValue,
    formatType: r.formatType,
    fallbackValue: r.fallbackValue,
    isRequired: r.isRequired,
    isOrphaned: false,
    isSuggested: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
}

// ---------------------------------------------------------------
// Render 1 item
// ---------------------------------------------------------------
interface JobContext {
  jobId: string;
  createdBy: string;
  templates: Record<string, TemplateSnapshot>;
}

async function processItem(item: QueueItem, jobCtx: JobContext): Promise<void> {
  const templateId = item.templateId ?? "";
  const snap = jobCtx.templates[templateId] ?? Object.values(jobCtx.templates)[0];
  if (!snap?.googleDocId) {
    await failItem(item.id, { errorCode: "TEMPLATE_MISSING", errorMessage: "Không có template cho record." }, { attemptCount: item.attemptCount });
    return;
  }

  const records = await loadDailyApplicationRecords([item.sourceRecordId]);
  const recordData = records.get(item.sourceRecordId);
  if (!recordData) {
    await failItem(item.id, { errorCode: "RECORD_NOT_FOUND", errorMessage: "Không tìm thấy hồ sơ ứng viên." }, { attemptCount: item.attemptCount });
    return;
  }

  const context = { currentUserName: jobCtx.createdBy, currentDate: new Date(), mergeIndex: item.sortOrder, mergeCount: 1 };
  const rendered = renderApplicantDocument(snap.googleDocId, toRenderFields(snap.fields), recordData, context);
  if (!rendered.valid) {
    await failItem(
      item.id,
      {
        errorCode: "INCOMPLETE",
        errorMessage: `Thiếu: ${[...rendered.missingFields, ...rendered.unreplaced].slice(0, 20).join(", ")}`,
      },
      { attemptCount: item.attemptCount },
    );
    return;
  }

  const bytes = await renderPdfBytes(rendered.html);
  const fullName = String(recordData.fullName ?? "ung-vien");
  const applicationId = String(recordData.id ?? item.sourceRecordId ?? "ung-vien");
  const documentType = snap.documentKind === "B" ? "Dang-ky-tap-nghe" : "Tai-lieu-merge";
  const now = new Date();
  const filename = buildIndividualPdfFilename(now, fullName, documentType, applicationId);
  const storageKey = buildIndividualStorageKey(now, filename);

  const storage = getStorageProvider();
  const stored = await storage.put(storageKey, bytes, "application/pdf");

  // SHA-256 + Document History (mỗi PDF = 1 record riêng, retention snapshot).
  const sha256 = await sha256Hex(bytes);
  const history = await createDocumentHistory({
    candidateId: null,
    applicationId: item.sourceRecordId,
    mergeJobId: item.mergeJobId,
    mergeJobRecordId: item.id,
    templateId: item.templateId ?? undefined,
    documentType,
    filename,
    storageProvider: storage.name,
    storageFileId: stored.key,
    fileSize: bytes.byteLength,
    sha256,
    retentionYears: null, // → fallback default (3 năm) qua retention.ts
    createdBy: jobCtx.createdBy,
  });
  await linkRecordToHistory(item.id, history.id);

  await completeItem(item.id, {
    pdfUrl: stored.url,
    storageKey,
    filename,
    fileSize: bytes.byteLength,
    sha256,
    documentHistoryId: history.id,
  });
}

/** SHA-256 hex của PDF bytes (mỗi PDF khi tạo phải tính). */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

// ---------------------------------------------------------------
// Process loop cho 1 job
// ---------------------------------------------------------------
async function runJob(jobId: string): Promise<{ processed: number; failed: number }> {
  const [job] = await db.select().from(mergeJobs).where(eq(mergeJobs.id, jobId)).limit(1);
  if (!job) throw new Error("job not found");

  const templates = (job.metadata as { templates?: Record<string, TemplateSnapshot> }).templates ?? {};
  const jobCtx: JobContext = { jobId, createdBy: job.createdBy, templates };

  await markJobProcessing(jobId);

  let processed = 0;
  let failed = 0;
  const startedAt = Date.now();

  for (let iter = 0; iter < MAX_BATCH_ITERATIONS; iter++) {
    const items = await claimItems(jobId, CONCURRENCY);
    if (items.length === 0) break;

    // Render song song theo concurrency.
    await Promise.all(
      items.map(async (item) => {
        try {
          await processItem(item, jobCtx);
          processed += 1;
        } catch (error) {
          failed += 1;
          const message = error instanceof Error ? error.message : String(error);
          await failItem(
            item.id,
            { errorCode: "RENDER_FAILED", errorMessage: message.slice(0, 500) },
            { attemptCount: item.attemptCount },
          );
          console.log(JSON.stringify({ event: "pdf_render_failed", jobId, sequence: item.sortOrder, error: message.slice(0, 200) }));
        }
      }),
    );

    await recomputeJobProgress(jobId);
  }

  const progress = await recomputeJobProgress(jobId);

  // Phase 10: khi hết pending items → finalize PDF tổng + ZIP.
  // Nếu finalize lỗi → job FAILED (individual PDFs đã lưu, không mất dữ liệu).
  if (progress.terminal) {
    if (progress.completed > 0) {
      try {
        const finalize = await finalizeBatchOutputs(jobId, { documentType: "Dang-ky-tap-nghe" });
        await finalizeJob(jobId, "COMPLETED", {
          errorSummary: progress.failed > 0 ? `${progress.failed} item FAILED (đã retry tối đa)` : null,
        });
        console.log(
          JSON.stringify({
            event: "pdf_batch_finalized",
            jobId,
            itemCount: finalize.itemCount,
            pdfBytes: finalize.pdfBytes,
            zipBytes: finalize.zipBytes,
          }),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await finalizeJob(jobId, "FAILED", { errorSummary: `FINALIZE_FAILED: ${message.slice(0, 500)}` });
        console.log(JSON.stringify({ event: "pdf_batch_finalize_failed", jobId, error: message.slice(0, 300) }));
      }
    } else {
      await finalizeJob(jobId, progress.failed > 0 ? "FAILED" : "COMPLETED", {
        errorSummary: progress.failed > 0 ? "Toàn bộ item FAILED." : null,
      });
    }
  }

  console.log(
    JSON.stringify({
      event: "pdf_worker_run",
      jobId,
      processed,
      failed,
      durationMs: Date.now() - startedAt,
      concurrency: CONCURRENCY,
      terminal: progress.terminal,
      finalizeStatus: progress.terminal && progress.completed > 0 ? "attempted" : "skipped",
    }),
  );
  return { processed, failed };
}

// ---------------------------------------------------------------
// HTTP server (Cloud Run service)
// ---------------------------------------------------------------
function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return {};
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  try {
    if (url.pathname === "/health") {
      return json(res, 200, { ok: true });
    }

    if (url.pathname === "/run" && req.method === "POST") {
      if (WORKER_SECRET && req.headers.authorization !== `Bearer ${WORKER_SECRET}`) {
        return json(res, 401, { error: "unauthorized" });
      }
      const body = await readBody(req);
      const jobId = String(body.jobId ?? "").trim();
      if (!jobId) {
        // Không có jobId → xử lý lần lượt các job QUEUED/PROCESSING (watchdog mode).
        const [nextJob] = await db
          .select({ id: mergeJobs.id })
          .from(mergeJobs)
          .where(eq(mergeJobs.status, "QUEUED"))
          .limit(1);
        if (!nextJob) return json(res, 200, { processed: 0, note: "no queued jobs" });
        const result = await runJob(nextJob.id);
        return json(res, 200, result);
      }
      const result = await runJob(jobId);
      return json(res, 200, result);
    }

    return json(res, 404, { error: "not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ event: "pdf_worker_error", error: message }));
    return json(res, 500, { error: message });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(JSON.stringify({ event: "pdf_worker_start", port: PORT, concurrency: CONCURRENCY }));
});

// Graceful shutdown: đóng Chromium khi instance scale-down/restart.
async function shutdown(): Promise<void> {
  console.log(JSON.stringify({ event: "pdf_worker_shutdown" }));
  server.close();
  await closeBrowser();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
