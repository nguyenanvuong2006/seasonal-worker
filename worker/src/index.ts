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

// LƯU Ý: worker chạy độc lập trong container (không qua Next.js bundler) nên
// MỌI import phải là relative — KHÔNG dùng alias "@/*" (tsx không resolve được
// trong layout container: /app/tsconfig.json baseUrl ".." trỏ ra ngoài /app).
import http from "node:http";
import { chromium, type Browser, type Page } from "playwright";
import type { MergeTemplateField } from "../../src/db/schema";
import {
  claimItems,
  completeItem,
  failItem,
  finalizeJob,
  hasPendingItems,
  markJobProcessing,
  recomputeJobProgress,
  type QueueItem,
} from "../../src/lib/document-merge/queue.ts";
import { renderApplicantDocument } from "../../src/lib/document-merge/html-pipeline.ts";
import { getStorageProvider } from "../../src/lib/storage/index.ts";
import {
  buildIndividualPdfFilename,
  buildIndividualStorageKey,
} from "../../src/lib/document-merge/filename.ts";
import { createDocumentHistory, linkRecordToHistory } from "../../src/lib/document-merge/document-history.ts";
import { finalizeBatchOutputs } from "../../src/lib/document-merge/batch-finalize.ts";
import { loadDailyApplicationRecords } from "../../src/lib/document-merge/record-loader.ts";
import { db } from "../../src/db";
import { mergeJobs, mergeTemplateVersions } from "../../src/db/schema";
import { eq } from "drizzle-orm";

/**
 * App-level auth: chấp nhận secret qua `Authorization: Bearer <secret>` (CLI/operator)
 * hoặc header `X-Merge-Worker-Secret: <secret>` (Vercel Preview — Authorization bị
 * chiếm bởi Google ID token cho Cloud Run IAM). KHÔNG weaken: secret vẫn bắt buộc
 * khi MERGE_WORKER_SECRET được set; lớp IAM (Cloud Run) xác thực Google token trước.
 */
function isAuthorized(req: import("node:http").IncomingMessage): boolean {
  if (!WORKER_SECRET) return true;
  if (req.headers.authorization === `Bearer ${WORKER_SECRET}`) return true;
  const alt = req.headers["x-merge-worker-secret"];
  return typeof alt === "string" && alt === WORKER_SECRET;
}

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
    const args = ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"];
    // Headless-shell trong sandbox/local cần single-process; Cloud Run image
    // (playwright noble) KHÔNG cần — bật qua env khi cần.
    if (process.env.CHROMIUM_SINGLE_PROCESS === "1") args.push("--single-process");
    browser = await chromium.launch({
      // Cho phép dùng custom Chromium (staging/CI/image nhẹ) — Cloud Run mặc
      // định dùng browser của playwright image; env này chỉ override khi cần.
      executablePath: process.env.CHROMIUM_EXECUTABLE_PATH?.trim() || undefined,
      args,
    });
  }
  return browser;
}

async function closeBrowser(): Promise<void> {
  if (poolContext) {
    await poolContext.close().catch(() => undefined);
    poolContext = null;
  }
  pagePool.length = 0;
  if (browser) {
    await browser.close().catch(() => undefined);
    browser = null;
  }
}

// ---------------------------------------------------------------
// Page pool — launch Chromium 1 lần, reuse context/page (spec L).
// KHÔNG đóng context giữa các render (headless-shell single-process sẽ
// thoát khi đóng page/context cuối); page chỉ đóng khi worker shutdown.
// ---------------------------------------------------------------
let poolContext: import("playwright").BrowserContext | null = null;
const pagePool: Page[] = [];

async function getRenderPage(): Promise<Page> {
  const existing = pagePool.pop();
  if (existing) return existing;
  if (!poolContext) {
    const b = await getBrowser();
    poolContext = await b.newContext();
  }
  const page = await poolContext.newPage();
  // SSRF guard (Phase 15): chặn mọi request mạng từ trang render. Worker CHỈ
  // render published template + validated data — không tải tài nguyên ngoài
  // (chỉ cho data: ảnh nhúng từ DOCX import).
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (url.startsWith("data:")) {
      await route.continue();
    } else {
      await route.abort("blockedbyclient");
    }
  });
  return page;
}

/**
 * Render 1 candidate HTML → PDF bytes (A4, theo @page CSS).
 * Reuse page từ pool — KHÔNG launch/đóng Chromium mỗi candidate.
 */
