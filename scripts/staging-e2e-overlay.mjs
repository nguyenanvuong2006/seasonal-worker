#!/usr/bin/env node
/**
 * STAGING CONTROLLED E2E — PDF Overlay renderer (PR5).
 *
 * Chạy TRỰC TIẾP chống staging thật (Cloud Run worker staging + Neon staging
 * + Google Drive staging) qua endpoint worker MỚI `/run-overlay` (bị chặn
 * 404 hoàn toàn khi WORKER_ENV=production — xem worker-diag-gate.ts):
 *
 *   queue (merge_jobs + merge_job_records, engine=PDF_OVERLAY, metadata.e2e
 *   snapshot fixture NON-PRODUCTION) → POST /run-overlay → worker claim items
 *   → renderer pdf-overlay (deterministic) → sha256 → storage staging
 *   → document_history → completeItem → batch finalize → COMPLETED.
 *
 * Bằng chứng (machine-readable): `--json <path>` — jobId, item counts,
 * completed/failed/retry, render durations, storage IDs, sha256, history
 * counts, worker revision, output URLs/IDs, status transitions. KHÔNG chứa
 * secret/PII (fixture giả, source_record_id uuid giả).
 *
 * Cách chạy (chỉ CI/cloud runner có network tới staging — KHÔNG chạy trên máy
 * user; KHÔNG bao giờ chạy với DATABASE_URL/Drive root production):
 *
 *   export STAGING_E2E_CONFIRM=1                       # BẮT BUỘC
 *   export DATABASE_URL=postgresql://...               # Neon STAGING
 *   export MERGE_WORKER_URL=https://...run.app         # Cloud Run STAGING
 *   export MERGE_WORKER_SECRET=...                     # Bearer secret (worker)
 *   export STORAGE_PROVIDER=google_drive               # staging root
 *   export GOOGLE_DRIVE_ROOT_FOLDER_ID=...             # STAGING root folder
 *   export GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... GOOGLE_REFRESH_TOKEN=...
 *   # Tuỳ chọn (nếu service staging yêu cầu Cloud Run IAM):
 *   export STAGING_E2E_ID_TOKEN=...                    # Google ID token → X-Serverless-Authorization
 *   node --import tsx scripts/staging-e2e-overlay.mjs --records 1 --json evidence-1.json
 *   node --import tsx scripts/staging-e2e-overlay.mjs --records 10 --json evidence-10.json
 *   node --import tsx scripts/staging-e2e-overlay.mjs --dry-run
 *   node --import tsx scripts/staging-e2e-overlay.mjs --cleanup
 *
 * AN TOÀN:
 *   - Bắt buộc STAGING_E2E_CONFIRM=1; chặn khi WORKER_ENV=production.
 *   - Mọi job: engine=PDF_OVERLAY, created_by='staging-e2e-overlay',
 *     metadata.e2e.nonProduction=true, dữ liệu fixture GIẢ (assertFixtureSafe).
 *   - Chỉ 1 job SUCCESS + 1 job FAILURE (synthetic) mỗi lần chạy — không đụng
 *     production, không đổi DOCUMENT_MERGE_ENGINE, không đổi ACTIVATION_ALLOWED.
 */

import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const CONFIRM = process.env.STAGING_E2E_CONFIRM === "1";
const DB_URL = process.env.DATABASE_URL || "";
const WORKER = (process.env.MERGE_WORKER_URL || "").replace(/\/+$/, "");
const SECRET = process.env.MERGE_WORKER_SECRET || "";
const DRIVE_ROOT = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID || "";
const ID_TOKEN = process.env.STAGING_E2E_ID_TOKEN || "";

const arg = (name) => process.argv.find((a, i) => process.argv[i - 1] === name);
const MODE = {
  dryRun: process.argv.includes("--dry-run"),
  cleanup: process.argv.includes("--cleanup"),
};
const JSON_PATH = arg("--json");
const RECORDS = Number(arg("--records") ?? 1);

const fail = (msg) => { console.error(`❌ ${msg}`); process.exit(1); };

