# Document Merge — Async HTML/PDF Engine: Báo cáo triển khai

**Branch:** `arena/01a00d24-seasonal-worker`
**Base:** `main` @ `50c364a` (Merge PR #58)
**Ngày:** 2026-08-17
**Trạng thái:** Implementation hoàn tất theo plan đã duyệt (Phase 0–15); **VISUAL VERIFICATION PENDING** — batch production VẪN dùng `GOOGLE_DOCS`.

---

## 1. Architecture implemented

```
Vercel / Next.js (UI + API)
   POST /api/document-merge/jobs  → trả jobId ngay (202), KHÔNG giữ HTTP request
        │ after() → POST {CLOUD_RUN}/run (Bearer MERGE_WORKER_SECRET)
        ▼
Neon (source of truth — job state + metadata + document history; KHÔNG lưu binary)
        ▲ claim: SELECT … FOR UPDATE SKIP LOCKED (lease 60s + heartbeat + reclaim)
        │
Google Cloud Run (Playwright/Chromium pool — launch 1 lần, PDF_RENDER_CONCURRENCY=4)
   HTML/CSS print template → page.pdf() → SHA-256 → upload Google Drive
        ▼
Google Drive — Seasonal Worker Documents/
   Candidate Documents/YYYY/MM/DD/<YYYYMMDD_HoTen_TenTaiLieu_AppID.pdf>
   Batch Outputs/YYYY/MM/<jobId>/{PDF tổng, ZIP}   (TEMPORARY — TTL 7–30 ngày)
        ▼
Document History (Neon) — 1 record/PDF, retention 3 năm mặc định, archive lifecycle
        ▼
Archive Agent (máy HR/NAS) — download → SHA-256 verify → manifest.csv → VERIFIED
        ▼
Retention cleanup — CHỈ xoá Drive khi retention_until <= now() AND archive_status='VERIFIED'
```

Google Docs legacy engine **GIỮ NGUYÊN**: fallback khi `DOCUMENT_MERGE_ENGINE=GOOGLE_DOCS` (default) + action "Tạo Google Doc chỉnh sửa" cho 1 hồ sơ (Phase 14).

## 2. Files changed

| Nhóm | File |
| --- | --- |
| Queue/job | `src/lib/document-merge/queue.ts`, `queue-types.ts`, `async-job.ts`, `worker-trigger.ts`, `engine-config.ts`, `filename.ts`, `record-loader.ts` |
| Render | `src/lib/document-merge/html-renderer.ts`, `html-pipeline.ts`, `docx-import.ts`, `batch-finalize.ts`, `batch-pdf.ts` (có sẵn) |
| History/retention | `src/lib/document-merge/document-history.ts`, `retention.ts`, `retention-cleanup.ts`, `archive-auth.ts` |
| Template | `src/lib/document-merge/template-versions.ts`, `src/document-templates/` (registry + dang-ky-tap-nghe) |
| Storage | `src/lib/storage/types.ts`, `local.ts`, `google-drive.ts`, `index.ts` |
| API routes | `jobs` (POST/GET), `jobs/[id]` (GET + retry + cancel), `engine`, `templates/[id]/versions/*`, `templates/[id]/import-docx`, `archive/*` (documents, download, verify, runs), `retention-cleanup` |
| UI | `job-progress-panel.tsx`, `template-library.tsx` (version manager + DOCX upload), `merge-workspace.tsx` (engine-aware + Google Doc action) |
| Worker | `worker/` (Dockerfile, src/index.ts, scripts: generate-sample, visual-verify, benchmark) |
| Agent | `archive-agent/` (agent.mjs, README, .env.example) |
| DB | `src/db/schema.ts`, `schema.sql`, `migrations/` (4 file mới) |
| Docs | `docs/document-merge-async-audit-and-plan.md`, `docs/DOCUMENT-MERGE-ASYNC-MIGRATION.md`, `docs/visual-verification/` |

## 3. DB migrations (non-destructive, idempotent)

1. `migrations/2026-08-20-document-merge-async-pdf.sql` — Phase 1 (PR #59): `merge_jobs.engine/queued_count/processing_count/completed_count/failed_count/progress_percent/output_pdf_url/output_zip_url/error_summary`; `merge_job_records.template_id/attempt_count/leased_until/retry_at/pdf_url/storage_key/started_at/completed_at/error_code/error_message`; index claim `(merge_job_id, status, sort_order) WHERE status IN ('QUEUED','RETRY')`.
2. `migrations/2026-08-17-document-merge-async-phase2.sql` — `merge_jobs.output_pdf_file_id/output_zip_file_id/batch_expires_at`; `merge_job_records.filename/file_size/sha256/document_history_id`; **`merge_template_versions`** (version, status DRAFT/PUBLISHED/ARCHIVED, html_body, print_css, source_docx_name, retention_years, mapping_snapshot, partial unique 1 PUBLISHED); **`document_history`** (candidate_id, application_id, merge_job_id, template_id, template_version, generated_at, filename, storage_provider, storage_file_id, file_size, sha256, retention_until, retention_policy_snapshot, archive_status, archived_at, archive_verified_at, archive_path, archive_sha256, online_deleted_at, deletion_reason, created_by); **`archive_runs`**; `merge_templates.retention_years/html_enabled`.
3. `migrations/2026-08-17-document-merge-template-versions.sql` — `merge_templates.current_published_version`.
4. `migrations/2026-08-21-dang-ky-tap-nghe-html-draft.sql` — seed version **v1 DRAFT** của Dang_ky_Tap_nghe (htmlBody/printCss lấy từ template.ts — không transcription tay), `html_enabled=true`; **KHÔNG publish**.

## 4. ENV variables

```env
DOCUMENT_MERGE_ENGINE=GOOGLE_DOCS        # GOOGLE_DOCS (default) | HTML_PDF — rollback = đổi ENV
PDF_MERGE_WORKER_URL=                    # Cloud Run service URL
MERGE_WORKER_SECRET=                     # Bearer token worker (server-only)
MERGE_JOB_MAX_ATTEMPTS=3
MERGE_JOB_ITEM_LEASE_SECONDS=60
MERGE_JOB_BATCH_TTL_DAYS=14              # 7–30
MERGE_DEFAULT_RETENTION_YEARS=3
STORAGE_PROVIDER=google_drive            # google_drive | local
GOOGLE_DRIVE_ROOT_FOLDER_ID=             # 'Seasonal Worker Documents' (tạo 1 lần)
GOOGLE_DRIVE_OUTPUT_FOLDER_ID=           # legacy
ARCHIVE_API_URL= / ARCHIVE_API_KEY= / ARCHIVE_DESTINATION= / ARCHIVE_MANIFEST_INTERVAL=MONTHLY
```
Reuse (không tạo mới): `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` (OAuth user làm owner — Service Account chỉ fallback), `CRON_SECRET`.

## 5. Cloud Run configuration

- `worker/Dockerfile` — base `mcr.microsoft.com/playwright:v1.49.0-noble` (Chromium + deps), `node --import tsx worker/src/index.ts`, PORT 8080.
- Đề xuất: **2 vCPU / 4 GB / min-instances 0 / max-instances 2–3 / `PDF_RENDER_CONCURRENCY=4`** / timeout 3600s / `--no-allow-unauthenticated` (Vercel qua service account `run.invoker`).
- Endpoints: `GET /health`, `POST /run` (Bearer `MERGE_WORKER_SECRET`; body `{jobId}` hoặc rỗng = watchdog quét job QUEUED).
- Worker: launch Chromium **1 lần** → claim items → render song song → complete/fail → finalize → close browser → scale về 0.

## 6. Template Builder implementation

- Tab "Quản lý Templates" mở rộng: section **Phiên bản Template** — danh sách v1/v2/v3… với badge DRAFT/PUBLISHED/ARCHIVED, retention, snapshot count; nút Publish/Archive/Rollback; **Advanced HTML editor** (htmlBody + printCss) và **Upload DOCX** cho Admin.
- Publish = transaction: snapshot mapping (không-orphaned) vào `mapping_snapshot`; version PUBLISHED cũ → ARCHIVED + `superseded_by`; cập nhật `current_published_version`. Chỉ 1 PUBLISHED/template (DB unique index). Rollback = publish lại version cũ — không xoá history.
- `Dang_ky_Tap_nghe` chỉ là template đầu tiên; hệ thống generic — không hardcode.

## 7. DOCX import behavior

- `POST /templates/[id]/import-docx` (multipart, ≤10MB): mammoth convert → HTML (styleMap heading/table, ảnh nhúng data-uri ≤800KB) → **luôn tạo version DRAFT** (`source_docx_name` + html_body) → scan placeholders → trả warnings.
- **KHÔNG tự publish**: conversion không giữ layout 100% → Admin phải Preview/Publish thủ công (đúng spec D). UI cảnh báo rõ.

## 8. Queue implementation

- Neon là durable queue: `merge_jobs` (job) + `merge_job_records` (item). Không Redis.
- **Claim an toàn**: `SELECT … FOR UPDATE SKIP LOCKED` trong transaction — chống double claim/duplicate file; lease 60s + heartbeat; `attempt_count` tăng mỗi claim.
- **Retry**: `max_attempts=3`, exponential backoff có jitter (`retryBackoffSeconds`), không retry vô hạn; item lỗi → RETRY → FAILED (không fail cả job).
- **Reclaim**: item PROCESSING quá lease → RETRY (giữ attempt_count) — worker crash/Cloud Run restart không mất job.
- **Retry failed / Cancel** (Phase 7): `POST /jobs/[id]/retry` chỉ đụng item FAILED (KHÔNG chạy lại COMPLETED); `POST /jobs/[id]/cancel` → item QUEUED/RETRY/PROCESSING → CANCELLED, COMPLETED giữ nguyên.
- POST /jobs chỉ validate + snapshot + tạo job/items + trigger worker (`after()`) → trả `{jobId, status:"QUEUED", total}` ngay — browser có thể đóng.

## 9. Google Drive storage implementation

- `GoogleDriveStorageProvider` (spec O): `put/get/delete/exists/getSignedUrl/getMetadata`; OAuth user làm owner My Drive (Service Account fallback); folder idempotent + cache; multipart upload; `sha256Checksum` từ Drive.
- `StorageProvider` abstraction giữ nguyên — sẵn sàng R2/GCS/S3 sau này (chỉ thêm class + ENV).
- Neon chỉ lưu `storage_provider + storage_file_id/key` — không binary, không URL xuyên business logic.

## 10. Document History

- `document_history` — **1 record/PDF, không overwrite**; ghi khi worker hoàn thành item: `template_id + template_version`, `filename` chuẩn, `storage_provider/file_id`, `file_size`, `sha256`, `retention_until + retention_policy_snapshot`, `created_by`. Liên kết `merge_job_records.document_history_id`.
- Candidate đăng ký nhiều lần → nhiều records cùng tồn tại tới khi retention từng record kết thúc.

## 11. Retention

- Mặc định **3 năm** kể từ ngày merge (tính RIÊNG từng PDF). Options 1/2/3/5/10/"Không tự xoá". Policy snapshot vào `document_history.retention_policy_snapshot` lúc tạo — đổi template sau KHÔNG tự sửa tài liệu cũ.
- `retention-cleanup` (cron/admin): CHỈ xoá Drive khi `retention_until <= now() AND archive_status='VERIFIED'`; chưa VERIFIED → skip (đếm riêng). Batch outputs hết TTL → xoá PDF tổng/ZIP, individual giữ nguyên.

## 12. Archive Agent

- `archive-agent/agent.mjs` — Node ≥18, **không dependency**: mở phiên → list documents → download qua backend proxy (không lộ Drive token) → lưu `ARCHIVE_DESTINATION/YYYY/MM/DD/<filename>.pdf` → SHA-256 local → verify → manifest → đóng phiên.
- Resume: skip file VERIFIED; lỗi 1 file không dừng run; `--dry-run` an toàn. Chạy daily/weekly (Task Scheduler/cron).
- Backend: `GET /api/archive/documents` (phân trang + candidateName), `GET .../download` (X-Expected-SHA256 header, chặn VERIFIED/đã xoá), `POST /verify`, `POST /runs[/complete]`. Auth: `ARCHIVE_API_KEY` (timingSafeEqual) hoặc ADMIN.

## 13. SHA-256 verification

- Mỗi PDF khi tạo: worker tính SHA-256 (node:crypto) → lưu `merge_job_records.sha256` + `document_history.sha256`.
- Agent tải lại → tính SHA-256 local → so khớp: match → `VERIFIED`; mismatch → `ARCHIVE_VERIFY_FAILED` (GIỮ Drive, tải lại lần sau — không bao giờ xoá online khi chưa verified).
- `GoogleDriveStorageProvider.getMetadata` cũng đọc `sha256Checksum` của Drive để đối chiếu.

## 14. Manifest

- Agent ghi `manifest-YYYY-MM.csv` (MONTHLY) hoặc `manifest-YYYY.csv` (YEARLY) tại `ARCHIVE_DESTINATION` — index độc lập với website.
- Fields: generated_at, candidate_name, candidate_id, application_id, document_type, template_version, filename, file_size, sha256, archive_path, archived_at. Không secrets, không CCCD.

## 15. PDF/ZIP behavior

- Individual: `YYYYMMDD_HoTen_TenTaiLieu_ApplicationID.pdf` (bỏ dấu, sanitize ký tự filesystem, AppID đảm bảo uniqueness — không overwrite).
- Batch finalize (Phase 10): gộp theo `sort_order` (pdf-lib) → `Dang-ky-tap-nghe_N_ung-vien.pdf`; ZIP entry `001_…`, `002_…` (yazl). Upload `Batch Outputs/YYYY/MM/<jobId>/`; **TEMPORARY** — `batchExpiresAt` = now + TTL (7–30 ngày), cleanup tự xoá; individual PDFs giữ nguyên.

## 16. Google Docs fallback

- Legacy engine **giữ nguyên**: `merge/execute`, `google-docs-service.ts`, rate-limit guard, batch-format-preserver (safety-net), OAuth user ưu tiên.
- Khi `DOCUMENT_MERGE_ENGINE=GOOGLE_DOCS` (default hiện tại): UI dùng đúng luồng cũ.
- **Phase 14**: nút "Google Doc" trên từng dòng hồ sơ — tạo Google Doc chỉnh sửa cho MỘT hồ sơ (luôn legacy, không phụ thuộc flag, không tự động cho batch — spec AA).

## 17. Security controls

- Worker endpoint: Bearer `MERGE_WORKER_SECRET` + Cloud Run `--no-allow-unauthenticated`.
- **SSRF guard** (Phase 15): `page.route` abort mọi request HTTP/WS từ HTML render (chỉ cho `data:` — ảnh nhúng DOCX); template chỉ là published version + data validated (không nhận arbitrary HTML từ client).
- Escape HTML mọi giá trị placeholder (`escapeHtml`) — chống XSS/preview vỡ markup.
- Secrets không expose client: `DATABASE_URL`, `GOOGLE_REFRESH_TOKEN`, `GOOGLE_CLIENT_SECRET`, `MERGE_WORKER_SECRET`, `ARCHIVE_API_KEY` chỉ server/agent.
- RBAC/data scope/job ownership: `requirePermission` + `getUserScope`; retry/cancel kiểm tra `created_by` (hoặc ADMIN); archive routes chỉ agent-key hoặc ADMIN.
- Structured logs: chỉ jobId/sequence/ms/status/errorCode — **không log CCCD/phone/address/PII/PDF content/token** (worker + retention log JSON).
- Filename sanitize chống path traversal/injection; ZIP entry name cố định `NNN_<sanitized>`.
- Retention cleanup: không bao giờ xoá online khi chưa VERIFIED.

## 18. Benchmark results

- `worker/scripts/benchmark.mjs` — render thật qua Chromium với template + dữ liệu mẫu; đo records/duration_ms/avg_render_ms/p95_render_ms/failed/concurrency/pdf_merge_ms → `docs/visual-verification/benchmark.json`.
- **PENDING**: sandbox không tải được Chromium (CDN bị chặn, không root apt) → chưa có số liệu thật. **KHÔNG fake benchmark.** Chạy khi có Cloud Run/CI: `cd worker && npx playwright install chromium && npm run benchmark` (mốc 1/10/50/100, sau đó ước lượng 500). Target: ~3–7 phút cho 500 (~3000 trang) ở 4 concurrency.

## 19. Known limitations

1. **VISUAL_VERIFICATION_PENDING (CRITICAL)**: HTML Dang_ky_Tap_nghe hiện tái dựng **5 trang**; reference Google Docs được kỳ vọng **~6 trang** → chưa PASS; nếu reference thực tế 6 trang mà HTML chỉ 5 trang → FAILURE phải sửa. Batch production VẪN `GOOGLE_DOCS`.
2. Chromium không tải được trong sandbox hiện tại → visual verify + benchmark phải chạy ở máy có browser/CI/Cloud Run (harness + sample HTML + script đã sẵn sàng).
3. Worker queue + Drive upload chưa được chạy end-to-end với DB thật (không có Neon/Drive credentials trong sandbox) — unit tests phủ logic, cần smoke test production.
4. Template A (Cam kết/Tái ký) chưa có HTML version (theo quyết định: chỉ Dang_ky_Tap_nghe trước).
5. Auto Route server-side: `merge/execute` legacy vẫn mặc định autoRoute khi thiếu field (UI luôn gửi false; jobs API xử lý đúng `autoRoute === true`). Không ảnh hưởng luồng chính.
6. Migration seed trùng google_doc_id (2 migration cũ) — cần xác nhận trạng thái template production trước Phase 5 deploy.
7. `npm ci` clean-machine cần lockfile đã sync (đã sửa).

## 20. Rollback instructions

- **Batch engine**: đổi ENV `DOCUMENT_MERGE_ENGINE=GOOGLE_DOCS` (mặc định) — không cần revert code. UI tự quay về luồng merge/execute cũ.
- **DB**: tất cả migration non-destructive (`ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS`) — không cần rollback; các bảng mới chỉ được đọc khi engine HTML_PDF bật.
- **Cloud Run**: xoá service hoặc đổi `PDF_MERGE_WORKER_URL` rỗng → worker không được trigger (job giữ QUEUED, watchdog không có worker thì vô hại).
- **Archive/retention**: chỉ xoá khi VERIFIED + hết hạn; tắt cron retention-cleanup nếu cần đóng băng.

## 21. PR URL

**https://github.com/nguyenanvuong2006/seasonal-worker/pull/61** — `arena/01a00d24-seasonal-worker` → `main`.

## 22. Commit SHAs

```
ee99969  Phase 8+10 — Google Drive storage provider + batch finalize (PDF tổng + ZIP)
3617c79  Phase 0–5 — foundation (queue/worker/DB/versioning/DOCX/HTML draft/visual harness)
392f1a9  Phase 14 — Google Docs editable action cho 1 hồ sơ
d41c1ea  Phase 13 — retention cleanup
1b5ab52  Phase 12 — Archive Agent + SHA-256 verify + manifest
c051373  Phase 11 — Merge Job Progress UI
98874ae  Phase 7 — retry failed / cancel job APIs + job detail upgrade
```
(History Phase 0–5/8+10 được restore vào branch sau khi sandbox reset git; nội dung nguyên vẹn từ working tree đã verify qua gates.)

---

## GATES

- `npm run typecheck` ✅ · `worker: tsc` ✅ · `npm test` **459/459** ✅ · `npm run lint` **0 error** (43 warnings có sẵn) ✅ · `next build` ✅.
- **Visual verification: PENDING** — bắt buộc chạy `worker/scripts/visual-verify.mjs` ở môi trường có Chromium + so sánh với reference Google Docs export trước khi đổi `DOCUMENT_MERGE_ENGINE=HTML_PDF`.
- **Benchmark: PENDING** — không fake; chạy `worker/scripts/benchmark.mjs` (1/10/50/100) khi có infrastructure.

---

# PHỤ LỤC — STAGING VERIFICATION (2026-08-17, sandbox)

## Môi trường staging (sandbox — KHÔNG phải production)

| Thành phần | Trạng thái |
| --- | --- |
| PostgreSQL 18.4 | ✅ Embedded local (tương đương Neon) — schema core + toàn bộ migrations + seed |
| Chromium 149 | ✅ @sparticuz/chromium (qua npm, LD_LIBRARY_PATH=al2023 libs) — render PDF THẬT |
| Worker | ✅ Code production (`worker/src/index.ts`), storage local, concurrency 2 |
| Google Cloud Run | ⛔ KHÔNG deploy được — sandbox không có gcloud/credentials; cấu hình + Dockerfile sẵn sàng |
| Neon staging thật | ⛔ Không có credentials trong sandbox — dùng PG 18 local tương đương |
| Google Drive OAuth | ⛔ googleapis.com bị chặn network + không credentials — dùng LocalStorageProvider (cùng StorageProvider interface) |
| Production engine | ✅ VẪN GOOGLE_DOCS (không đổi) |

## Smoke test E2E (1 hồ sơ test — queue → claim → render → PDF → SHA-256 → storage → history → COMPLETED)

- Job: `f2d9f9a4-9f8d-4568-98bd-c59e0aeb2b18` — **COMPLETED**, progress 100%, engine HTML_PDF (chỉ staging)
- Item: COMPLETED, attempt 1, filename `20260817_Nguyen-Van-An-(STAGING)_Dang-ky-tap-nghe_<appId>.pdf`
- PDF cá nhân: **6 trang**, 39,621 bytes, **SHA-256 khớp DB** (66b521c8…)
- PDF tổng + ZIP: đã tạo tại `Batch Outputs/2026/08/<jobId>/`, **batch_expires_at = +14 ngày**
- Document History: 1 record — `document_type=Dang-ky-tap-nghe`, `template_version=1`, `retention_until=2029-08-17` (+3 năm), `archive_status=ONLINE`
- 0 retry, 0 failed

## Visual verification (Chromium 149 THẬT)

- `pageDivCount=5` (5 phần tài liệu) nhưng **`realPdfPageCount=6`** (Giấy đăng ký dài → 2 trang; Tờ khai thuế tràn 2pt → khối ký giữ nguyên nhờ break-inside:avoid)
- **6 trang PDF = reference kỳ vọng ~6 trang → KHỚP SỐ TRANG**
- 0 blank page · 0 horizontal overflow · 22 checkbox · 0 placeholder sót · font DejaVu check tiếng Việt = true
- **LƯU Ý**: reference là "kỳ vọng ~6 trang" (không truy cập được Google Docs export thật từ sandbox) — cần đối chiếu pixel với bản export gốc khi có Drive access trước khi bật production HTML_PDF

## Benchmark (render thuần, concurrency 2, Chromium thật)

| Records | duration_ms | avg_render_ms | p95_render_ms | failed |
| --- | --- | --- | --- | --- |
| 1 | 71 | 29 | 29 | 0 |
| 10 | 217 | 33 | 41 | 0 |
| 50 | 935 | 32 | 40 | 0 |
| 100 | 2,123 | 36 | 49 | 0 |

- Ước lượng 500 records (render-only, concurrency 2): ~10–11s; Cloud Run concurrency 4 sẽ nhanh hơn. Target 3–7 phút — dư sức.
- zip_ms/upload_ms = 0 (chưa có network/storage thật trong benchmark) — đo ở Cloud Run khi deploy.

## Bugs tìm & fix qua smoke (commit 244679d)

1. `finalizeJob` ghi đè output urls bằng null → worker truyền output từ finalizeBatchOutputs.
2. Job metadata thiếu template version → history template_version=NULL → snapshot version + retentionYears từ published version.
3. Worker hardcode retentionYears=null ("không tự xoá") → giờ lấy từ snapshot (fallback 3 năm).
4. `schema.sql` dòng 946 thiếu `--` → fix.
5. Print CSS: break-inside avoid (hết orphan dòng ở Tờ khai thuế).