async function renderPdfBytes(html: string): Promise<Uint8Array> {
  const page = await getRenderPage();
  try {
    await page.setContent(html, { waitUntil: "load" });
    // Chờ font (nếu có) trước khi xuất PDF.
    await page.evaluate(async () => {
      await (document as Document & { fonts: FontFaceSet }).fonts.ready;
    });
    return await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true });
  } finally {
    pagePool.push(page); // reuse — không đóng
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
  version?: number | null;
  retentionYears?: number | null;
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
  const templateVersion = snap.version ?? null;
  const retentionYears = snap.retentionYears ?? undefined;
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
    templateVersion,
    documentType,
    filename,
    storageProvider: storage.name,
    storageFileId: stored.key,
    fileSize: bytes.byteLength,
    sha256,
    retentionYears,
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
          outputPdfUrl: finalize.pdfUrl,
          outputZipUrl: finalize.zipUrl,
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
    if (url.pathname === "/health" && req.method === "GET") {
      return json(res, 200, { ok: true });
    }

    if (url.pathname === "/run" && req.method === "POST") {
      if (!isAuthorized(req)) {
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

    // ---------------------------------------------------------------
    // POST /verify-visual — cloud visual verification (Admin website).
    // Body: { referencePdfBase64 } — so sánh reference Google Docs export với
    // HTML engine render (published template + dữ liệu mẫu). KHÔNG nhận HTML
    // arbitrary từ client (chỉ nhận reference PDF để so sánh).
    // ---------------------------------------------------------------
    if (url.pathname === "/verify-visual" && req.method === "POST") {
      if (!isAuthorized(req)) {
        return json(res, 401, { error: "unauthorized" });
      }
      const body = await readBody(req);
      const referenceB64 = String(body.referencePdfBase64 ?? "").trim();
      if (!referenceB64) {
        return json(res, 400, { error: "Thiếu referencePdfBase64 (PDF export từ Google Docs)." });
      }
      const referencePdf = new Uint8Array(Buffer.from(referenceB64, "base64"));
      if (referencePdf.byteLength > 25 * 1024 * 1024) {
        return json(res, 400, { error: "Reference PDF quá lớn (>25MB)." });
      }

      // Lấy published template (html_body + print_css) từ DB — không nhận từ client.
      const tpl = await db
        .select({
          htmlBody: mergeTemplateVersions.htmlBody,
          printCss: mergeTemplateVersions.printCss,
        })
        .from(mergeTemplateVersions)
        .where(eq(mergeTemplateVersions.status, "PUBLISHED"))
        .limit(1);
      if (!tpl[0]?.htmlBody) {
        return json(res, 409, { error: "Chưa có template version PUBLISHED (HTML engine)." });
      }

      const { renderApplicantHtmlFromParts } = await import(
        "../../src/lib/document-merge/html-renderer.ts"
      );
      const { SAMPLE_FIELD_VALUES, comparePdfs } = await import("./verification.ts");
      const rendered = renderApplicantHtmlFromParts(tpl[0].htmlBody, tpl[0].printCss, SAMPLE_FIELD_VALUES);
      const renderedPdf = await renderPdfBytes(rendered.html);

      const report = await comparePdfs(new Uint8Array(referencePdf), renderedPdf);
      return json(res, 200, {
        report,
        renderedPdfBase64: Buffer.from(renderedPdf).toString("base64"),
        referencePdfBase64: referenceB64,
        pass: report.pass,
      });
    }

    // ---------------------------------------------------------------
    // POST /benchmark — cloud benchmark (Admin website).
    // Body: { counts?: number[] } — chỉ nhận [1,10,50,100] (fixed, không arbitrary).
    // ---------------------------------------------------------------
    if (url.pathname === "/benchmark" && req.method === "POST") {
      if (!isAuthorized(req)) {
        return json(res, 401, { error: "unauthorized" });
      }
      const body = await readBody(req);
      const allowed = [1, 10, 50, 100];
      const countsRaw = Array.isArray(body.counts) ? body.counts.map(Number) : allowed;
      const counts = countsRaw.filter((c) => allowed.includes(c));
      if (counts.length === 0) {
        return json(res, 400, { error: "counts không hợp lệ — chỉ hỗ trợ 1,10,50,100." });
      }

      const { renderApplicantHtmlFromParts } = await import(
        "../../src/lib/document-merge/html-renderer.ts"
      );
      const { SAMPLE_FIELD_VALUES } = await import("./verification.ts");
      const tpl = await db
        .select({ htmlBody: mergeTemplateVersions.htmlBody, printCss: mergeTemplateVersions.printCss })
        .from(mergeTemplateVersions)
        .where(eq(mergeTemplateVersions.status, "PUBLISHED"))
        .limit(1);
      if (!tpl[0]?.htmlBody) {
        return json(res, 409, { error: "Chưa có template version PUBLISHED (HTML engine)." });
      }
      const { html } = renderApplicantHtmlFromParts(tpl[0].htmlBody, tpl[0].printCss, SAMPLE_FIELD_VALUES);

      const runs: Record<string, unknown>[] = [];
      for (const count of counts) {
        const t0 = Date.now();
        let failed = 0;
        const renders: { ms: number; bytes: Uint8Array }[] = [];
        const queue = [...Array(count).keys()];
        while (queue.length > 0) {
          const batch = queue.splice(0, CONCURRENCY);
          const results = await Promise.all(
            batch.map(async () => {
              try {
                const s = Date.now();
                const bytes = await renderPdfBytes(html);
                return { ms: Date.now() - s, bytes };
              } catch (e) {
                failed += 1;
                console.error(JSON.stringify({ event: "benchmark_render_failed", error: e instanceof Error ? e.message.slice(0, 300) : String(e) }));
                return { ms: 0, bytes: new Uint8Array(0) };
              }
            }),
          );
          renders.push(...results);
        }
        const durationMs = Date.now() - t0;
        const sorted = renders.map((r) => r.ms).filter((m) => m > 0).sort((a, b) => a - b);
        const p95 = sorted.length
          ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]
          : 0;
        runs.push({
          records: count,
          duration_ms: durationMs,
          avg_render_ms: sorted.length ? Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length) : 0,
          p95_render_ms: Math.round(p95),
          failed,
          retry_count: 0,
          concurrency: CONCURRENCY,
        });
      }
      return json(res, 200, { runs, concurrency: CONCURRENCY });
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