console.log("========================================================================");
console.log("STAGING CONTROLLED E2E — PDF Overlay renderer (PR5)");
console.log(`records=${RECORDS} dryRun=${MODE.dryRun} cleanup=${MODE.cleanup} json=${JSON_PATH ?? "—"}`);
console.log("========================================================================");

if (!CONFIRM) fail("Thiếu STAGING_E2E_CONFIRM=1 — KHÔNG chạy khi chưa xác nhận target STAGING.");
if (!DB_URL) fail("Thiếu DATABASE_URL (Neon STAGING).");
if (!WORKER) fail("Thiếu MERGE_WORKER_URL (Cloud Run STAGING).");
if (!SECRET) fail("Thiếu MERGE_WORKER_SECRET.");
if (process.env.WORKER_ENV === "production") fail("WORKER_ENV=production — KHÔNG chạy overlay E2E chống production.");
if (process.env.DOCUMENT_MERGE_ENGINE && process.env.DOCUMENT_MERGE_ENGINE !== "GOOGLE_DOCS") {
  fail(`DOCUMENT_MERGE_ENGINE=${process.env.DOCUMENT_MERGE_ENGINE} — E2E yêu cầu engine default GOOGLE_DOCS (không đổi).`);
}
if (![1, 10].includes(RECORDS)) fail("--records chỉ hỗ trợ 1 hoặc 10.");

const { default: pg } = await import("pg");
const client = new pg.Client({
  connectionString: DB_URL,
  ssl: process.env.STAGING_E2E_SSL === "0" ? false : { rejectUnauthorized: false },
});
await client.connect();
const q = async (sql, params = []) => (await client.query(sql, params)).rows;

// PR5 root-cause hardening: schema preflight TRƯỚC khi seed/query overlay. Thiếu
// bảng/cột → fail nhanh SCHEMA_MISMATCH (operator biết chính xác migration nào
// thiếu) thay vì để /run-overlay nổ lỗi mờ giữa vòng. Cùng contract worker dùng.
const { checkOverlaySchema, formatOverlaySchemaMismatch } = await import("../src/lib/document-merge/pdf-overlay/required-schema.ts");
const schemaCheck = await checkOverlaySchema(async (sqlText) => (await client.query(sqlText)).rows);
if (!schemaCheck.ok) fail(formatOverlaySchemaMismatch(schemaCheck));
console.log(`✅ SCHEMA_OK: /run-overlay schema sẵn sàng (preflight — ${schemaCheck.requiredTableCount} bảng).`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (label, ok, detail = "") =>
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);

// Evidence object — machine-readable, không secret/PII.
const evidence = {
  pr5: {
    baseMainSha: process.env.BASE_MAIN_SHA ?? null,
    branch: process.env.GITHUB_REF_NAME ?? null,
  },
  workerUrl: WORKER,
  workerRevision: null,
  records: RECORDS,
  statusTransitions: [],
  items: [],
  historyCount: 0,
  sha256s: [],
  storageIds: [],
  outputUrls: [],
  renderDurationMs: null,
  retryCount: 0,
  idempotency: {},
  failure: {},
  productionIsolation: {
    engineDefault: process.env.DOCUMENT_MERGE_ENGINE ?? "GOOGLE_DOCS",
    activationAllowed: false,
    productionMutated: false,
    piiInFixtures: false,
  },
  checks: {},
  generatedAt: new Date().toISOString(),
};

