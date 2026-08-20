#!/usr/bin/env node
/**
 * STAGING REAL E2E — Document Merge HTML/PDF pipeline (Phase 16).
 *
 * Chạy TRỰC TIẾP chống staging thật (Cloud Run worker + Neon staging + Google
 * Drive staging) mà KHÔNG cần session Vercel: tạo job in-process qua
 * createAsyncMergeJob (dùng DATABASE_URL), trigger worker /run (Bearer secret),
 * poll DB, verify từng stage, in bằng chứng (id/url/metrics).
 *
 * Cách chạy (bất kỳ máy/CI nào có network tới Google; KHÔNG chạy trên máy
 * user — chạy trong GitHub Actions hoặc môi trường cloud khác):
 *
 *   export STAGING_E2E_CONFIRM=1                       # BẮT BUỘC — chống chạy nhầm production
 *   export DATABASE_URL=postgresql://...               # Neon STAGING
 *   export MERGE_WORKER_URL=https://...run.app         # Cloud Run STAGING
 *   export MERGE_WORKER_SECRET=...                     # Bearer secret (worker)
 *   export STORAGE_PROVIDER=google_drive
 *   export GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... GOOGLE_REFRESH_TOKEN=...
 *   export GOOGLE_DRIVE_ROOT_FOLDER_ID=...
 *   node --import tsx scripts/staging-e2e.mjs [--records 1|10] [--negative] [--cleanup] [--dry-run]
 *
 * Modes:
 *   --dry-run   audit template/version + worker /health + storage provider — KHÔNG ghi gì.
 *   --records N 1 (mặc định) hoặc 10.
 *   --negative  chạy thêm negative/resilience tests (worker-level, an toàn).
 *   --cleanup   soft-delete hồ sơ test prefix [STAGING-E2E]; chỉ in danh sách
 *               job/history/Drive (KHÔNG tự xoá job/history/Drive — giữ semantics).
 *
 * AN TOÀN:
 *   - Bắt buộc STAGING_E2E_CONFIRM=1 (không chạy khi thiếu — tránh nhầm target).
 *   - Mọi hồ sơ test đều prefix "[STAGING-E2E]" trong full_name.
 *   - KHÔNG xoá dữ liệu production; KHÔNG đọc secrets; KHÔNG in giá trị secret.
 *   - created_by = "staging-e2e" cho job để dễ truy vết/cleanup.
 */

import { readFileSync, writeFileSync } from "node:fs";

const CONFIRM = process.env.STAGING_E2E_CONFIRM === "1";
const DB_URL = process.env.DATABASE_URL || "";
const WORKER = (process.env.MERGE_WORKER_URL || "").replace(/\/+$/, "");
const SECRET = process.env.MERGE_WORKER_SECRET || "";
const DRIVE_ROOT = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID || "";

const arg = (name) => process.argv.find((a, i) => process.argv[i - 1] === name);
const MODE = {
  dryRun: process.argv.includes("--dry-run"),
  negative: process.argv.includes("--negative"),
  cleanup: process.argv.includes("--cleanup"),
};
const RECORDS = Number(arg("--records") ?? 1);

const fail = (msg) => { console.error(`❌ ${msg}`); process.exit(1); };

console.log("================================================================");
console.log("STAGING REAL E2E — Document Merge HTML/PDF pipeline (Phase 16)");
console.log(`records=${RECORDS} dryRun=${MODE.dryRun} negative=${MODE.negative} cleanup=${MODE.cleanup}`);
console.log("================================================================");

if (!CONFIRM) fail("Thiếu STAGING_E2E_CONFIRM=1 — KHÔNG chạy khi chưa xác nhận target STAGING.");
if (!DB_URL) fail("Thiếu DATABASE_URL (Neon STAGING).");
if (!WORKER) fail("Thiếu MERGE_WORKER_URL (Cloud Run STAGING).");
if (!SECRET) fail("Thiếu MERGE_WORKER_SECRET.");

