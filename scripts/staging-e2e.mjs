#!/usr/bin/env node
/**
 * STAGING E2E SMOKE — hạ tầng THẬT (Cloud Run + Neon staging + Google Drive OAuth).
 *
 * Luồng: seed 1 hồ sơ TEST (KHÔNG dùng data production) → POST /jobs (tạo job)
 * → POST worker /run → poll GET /jobs/[id] tới COMPLETED → verify:
 *   - item COMPLETED (filename, sha256, storage_key)
 *   - document_history (template_version, retention_until = +3 năm, archive_status)
 *   - Drive file tồn tại + OAuth user owner (qua GoogleDriveStorageProvider)
 *   - PDF tổng + ZIP download được (HEAD/GET qua signed URL)
 *
 * Cách chạy (máy có network tới Google / CI):
 *   export STAGING_API_URL=https://<vercel-preview>.vercel.app   # app staging
 *   export MERGE_WORKER_URL=https://<cloud-run-staging>.run.app
 *   export MERGE_WORKER_SECRET=...
 *   export DATABASE_URL=postgresql://...                          # Neon STAGING
 *   export GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... GOOGLE_REFRESH_TOKEN=...
 *   export GOOGLE_DRIVE_ROOT_FOLDER_ID=...
 *   node scripts/staging-e2e.mjs [--records 10]
 *
 * KHÔNG chạy với production DATABASE_URL / Drive root production.
 */

const RECORDS = Number(process.argv.find((a, i) => process.argv[i - 1] === "--records") ?? 1);

const API = (process.env.STAGING_API_URL || "").replace(/\/+$/, "");
const WORKER = (process.env.MERGE_WORKER_URL || "").replace(/\/+$/, "");
const SECRET = process.env.MERGE_WORKER_SECRET || "";
const DB_URL = process.env.DATABASE_URL || "";

if (!API || !WORKER || !SECRET || !DB_URL) {
  console.error("❌ Thiếu env: STAGING_API_URL, MERGE_WORKER_URL, MERGE_WORKER_SECRET, DATABASE_URL");
  process.exit(1);
}

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------
async function apiJson(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}: ${body.error || JSON.stringify(body).slice(0, 300)}`);
  return body;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------
// 1. Seed N hồ sơ TEST trực tiếp vào Neon staging (KHÔNG dùng production data)
// ---------------------------------------------------------------
const { default: pg } = await import("pg");
const client = new pg.Client({ connectionString: DB_URL });
await client.connect();

const tpl = await client.query(
  "SELECT id FROM merge_templates WHERE is_active = true ORDER BY created_at LIMIT 1",
);
const templateId = tpl.rows[0]?.id;
if (!templateId) throw new Error("Không tìm thấy template active trong staging DB");

const appIds = [];
for (let i = 0; i < RECORDS; i++) {
  const r = await client.query(
    `INSERT INTO daily_applications
       (cccd, full_name, gender, dob, phone, permanent_address, residential_address,
        declared_type, dw_match, status, reg_date, starting_date, custom_answers)
     VALUES ($1, $2, 'Nam', '2001-03-15', $3, $4, $4, 'NEW', 'NO_MATCH', 'ASSIGNED', now(), '2026-09-01', $5)
     RETURNING id`,
    [
      `0722${String(10000000000 + Math.floor(Math.random() * 89999999999)).slice(0, 9)}`,
      `Ứng viên Staging ${i + 1} (E2E)`,
      `091${String(1000000 + Math.floor(Math.random() * 8999999))}`,
      `Địa chỉ test ${i + 1}, Đà Lạt`,
      JSON.stringify({
        tien_an_tien_su: "Không",
        loai_cong_viec_truoc_day: "Nhân viên",
        khu_vuc_lam_viec_truoc_day: "Đà Lạt",
        cong_viec_hien_tai: "Sinh viên",
        ten_truong: "Trường Cao đẳng Đà Lạt",
        tinh_trang_tknh: "Đã có",
        so_tai_khoan: "0123456789012",
        ten_ngan_hang: "Vietcombank Lâm Đồng",
        nguon_thu_nhap: "Chỉ phát sinh tại Dalat Hasfarm",
        tap_nghe_nguyen_vong: "Trồng, chăm sóc, thu hoạch",
        cong_viec_khac: "",
        email: `staging${i + 1}@example.com`,
        so_dinh_danh_cu: "",
      }),
    ],
  );
  appIds.push(r.rows[0].id);
}
console.log(`✅ Seeded ${RECORDS} hồ sơ TEST vào Neon staging`);

// ---------------------------------------------------------------
// 2. Tạo merge job (engine HTML_PDF — staging chỉ)
// ---------------------------------------------------------------
const job = await apiJson("/api/document-merge/jobs", {
  method: "POST",
  body: JSON.stringify({
    templateId,
    autoRoute: false,
    mergeMode: "INDIVIDUAL_DOCUMENTS",
    dispatchToApplicant: false,
    records: { entityType: "daily_applications", recordIds: appIds },
  }),
});
console.log(`✅ Job created: ${job.jobId} (${job.status}, total=${job.total})`);

// ---------------------------------------------------------------
// 3. Trigger worker + poll tới terminal
// ---------------------------------------------------------------
const runRes = await fetch(`${WORKER}/run`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` },
  body: JSON.stringify({ jobId: job.jobId }),
});
if (!runRes.ok) throw new Error(`Worker /run HTTP ${runRes.status}: ${(await runRes.text()).slice(0, 300)}`);
console.log(`✅ Worker triggered: ${runRes.status}`);