// ---------------------------------------------------------------
// Worker call helper — app secret (Authorization) + IAM fallback
// (X-Serverless-Authorization) nếu staging service yêu cầu IAM.
// ---------------------------------------------------------------
async function callWorker(pathname, body = {}, { timeoutMs = 30_000 } = {}) {
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` };
  const doFetch = (h) =>
    fetch(`${WORKER}${pathname}`, {
      method: "POST",
      headers: h,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  let res = await doFetch(headers);
  if ((res.status === 401 || res.status === 403) && ID_TOKEN) {
    res = await doFetch({ ...headers, "X-Serverless-Authorization": `Bearer ${ID_TOKEN}` });
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON (vd IAM error page) */ }
  return { status: res.status, body: json, raw: text.slice(0, 300) };
}

// ---------------------------------------------------------------
// Preflight: worker /health + endpoint /run-overlay LIVE + engine default
// ---------------------------------------------------------------
console.log("\n--- PREFLIGHT ---");
const health = await fetch(`${WORKER}/health`, {
  headers: ID_TOKEN ? { "X-Serverless-Authorization": `Bearer ${ID_TOKEN}` } : {},
  signal: AbortSignal.timeout(15_000),
}).then((r) => r.json()).catch((e) => ({ error: e.message }));
check("Worker /health", health.ok === true, JSON.stringify(health).slice(0, 160));
if (health.ok !== true) fail("Worker /health không ok.");
evidence.workerRevision = health.revision ?? null;
console.log(`  worker revision: ${evidence.workerRevision ?? "—"}`);

// Chứng minh /run-overlay ĐANG MỞ trên worker này (không bị production gate):
// production gate trả 404 {"error":"not found"}; handler thật trả 500 "job not found".
const probe = await callWorker("/run-overlay", { jobId: "00000000-0000-4000-8000-000000000000" });
const overlayLive =
  probe.status === 500 && String(probe.body?.error ?? "").includes("job not found");
check("Worker /run-overlay LIVE (không bị production gate 404)", overlayLive,
  `HTTP ${probe.status} ${JSON.stringify(probe.body ?? {}).slice(0, 120)}`);
if (!overlayLive) fail("/run-overlay không khả dụng — endpoint bị chặn/thiếu (chỉ staging mới mở).");
check("DOCUMENT_MERGE_ENGINE default", (process.env.DOCUMENT_MERGE_ENGINE ?? "GOOGLE_DOCS") === "GOOGLE_DOCS",
  `engine=${process.env.DOCUMENT_MERGE_ENGINE ?? "GOOGLE_DOCS"}`);
check("STORAGE_PROVIDER", Boolean(process.env.STORAGE_PROVIDER), `provider=${process.env.STORAGE_PROVIDER ?? "unset"}`);
if (process.env.STORAGE_PROVIDER === "google_drive") {
  check("GOOGLE_DRIVE_ROOT_FOLDER_ID (staging)", Boolean(DRIVE_ROOT));
  check("Google creds (Drive read)", Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_REFRESH_TOKEN));
}

if (MODE.dryRun) {
  console.log("\n✅ DRY-RUN xong — chưa ghi gì. Chạy thật: bỏ --dry-run.");
  await client.end();
  process.exit(0);
}

if (MODE.cleanup) {
  const jobs = await q(`SELECT id, status, record_count, created_at FROM merge_jobs WHERE created_by = 'staging-e2e-overlay' ORDER BY created_at`);
  console.log(`\n--- CLEANUP: ${jobs.length} job overlay E2E (giữ nguyên semantics — chỉ liệt kê) ---`);
  for (const j of jobs) console.log(`  ${j.id}  ${j.status}  records=${j.record_count}  ${String(j.created_at).slice(0, 19)}`);
  const history = await q(`SELECT count(*)::int AS c FROM document_history WHERE created_by = 'staging-e2e-overlay'`);
  console.log(`  document_history (overlay E2E): ${history[0].c} rows — KHÔNG tự xoá (audit semantics).`);
  console.log("  Drive: xoá thủ công files trong 'Candidate Documents' + 'Batch Outputs' của STAGING root nếu cần.");
  await client.end();
  process.exit(0);
}

// ---------------------------------------------------------------
// Fixture (shared lib — worker dùng snapshot từ metadata)
// ---------------------------------------------------------------
const {
  buildStagingE2ESnapshot,
  renderStagingE2EItem,
  assertStagingE2EItemComplete,
} = await import("../src/lib/document-merge/pdf-overlay/staging-e2e.ts");
const { assertFixtureSafe } = await import("../src/lib/document-merge/pdf-overlay/verification/production-isolation.ts");

const snapshot = await buildStagingE2ESnapshot(RECORDS);
const safe = assertFixtureSafe(snapshot.fieldValues);
check("Fixture không PII (assertFixtureSafe)", safe.safe, safe.reason);
if (!safe.safe) fail("Fixture chứa PII — dừng.");
evidence.productionIsolation.piiInFixtures = !safe.safe;

// ---------------------------------------------------------------
// Tạo ĐÚNG 1 job SUCCESS (engine=PDF_OVERLAY, snapshot NON-PRODUCTION)
// ---------------------------------------------------------------
async function createOverlayJob(recordCount, { label = "SUCCESS", fieldValuesOverride = null } = {}) {
  const snap = {
    ...snapshot,
    total: recordCount,
    fieldValues: fieldValuesOverride
      ? { ...snapshot.fieldValues, ...fieldValuesOverride }
      : snapshot.fieldValues,
  };
  const [job] = await q(
    `INSERT INTO merge_jobs
       (template_id, template_name_snapshot, merge_mode, status, record_count, engine,
        queued_count, processing_count, completed_count, failed_count, progress_percent,
        created_by, metadata)
     VALUES (NULL, $1, 'INDIVIDUAL_DOCUMENTS', 'QUEUED', $2, 'PDF_OVERLAY', $2, 0, 0, 0, 0, 'staging-e2e-overlay', $3)
     RETURNING id`,
    [`[STAGING-E2E] ${label} PDF Overlay`, recordCount, JSON.stringify({ engine: "PDF_OVERLAY", e2e: snap })],
  );
  for (let i = 1; i <= recordCount; i++) {
    const srcId = `99999999-0000-4000-8000-${String(i).padStart(12, "0")}`;
    await q(
      `INSERT INTO merge_job_records
         (merge_job_id, source_entity, source_record_id, sort_order, status, attempt_count)
       VALUES ($1, 'staging_e2e_fixture', $2, $3, 'QUEUED', 0)`,
      [job.id, srcId, i],
    );
  }
  return { jobId: job.id, snap };
}

const { jobId: successJobId } = await createOverlayJob(RECORDS);
console.log(`\n✅ Job SUCCESS created: ${successJobId} engine=PDF_OVERLAY records=${RECORDS}`);
const e2eStartedAt = Date.now();

// ---------------------------------------------------------------
// Trigger worker /run-overlay + poll tới terminal (ghi transitions)
// ---------------------------------------------------------------
const runRes = await callWorker("/run-overlay", { jobId: successJobId }, { timeoutMs: 120_000 });
check("Worker /run-overlay trigger", runRes.status === 200, `HTTP ${runRes.status} ${JSON.stringify(runRes.body).slice(0, 120)}`);
if (runRes.status !== 200) fail(`/run-overlay thất bại: ${runRes.raw}`);

let jobRow = null;
const seenTransitions = [];
for (let i = 0; i < 90; i++) {
  await sleep(2000);
  const rows = await q(
    `SELECT status, queued_count, processing_count, completed_count, failed_count, progress_percent, error_summary, metadata
       FROM merge_jobs WHERE id = $1`,
    [successJobId],
  );
  jobRow = rows[0] ?? null;
  if (!jobRow) fail(`Job ${successJobId} không tồn tại`);
  const last = seenTransitions[seenTransitions.length - 1];
  const transition = {
    status: jobRow.status,
    completed: jobRow.completed_count,
    failed: jobRow.failed_count,
    percent: jobRow.progress_percent,
    at: new Date().toISOString(),
  };
  if (!last || last.status !== transition.status || last.completed !== transition.completed || last.failed !== transition.failed) {
    seenTransitions.push(transition);
  }
  console.log(`   poll ${i + 1}: ${jobRow.status} completed=${jobRow.completed_count} failed=${jobRow.failed_count} progress=${jobRow.progress_percent}%`);
  if (["COMPLETED", "FAILED", "CANCELLED"].includes(jobRow.status)) break;
}
if (!jobRow || !["COMPLETED", "FAILED", "CANCELLED"].includes(jobRow.status)) {
  fail(`Job không tới terminal sau 180s (${jobRow?.status})`);
}
evidence.statusTransitions = seenTransitions;
check("Status transitions hợp lệ (QUEUED → PROCESSING → COMPLETED)",
  seenTransitions.some((t) => t.status === "QUEUED") &&
  seenTransitions.some((t) => t.status === "PROCESSING") &&
  seenTransitions[seenTransitions.length - 1].status === "COMPLETED",
  seenTransitions.map((t) => `${t.status}(${t.completed}/${t.failed})`).join(" → "));

const totalMs = Date.now() - e2eStartedAt;
evidence.renderDurationMs = totalMs;

// ---------------------------------------------------------------
// Verify items + document_history + storage + sha256 + page count
// ---------------------------------------------------------------
const items = await q(
  `SELECT sort_order AS sequence, status, attempt_count, filename, file_size, sha256, storage_key, document_history_id,
          started_at, completed_at, error_code, error_message
     FROM merge_job_records WHERE merge_job_id = $1 ORDER BY sort_order`,
  [successJobId],
);
const completed = items.filter((i) => i.status === "COMPLETED");
const failedItems = items.filter((i) => i.status === "FAILED");

console.log("\n--- ITEMS (SUCCESS job) ---");
for (const it of items) {
  console.log(`  #${it.sequence} ${it.status} | attempts=${it.attempt_count} | size=${it.file_size} | sha256=${(it.sha256 ?? "").slice(0, 16)}…`);
}