const { default: pg } = await import("pg");
const client = new pg.Client({
  connectionString: DB_URL,
  // Neon cần SSL; local dev/CI không SSL → STAGING_E2E_SSL=0.
  ssl: process.env.STAGING_E2E_SSL === "0" ? false : { rejectUnauthorized: false },
});
await client.connect();
const q = async (sql, params = []) => (await client.query(sql, params)).rows;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (label, ok, detail = "") =>
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);

// ---------------------------------------------------------------
// 0. DRY-RUN / PRE-FLIGHT: template state + worker health + storage
// ---------------------------------------------------------------
const tplRows = await q(`
  SELECT t.id, t.name, t.google_doc_id, t.is_active,
         (SELECT count(*) FROM merge_template_fields f
           WHERE f.template_id = t.id AND f.is_orphaned = false) AS fields,
         (SELECT json_agg(json_build_object('version', v.version, 'status', v.status,
            'retention_years', v.retention_years, 'updated_at', v.updated_at,
            'html_len', length(v.html_body)) ORDER BY v.version)
           FROM merge_template_versions v WHERE v.template_id = t.id) AS versions
  FROM merge_templates t ORDER BY t.created_at
`);
console.log("\n--- TEMPLATE STATE (Neon staging) ---");
for (const t of tplRows) {
  console.log(`  ${t.name} | id=${t.id} | active=${t.is_active} | fields=${t.fields} | doc=${t.google_doc_id ?? "—"}`);
  for (const v of t.versions ?? []) console.log(`    v${v.version} ${v.status} retention=${v.retention_years}y html_len=${v.html_len} updated=${String(v.updated_at).slice(0, 16)}`);
}
const published = tplRows.some((t) => (t.versions ?? []).some((v) => v.status === "PUBLISHED"));
check("Template Dang_ky_Tap_nghe tồn tại", tplRows.length > 0);
check("51 mappings (fields)", tplRows.some((t) => Number(t.fields) >= 51));
check("Version PUBLISHED tồn tại (HTML engine cần)", published);

const health = await fetch(`${WORKER}/health`, { signal: AbortSignal.timeout(15_000) })
  .then((r) => r.json())
  .catch((e) => ({ error: e.message }));
check("Worker /health", health.ok === true, JSON.stringify(health).slice(0, 120));
check("STORAGE_PROVIDER=google_drive", process.env.STORAGE_PROVIDER === "google_drive", `provider=${process.env.STORAGE_PROVIDER ?? "unset"}`);
if (process.env.STORAGE_PROVIDER === "google_drive") check("GOOGLE_DRIVE_ROOT_FOLDER_ID set", Boolean(DRIVE_ROOT));

if (MODE.dryRun) {
  console.log("\n✅ DRY-RUN xong — chưa ghi gì. Khi sẵn sàng chạy thật: bỏ --dry-run.");
  await client.end();
  process.exit(0);
}

if (MODE.cleanup) {
  // Cleanup: soft-delete records test prefix [STAGING-E2E]; liệt kê job/history liên quan.
  const rows = await q(`SELECT id, full_name FROM daily_applications WHERE full_name LIKE '[STAGING-E2E]%' AND deleted_at IS NULL`);
  console.log(`\n--- CLEANUP: ${rows.length} hồ sơ test [STAGING-E2E] chưa soft-delete ---`);
  for (const r of rows) console.log(`  ${r.id}  ${r.full_name}`);
  if (rows.length > 0) {
    await q(`UPDATE daily_applications SET deleted_at = now(), deleted_by = 'staging-e2e-cleanup' WHERE id = ANY($1)`, [rows.map((r) => r.id)]);
    console.log(`✅ Đã soft-delete ${rows.length} hồ sơ test (giữ audit trail).`);
  }
  const jobs = await q(`SELECT id, status, created_at FROM merge_jobs WHERE created_by = 'staging-e2e' ORDER BY created_at`);
  console.log(`\nJobs E2E đã tạo (${jobs.length}) — KHÔNG tự xoá (giữ history semantics):`);
  for (const j of jobs) console.log(`  ${j.id}  ${j.status}  ${String(j.created_at).slice(0, 19)}`);
  console.log("\nManual cleanup (chỉ khi cần, sau khi đã thu thập evidence):");
  console.log("  - Drive: xoá thủ công file trong folder Verification/ + Batch Outputs/ của staging root.");
  console.log("  - document_history/merge_jobs: giữ nguyên (snapshot + audit).");
  await client.end();
  process.exit(0);
}