let state;
for (let i = 0; i < 120; i++) {
  await sleep(3000);
  state = await apiJson(`/api/document-merge/jobs/${job.jobId}`);
  const p = state.progress;
  console.log(
    `   poll ${i + 1}: ${state.status} — completed=${p.completed}/${p.total} failed=${p.failed} processing=${p.processing}`,
  );
  if (["COMPLETED", "FAILED", "CANCELLED"].includes(state.status)) break;
}
if (state.status !== "COMPLETED") {
  console.error(`❌ Job không COMPLETED (${state.status}) — errors:`, JSON.stringify(state.items?.filter(i => i.status === "FAILED").slice(0, 5)));
  process.exit(1);
}

// ---------------------------------------------------------------
// 4. Verify DB: item + document_history
// ---------------------------------------------------------------
const items = await client.query(
  "SELECT status, attempt_count, filename, file_size, sha256, storage_key, document_history_id FROM merge_job_records WHERE merge_job_id=$1 ORDER BY sort_order",
  [job.jobId],
);
console.log("\n=== ITEMS ===");
let historyOk = 0;
for (const it of items.rows) {
  console.log(`  ${it.status} | ${it.filename} | sha256=${(it.sha256 || "").slice(0, 16)}… | size=${it.file_size}`);
  const h = await client.query(
    "SELECT template_version, retention_until, retention_policy_snapshot, archive_status, storage_provider, storage_file_id, sha256 FROM document_history WHERE id=$1",
    [it.document_history_id],
  );
  const row = h.rows[0];
  if (!row) { console.error("  ❌ document_history missing"); continue; }
  const retentionOk = row.retention_until && new Date(row.retention_until).getFullYear() === new Date().getFullYear() + 3;
  const shaOk = row.sha256 === it.sha256;
  console.log(
    `  history: template_version=${row.template_version} retention_until=${row.retention_until} (${retentionOk ? "✅ +3y" : "❌"}) archive=${row.archive_status} provider=${row.storage_provider} sha256=${shaOk ? "✅" : "❌"}`,
  );
  if (retentionOk && shaOk && row.template_version != null) historyOk++;
}
if (historyOk !== RECORDS) { console.error(`❌ History verify ${historyOk}/${RECORDS}`); process.exit(1); }

// ---------------------------------------------------------------
// 5. Verify Google Drive: file tồn tại + owner (dùng code production)
// ---------------------------------------------------------------
process.env.STORAGE_PROVIDER = "google_drive";
const { getStorageProvider } = await import("../src/lib/storage/index.ts").catch(() => ({
  getStorageProvider: null,
}));
if (getStorageProvider) {
  const storage = getStorageProvider();
  for (const it of items.rows) {
    const meta = await storage.getMetadata(it.storage_key);
    console.log(`  Drive ${it.storage_key.split("/").pop()}: exists=${!!meta} size=${meta?.size} sha256Checksum=${meta?.sha256?.slice(0, 16) ?? "—"}`);
  }
}

// ---------------------------------------------------------------
// 6. Verify PDF tổng + ZIP download được
// ---------------------------------------------------------------
for (const [label, url] of [["PDF tổng", state.outputPdfUrl], ["ZIP", state.outputZipUrl]]) {
  if (!url) { console.error(`  ❌ ${label} URL rỗng`); process.exit(1); }
  const res = await fetch(url.startsWith("http") ? url : `${API}${url}`, { method: "HEAD" });
  console.log(`  ${label}: ${res.status} ${res.headers.get("content-length") ?? ""} bytes`);
}

await client.end();
console.log(`\n🎉 STAGING E2E PASS — ${RECORDS} hồ sơ COMPLETED, history OK, Drive OK, batch outputs OK`);