const historyRows = await q(
  `SELECT id, merge_job_id, merge_job_record_id, document_type, storage_provider, storage_file_id, file_size, sha256,
          retention_until, retention_policy_snapshot, created_by
     FROM document_history WHERE merge_job_id = $1 ORDER BY created_at`,
  [successJobId],
);

check("Job terminal COMPLETED", jobRow.status === "COMPLETED", jobRow.status);
check(`completed == ${RECORDS}, failed == 0`, completed.length === RECORDS && failedItems.length === 0,
  `completed=${completed.length} failed=${failedItems.length}`);
check("Không item thiếu", items.length === RECORDS, `${items.length} items`);

let shaOk = 0;
let pageOk = 0;
let storageOk = 0;
let completeOk = 0;
let renderChecks = { warnings: 0, positionsDrawn: 0 };

// Storage provider (staging) — chỉ đọc metadata/bytes để verify
process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = DRIVE_ROOT;
const { getStorageProvider } = await import("../src/lib/storage/index.ts");
const storage = getStorageProvider();

// Local re-render deterministic → so sha256 với worker (bằng chứng
// deterministic + no unresolved placeholders)
for (let i = 1; i <= RECORDS; i++) {
  const rendered = await renderStagingE2EItem(snapshot, i, RECORDS);
  const complete = assertStagingE2EItemComplete(rendered, snapshot, i, RECORDS);
  renderChecks.positionsDrawn = rendered.positionsDrawn;
  renderChecks.warnings = rendered.warnings.length;
  check(`Local render #${i} deterministic (sha khớp worker)`, rendered.sha256 === completed[i - 1]?.sha256,
    `sha256=${rendered.sha256.slice(0, 16)}…`);
  check(`Local render #${i} no unresolved placeholders`, complete.ok, complete.detail);
  check(`Local render #${i} page count`, rendered.pageCount === snapshot.expectedPageCount, `${rendered.pageCount} pages`);
  if (rendered.sha256 === completed[i - 1]?.sha256) shaOk += 1;
  if (complete.ok) completeOk += 1;

  // Storage: metadata tồn tại + bytes → page count
  const item = completed[i - 1];
  if (item?.storage_key) {
    try {
      const meta = await storage.getMetadata(item.storage_key);
      const bytes = await storage.get(item.storage_key);
      const { PDFDocument } = await import("pdf-lib");
      const doc = await PDFDocument.load(bytes);
      const pages = doc.getPageCount();
      check(`Storage #${i} tồn tại + ${pages} pages`, Boolean(meta) && pages === snapshot.expectedPageCount,
        `size=${meta?.size ?? "—"} pages=${pages}`);
      if (pages === snapshot.expectedPageCount) pageOk += 1;
      storageOk += 1;
    } catch (e) {
      check(`Storage #${i} tồn tại`, false, String(e.message).slice(0, 120));
    }
  }
}
check("SHA-256 worker == local (100%)", shaOk === RECORDS, `${shaOk}/${RECORDS}`);
check("Page count == expected (100%)", pageOk === RECORDS, `${pageOk}/${RECORDS}`);
check("No unresolved placeholders (100%)", completeOk === RECORDS, `${completeOk}/${RECORDS}`);