if (![1, 10].includes(RECORDS)) fail("--records chỉ hỗ trợ 1 hoặc 10.");
if (!published) fail("Chưa có template version PUBLISHED — publish qua Admin UI (Templates → version 1 → Publish) trước khi chạy E2E.");

// ---------------------------------------------------------------
// 1. Seed hồ sơ TEST (prefix [STAGING-E2E], nội dung tiếng Việt đầy đủ)
// ---------------------------------------------------------------
const tag = `[STAGING-E2E] ${new Date().toISOString().slice(0, 10)}`;
const LONG_TEXT = "Công việc trước đây tại Đà Lạt: chăm sóc hoa hồng, cắt cành, đóng gói tại nhà kính Dalat Hasfarm — đảm bảo đúng quy trình an toàn lao động, kiểm tra chất lượng sản phẩm trước khi xuất kho (long text wrapping test: đây là đoạn văn dài kiểm tra wrap dòng và căn lề trái phải, với ký tự đặc biệt: Đà Lạt, Lâm Đồng, Việt Nam, 0989.xxx.xxx, 30/4-1/5).";

const appIds = [];
for (let i = 0; i < RECORDS; i++) {
  const [app] = await q(
    `INSERT INTO daily_applications
       (cccd, full_name, gender, dob, phone, permanent_address, residential_address,
        declared_type, dw_match, status, reg_date, starting_date, custom_answers)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'NEW', 'NO_MATCH', 'ASSIGNED', $8, $9, $10)
     RETURNING id`,
    [
      `0722${String(10000000 + Math.floor(Math.random() * 89999999))}`,
      `${tag} Ứng viên ${i + 1} Nguyễn Thị Thanh Trúc`,
      i % 2 === 0 ? "Nam" : "Nữ",
      "2001-03-15",
      `091${String(1000000 + Math.floor(Math.random() * 8999999))}`,
      `Số ${12 + i} Trần Phú, Phường 3, TP. Đà Lạt, Lâm Đồng`,
      `Số ${12 + i} Trần Phú, Phường 3, TP. Đà Lạt, Lâm Đồng`,
      "2026-08-17",
      "2026-09-01",
      JSON.stringify({
        tien_an_tien_su: "Không",
        loai_cong_viec_truoc_day: "Nhân viên",
        khu_vuc_lam_viec_truoc_day: "Đà Lạt",
        cong_viec_hien_tai: "Sinh viên",
        ten_truong: "Trường Cao đẳng Đà Lạt",
        tinh_trang_tknh: "Đã có",
        so_tai_khoan: `012345678901${i}`,
        ten_ngan_hang: "Ngân hàng TMCP Ngoại thương Việt Nam (Vietcombank)",
        nguon_thu_nhap: "Chỉ phát sinh tại Dalat Hasfarm",
        tap_nghe_nguyen_vong: "Trồng, chăm sóc, thu hoạch",
        cong_viec_khac: "",
        email: `staging-e2e-${Date.now().toString(36)}-${i}@example.com`,
        so_dinh_danh_cu: "",
        so_hop_dong_dich_vu_thue: "",
        ngay_hop_dong_dich_vu_thue: "",
        ghi_chu_dai: LONG_TEXT,
      }),
    ],
  );
  appIds.push(app.id);
}
console.log(`\n✅ Seeded ${RECORDS} hồ sơ [STAGING-E2E] — ${appIds.join(", ")}`);