// document_history
check("document_history đúng 1 row / item", historyRows.length === completed.length,
  `${historyRows.length} rows / ${completed.length} completed`);
let histOk = 0;
for (const h of historyRows) {
  const item = items.find((i) => i.document_history_id === h.id);
  const retentionYears = h.retention_until
    ? Math.round((new Date(h.retention_until).getTime() - Date.now()) / 31557600000)
    : null;
  const ok =
    Boolean(h.merge_job_record_id) &&
    h.document_type === "PDF-Overlay-E2E" &&
    Boolean(h.storage_provider && h.storage_file_id) &&
    Boolean(h.file_size != null && h.sha256) &&
    h.sha256 === item?.sha256 &&
    h.created_by === "staging-e2e-overlay" &&
    retentionYears != null && retentionYears >= 2 && retentionYears <= 4;
  if (ok) histOk += 1;
}
check(`document_history đầy đủ + sha256 khớp + retention ~3y (${histOk}/${historyRows.length})`,
  histOk === historyRows.length && historyRows.length === completed.length);

// Batch outputs (ephemeral) + page count của batch PDF
let batchOk = false;
try {
  const batchMetaPdf = jobRow.output_pdf_file_id ? await storage.getMetadata(jobRow.output_pdf_file_id) : null;
  const batchMetaZip = jobRow.output_zip_file_id ? await storage.getMetadata(jobRow.output_zip_file_id) : null;
  let batchPages = null;
  if (jobRow.output_pdf_file_id) {
    const bytes = await storage.get(jobRow.output_pdf_file_id);
    const { PDFDocument } = await import("pdf-lib");
    batchPages = (await PDFDocument.load(bytes)).getPageCount();
  }
  batchOk = Boolean(batchMetaPdf && batchMetaZip) && batchPages === snapshot.expectedPageCount * RECORDS;
  check("Batch PDF + ZIP trên storage + page count", batchOk,
    `batchPages=${batchPages} (kỳ vọng ${snapshot.expectedPageCount * RECORDS})`);
} catch (e) {
  check("Batch PDF + ZIP trên storage + page count", false, String(e.message).slice(0, 120));
}

evidence.items = items.map((it) => ({
  sequence: it.sequence,
  status: it.status,
  attemptCount: it.attempt_count,
  filename: it.filename,
  fileSize: it.file_size,
  sha256: it.sha256,
  storageKey: it.storage_key,
  documentHistoryId: it.document_history_id,
  errorCode: it.error_code ?? null,
}));
evidence.historyCount = historyRows.length;
evidence.sha256s = completed.map((i) => i.sha256);
evidence.storageIds = completed.map((i) => i.storage_key);
evidence.outputUrls = [jobRow.output_pdf_url, jobRow.output_zip_url].filter(Boolean);
evidence.retryCount = items.filter((i) => i.attempt_count > 1).length;
evidence.checks = {
  completed: completed.length,
  failed: failedItems.length,
  sha256Match: shaOk === RECORDS,
  pageCountMatch: pageOk === RECORDS,
  noUnresolvedPlaceholders: completeOk === RECORDS,
  historyMatch: histOk === historyRows.length && historyRows.length === completed.length,
  batchOk,
};

// ---------------------------------------------------------------
// Idempotency / re-run: duplicate /run-overlay KHÔNG duplicate output
// ---------------------------------------------------------------
const historyBefore = historyRows.length;
const itemsBefore = items.map((i) => `${i.id}:${i.storage_key}:${i.sha256}`).sort();
const dupRes = await callWorker("/run-overlay", { jobId: successJobId }, { timeoutMs: 60_000 });
await sleep(2500);
const historyAfter = (await q(`SELECT count(*)::int AS c FROM document_history WHERE merge_job_id = $1`, [successJobId]))[0].c;
const itemsAfter = (await q(`SELECT id, storage_key, sha256 FROM merge_job_records WHERE merge_job_id = $1`, [successJobId]))
  .map((r) => `${r.id}:${r.storage_key}:${r.sha256}`).sort();