// ---------------------------------------------------------------
// 2. Tạo job in-process (HTML_PDF, staging)
// ---------------------------------------------------------------
const { createAsyncMergeJob } = await import("../src/lib/document-merge/async-job.ts");
const templateId = tplRows[0].id;
const job = await createAsyncMergeJob({
  templateId,
  autoRoute: false,
  records: { entityType: "daily_applications", recordIds: appIds },
  createdBy: "staging-e2e",
  scopeDeptIds: null,
  mergeMode: "INDIVIDUAL_DOCUMENTS",
  dispatchToApplicant: false,
  engine: "HTML_PDF",
});
console.log(`✅ Job created: ${job.jobId} status=${job.status} total=${job.total} engine=${job.engine}`);
const e2eStartedAt = Date.now();

// ---------------------------------------------------------------
// 3. Trigger worker + poll tới terminal
// ---------------------------------------------------------------
const runRes = await fetch(`${WORKER}/run`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` },
  body: JSON.stringify({ jobId: job.jobId }),
  signal: AbortSignal.timeout(30_000),
});
const runBody = await runRes.json().catch(() => ({}));
check("Worker /run trigger", runRes.ok, `HTTP ${runRes.status} ${JSON.stringify(runBody).slice(0, 120)}`);
if (!runRes.ok) fail(`Worker /run thất bại: ${JSON.stringify(runBody).slice(0, 300)}`);

let jobRow = null;
for (let i = 0; i < 90; i++) {
  await sleep(2000);
  const rows = await q(`SELECT * FROM merge_jobs WHERE id = $1`, [job.jobId]);
  jobRow = rows[0] ?? null;
  if (!jobRow) fail(`Job ${job.jobId} không tồn tại`);
  console.log(`   poll ${i + 1}: ${jobRow.status} completed=${jobRow.completed_count} failed=${jobRow.failed_count} progress=${jobRow.progress_percent}%`);
  if (["COMPLETED", "FAILED", "CANCELLED"].includes(jobRow.status)) break;
}
if (!jobRow || !["COMPLETED", "FAILED", "CANCELLED"].includes(jobRow.status)) fail(`Job không tới terminal sau 180s (${jobRow?.status})`);

const items = await q(
  `SELECT sort_order AS sequence, status, attempt_count, filename, file_size, sha256, storage_key, document_history_id, started_at, completed_at
   FROM merge_job_records WHERE merge_job_id = $1 ORDER BY sort_order`,
  [job.jobId],
);
const completed = items.filter((i) => i.status === "COMPLETED");
const failedItems = items.filter((i) => i.status === "FAILED");
const cancelled = items.filter((i) => i.status === "CANCELLED");

// ---------------------------------------------------------------
// 4. Verify items + document_history
// ---------------------------------------------------------------
console.log("\n--- ITEMS ---");
for (const it of items) {
  console.log(`  #${it.sequence} ${it.status} | ${it.filename} | size=${it.file_size} | sha256=${(it.sha256 ?? "").slice(0, 16)}… | attempts=${it.attempt_count}`);
}

check("Job terminal COMPLETED", jobRow.status === "COMPLETED", jobRow.status);
check(`completed + failed + cancelled = ${RECORDS}`, completed.length + failedItems.length + cancelled.length === RECORDS,
  `completed=${completed.length} failed=${failedItems.length} cancelled=${cancelled.length}`);
check("Không item thiếu/missing", items.length === RECORDS, `${items.length} items`);

let historyOkCount = 0;
const historyRows = await q(`SELECT * FROM document_history WHERE merge_job_id = $1 ORDER BY created_at`, [job.jobId]);
console.log("\n--- DOCUMENT HISTORY ---");
for (const h of historyRows) {
  const retentionYears = h.retention_until ? new Date(h.retention_until).getUTCFullYear() - new Date(h.generated_at ?? Date.now()).getUTCFullYear() : null;
  console.log(`  ${h.id} | tpl=${String(h.template_id).slice(0, 8)} v${h.template_version} | type=${h.document_type} | provider=${h.storage_provider}`);
  console.log(`    file=${h.storage_file_id} | size=${h.file_size} | sha256=${(h.sha256 ?? "").slice(0, 16)}… | retention_until=${h.retention_until} (${retentionYears}y) | archive=${h.archive_status} | by=${h.created_by}`);
}
const itemById = new Map(items.map((i) => [i.document_history_id, i]));