const jobAfter = (await q(`SELECT status FROM merge_jobs WHERE id = $1`, [successJobId]))[0];
const sameItems = JSON.stringify(itemsBefore) === JSON.stringify(itemsAfter);
check("Re-run /run-overlay trả {processed:0}", dupRes.status === 200 && (dupRes.body?.processed ?? -1) === 0,
  `HTTP ${dupRes.status} ${JSON.stringify(dupRes.body ?? {}).slice(0, 80)}`);
check("Idempotency: history KHÔNG tăng sau re-run", historyAfter === historyBefore, `${historyBefore} → ${historyAfter}`);
check("Idempotency: item outputs (key+sha256) KHÔNG đổi", sameItems);
check("Job vẫn COMPLETED sau re-run", jobAfter.status === "COMPLETED", jobAfter.status);
evidence.idempotency = {
  historyBefore,
  historyAfter,
  itemsUnchanged: sameItems,
  jobStatusAfter: jobAfter.status,
  duplicateRunProcessed: dupRes.body?.processed ?? null,
};

// ---------------------------------------------------------------
// Failure handling: 1 job FAILURE (thiếu field required) → retry ×3 → FAILED
// ---------------------------------------------------------------
console.log("\n--- FAILURE HANDLING (worker failure + retry semantics) ---");
const { jobId: failJobId } = await createOverlayJob(1, {
  label: "FAILURE",
  fieldValuesOverride: { Ho_ten: undefined }, // MISSING_REQUIRED_FIELD deterministic
});
const failTransitions = [];
async function runFail() {
  const res = await callWorker("/run-overlay", { jobId: failJobId }, { timeoutMs: 60_000 });
  const row = (await q(`SELECT status, failed_count, error_summary FROM merge_jobs WHERE id = $1`, [failJobId]))[0];
  const item = (await q(`SELECT status, attempt_count, error_code, error_message FROM merge_job_records WHERE merge_job_id = $1`, [failJobId]))[0];
  failTransitions.push({ run: res.status, job: row.status, item: item.status, attempt: item.attempt_count });
  return { res, row, item };
}

const r1 = await runFail();
console.log(`  run 1: HTTP ${r1.res.status} → job=${r1.row.status} item=${r1.item.status} attempt=${r1.item.attempt_count}`);
const r2 = await (async () => { await sleep(3000); return runFail(); })();
console.log(`  run 2: HTTP ${r2.res.status} → job=${r2.row.status} item=${r2.item.status} attempt=${r2.item.attempt_count}`);
const r3 = await (async () => { await sleep(6000); return runFail(); })();
console.log(`  run 3: HTTP ${r3.res.status} → job=${r3.row.status} item=${r3.item.status} attempt=${r3.item.attempt_count} err=${r3.item.error_code}`);

const failHistoryCount = (await q(`SELECT count(*)::int AS c FROM document_history WHERE merge_job_id = $1`, [failJobId]))[0].c;
const failStorageCount = (await q(`SELECT count(*)::int AS c FROM merge_job_records WHERE merge_job_id = $1 AND storage_key IS NOT NULL`, [failJobId]))[0].c;

check("Item failure: attempt_count == 3 (retry ×3 rồi FAILED)", r3.item.attempt_count === 3, `attempt=${r3.item.attempt_count}`);
check("Item cuối FAILED", r3.item.status === "FAILED", r3.item.status);
check("Job cuối FAILED", r3.row.status === "FAILED", r3.row.status);
check("Item errorCode = RENDER_FAILED", r3.item.error_code === "RENDER_FAILED", r3.item.error_code ?? "—");
check("Item errorMessage chứa MISSING_REQUIRED_FIELD", String(r3.item.error_message ?? "").includes("MISSING_REQUIRED_FIELD"),
  String(r3.item.error_message ?? "").slice(0, 100));