check("1 history row / item (không duplicate)", historyRows.length === completed.length, `${historyRows.length} rows / ${completed.length} completed`);
for (const h of historyRows) {
  const it = itemById.get(h.id);
  const ok =
    Boolean(it) &&
    Boolean(h.merge_job_id && h.merge_job_record_id) &&
    Boolean(h.template_id && h.template_version != null) &&
    Boolean(h.document_type && h.storage_provider && h.storage_file_id) &&
    Boolean(h.file_size != null && h.sha256) &&
    Boolean(h.retention_policy_snapshot) &&
    Boolean(h.created_by) &&
    h.sha256 === it?.sha256;
  const retentionYears = h.retention_until ? Math.round((new Date(h.retention_until).getTime() - Date.now()) / 31557600000) : null;
  if (ok && retentionYears != null && retentionYears >= 2) historyOkCount++;
}
check(`document_history đầy đủ (${historyOkCount}/${historyRows.length})`, historyOkCount === historyRows.length && historyRows.length === completed.length,
  "merge_job_id + merge_job_record_id + template_id + version + type + provider + file_id + size + sha256 + retention + created_by");
check("Retention ~3 năm", historyRows.every((h) => {
  const y = h.retention_until ? Math.round((new Date(h.retention_until).getTime() - new Date(h.generated_at ?? Date.now()).getTime()) / 31557600000) : null;
  return y != null && y >= 2 && y <= 4;
}), "retention_until ≈ generated_at + 3y (snapshot)");

// ---------------------------------------------------------------
// 5. Google Drive verification (dùng storage provider production)
// ---------------------------------------------------------------
let driveOk = 0;
if (process.env.STORAGE_PROVIDER === "google_drive" && DRIVE_ROOT) {
  process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID = DRIVE_ROOT;
  const { getStorageProvider } = await import("../src/lib/storage/index.ts");
  const storage = getStorageProvider();
  console.log("\n--- GOOGLE DRIVE (staging root) ---");
  for (const it of completed) {
    const meta = await storage.getMetadata(it.storage_key).catch((e) => ({ error: e.message }));
    if (meta && !meta.error) driveOk++;
    console.log(`  ${it.filename} → exists=${!meta?.error} size=${meta?.size ?? "—"} driveSha256=${(meta?.sha256 ?? "—").slice(0, 16)}`);
  }
  check(`Individual PDFs trên Drive (${driveOk}/${completed.length})`, driveOk === completed.length);

  const batchPdfMeta = await storage.getMetadata(jobRow.output_pdf_file_id).catch((e) => ({ error: e.message }));
  const batchZipMeta = await storage.getMetadata(jobRow.output_zip_file_id).catch((e) => ({ error: e.message }));
  check("Batch PDF trên Drive", Boolean(batchPdfMeta && !batchPdfMeta.error), `size=${batchPdfMeta?.size ?? "—"}`);
  check("Batch ZIP trên Drive", Boolean(batchZipMeta && !batchZipMeta.error), `size=${batchZipMeta?.size ?? "—"}`);

  // Đếm trang PDF tổng (pdf-lib — root deps)
  try {
    const { PDFDocument } = await import("pdf-lib");
    const pdfBytes = await storage.get(jobRow.output_pdf_file_id);
    const doc = await PDFDocument.load(pdfBytes);
    console.log(`  Batch PDF pages: ${doc.getPageCount()}`);
  } catch (e) {
    console.log(`  (không đọc được batch PDF — ${String(e.message).slice(0, 120)})`);
  }
} else {
  console.log("\n--- GOOGLE DRIVE: BỎ QUA (STORAGE_PROVIDER != google_drive hoặc thiếu root folder) ---");
}

// ---------------------------------------------------------------
// 6. Negative / resilience tests (worker-level, an toàn)
// ---------------------------------------------------------------
if (MODE.negative) {
  console.log("\n--- NEGATIVE / RESILIENCE ---");

  // f1: invalid jobId → controlled response (không crash)
  const badRes = await fetch(`${WORKER}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({ jobId: "00000000-0000-0000-0000-000000000000" }),
    signal: AbortSignal.timeout(20_000),
  });
  const badBody = await badRes.json().catch(() => ({}));
  check("f1 invalid jobId → controlled error", badRes.status === 500 && String(badBody.error ?? "").toLowerCase().includes("job not found"), `HTTP ${badRes.status} ${JSON.stringify(badBody).slice(0, 100)}`);

  // f2: unauthorized /run → 401
  const unauthRes = await fetch(`${WORKER}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId: job.jobId }),
    signal: AbortSignal.timeout(20_000),
  });
  check("f2 unauthorized /run → 401", unauthRes.status === 401, `HTTP ${unauthRes.status}`);

  // f3: duplicate /run trên job COMPLETED → không duplicate outputs
  const beforeHist = (await q(`SELECT count(*)::int AS c FROM document_history WHERE merge_job_id = $1`, [job.jobId]))[0].c;
  const dupRes = await fetch(`${WORKER}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({ jobId: job.jobId }),
    signal: AbortSignal.timeout(30_000),
  });
  await sleep(2000);
  const afterHist = (await q(`SELECT count(*)::int AS c FROM document_history WHERE merge_job_id = $1`, [job.jobId]))[0].c;
  const jobAfter = (await q(`SELECT status FROM merge_jobs WHERE id = $1`, [job.jobId]))[0];
  check("f3 duplicate /run không tạo duplicate history", afterHist === beforeHist, `history ${beforeHist} → ${afterHist}`);
  check("f3 job vẫn COMPLETED sau duplicate /run", jobAfter.status === "COMPLETED", jobAfter.status);

  // f4: re-run không có job QUEUED → trả về clean
  const idleRes = await fetch(`${WORKER}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(30_000),
  });
  const idleBody = await idleRes.json().catch(() => ({}));
  check("f4 re-run không queue → clean", idleRes.ok, `HTTP ${idleRes.status} ${JSON.stringify(idleBody).slice(0, 100)}`);
}

// ---------------------------------------------------------------
// 7. Summary
// ---------------------------------------------------------------
const totalMs = Date.now() - e2eStartedAt;
const perItem = items
  .filter((i) => i.started_at && i.completed_at)
  .map((i) => Math.round((new Date(i.completed_at).getTime() - new Date(i.started_at).getTime()) / 1000));
const allPass =
  jobRow.status === "COMPLETED" &&
  completed.length === RECORDS &&
  failedItems.length === 0 &&
  historyRows.length === completed.length &&
  historyOkCount === historyRows.length;

console.log("\n================================================================");
console.log(`RESULT: ${allPass ? "✅ STAGING E2E PASS" : "❌ STAGING E2E FAIL"} — records=${RECORDS}`);
console.log(`  job:            ${job.jobId} (${jobRow.status})`);
console.log(`  total duration: ${totalMs}ms`);
console.log(`  per-item:       ${perItem.join("s, ")}s`);
console.log(`  failed:         ${failedItems.length}`);
console.log(`  retries:        ${items.filter((i) => i.attempt_count > 1).length}`);
console.log(`  batch PDF:      ${jobRow.output_pdf_url ?? ""} (file_id=${jobRow.output_pdf_file_id ?? ""})`);
console.log(`  batch ZIP:      ${jobRow.output_zip_url ?? ""} (file_id=${jobRow.output_zip_file_id ?? ""})`);
console.log(`  test apps:      ${appIds.join(", ")}`);
console.log(`  history ids:    ${historyRows.map((h) => h.id).join(", ")}`);
console.log(`  drive file ids: ${completed.map((i) => i.storage_key).join(", ")}`);
console.log("================================================================");

await client.end();
process.exit(allPass ? 0 : 1);