check("Failure job: KHÔNG history row", failHistoryCount === 0, `${failHistoryCount} rows`);
check("Failure job: KHÔNG storage output", failStorageCount === 0, `${failStorageCount} outputs`);
check("Failure job: job errorSummary có nội dung", Boolean(r3.row.error_summary), r3.row.error_summary?.slice(0, 100) ?? "—");
evidence.failure = {
  jobId: failJobId,
  transitions: failTransitions,
  finalItem: { status: r3.item.status, attemptCount: r3.item.attempt_count, errorCode: r3.item.error_code },
  historyCount: failHistoryCount,
  storageOutputCount: failStorageCount,
  jobStatus: r3.row.status,
};

// Re-run failure job — terminal FAILED, không đổi trạng thái
const fr = await callWorker("/run-overlay", { jobId: failJobId }, { timeoutMs: 60_000 });
const frJob = (await q(`SELECT status FROM merge_jobs WHERE id = $1`, [failJobId]))[0];
const frHist = (await q(`SELECT count(*)::int AS c FROM document_history WHERE merge_job_id = $1`, [failJobId]))[0].c;
check("Re-run failure job: job giữ FAILED", frJob.status === "FAILED", `HTTP ${fr.status} → ${frJob.status}`);
check("Re-run failure job: vẫn 0 history", frHist === 0, `${frHist} rows`);

// ---------------------------------------------------------------
// Summary + evidence
// ---------------------------------------------------------------
const allPass =
  jobRow.status === "COMPLETED" &&
  completed.length === RECORDS &&
  failedItems.length === 0 &&
  shaOk === RECORDS &&
  pageOk === RECORDS &&
  completeOk === RECORDS &&
  histOk === historyRows.length &&
  historyRows.length === completed.length &&
  evidence.idempotency.historyAfter === evidence.idempotency.historyBefore &&
  evidence.idempotency.itemsUnchanged &&
  r3.item.status === "FAILED" &&
  r3.item.attempt_count === 3 &&
  failHistoryCount === 0;

evidence.status = allPass ? "PASS" : "FAIL";
evidence.passed = allPass;
evidence.finalJobId = successJobId;
evidence.jobId = successJobId;
evidence.itemCount = items.length;
evidence.completed = completed.length;
evidence.failed = failedItems.length;
evidence.durationMs = totalMs;
evidence.workerRevision = health.revision ?? null;
evidence.productionIsolation.activationAllowed = false;
evidence.productionIsolation.productionMutated = false;
evidence.productionIsolation.engineDefault = process.env.DOCUMENT_MERGE_ENGINE ?? "GOOGLE_DOCS";

if (JSON_PATH) {
  writeFileSync(JSON_PATH, JSON.stringify(evidence, null, 2));
  const shaFile = `${JSON_PATH}.sha256`;
  writeFileSync(shaFile, `${createHash("sha256").update(JSON.stringify(evidence)).digest("hex")}  ${JSON_PATH}\n`);
  console.log(`\n📄 Evidence: ${JSON_PATH} (+ ${shaFile})`);
}

console.log("\n========================================================================");
console.log(`RESULT: ${allPass ? "✅ STAGING E2E (PDF Overlay) PASS" : "❌ STAGING E2E (PDF Overlay) FAIL"} — records=${RECORDS}`);
console.log(`  job:            ${successJobId} (${jobRow.status})`);
console.log(`  total duration: ${totalMs}ms`);
console.log(`  completed:      ${completed.length}`);
console.log(`  failed:         ${failedItems.length}`);
console.log(`  retries:        ${evidence.retryCount}`);
console.log(`  history:        ${historyRows.length}`);
console.log(`  sha256s:        ${evidence.sha256s.length}`);
console.log(`  storage ids:    ${evidence.storageIds.length}`);
console.log(`  batch PDF:      ${jobRow.output_pdf_url ?? ""} (file_id=${jobRow.output_pdf_file_id ?? ""})`);
console.log(`  batch ZIP:      ${jobRow.output_zip_url ?? ""} (file_id=${jobRow.output_zip_file_id ?? ""})`);
console.log(`  worker rev:     ${evidence.workerRevision ?? "—"}`);
console.log(`  failure job:    ${failJobId} (${r3.item.status}, attempts=${r3.item.attempt_count})`);
console.log("========================================================================");

await client.end();
process.exit(allPass ? 0 : 1);
