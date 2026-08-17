# Document Merge — Audit & Migration Plan (HTML/PDF Async Engine)

**Branch:** `arena/01a00d24-seasonal-worker`
**Base:** `main` @ `50c364a` (Merge PR #58 — "Use individual Google Docs plus merged batch PDF")
**Audit date:** 2026-08-17
**Status:** AUDIT COMPLETE — CHỜ APPROVAL trước khi bắt đầu Phase 1 (code)

> Báo cáo này được viết từ source thật trong repo (`src/lib/document-merge/*`,
> `src/app/api/document-merge/*`, `src/db/schema.ts`, `migrations/*`, PR #58, PR #59),
> không giả định schema/API. Baseline đã chạy trên máy local:
> `npm run typecheck` ✅ · `npm test` 416 pass ✅ · `npm run lint` 0 error / 42 warnings (có sẵn) ✅.

---

## 1. CURRENT STATE

### 1.1 Stack tổng thể
- **Next.js 16 (App Router)** trên **Vercel** (serverless; `vercel.json` chỉ có 1 cron `/api/cron/run` mỗi ngày 20:00).
- **Neon PostgreSQL** qua `pg` + `drizzle-orm` (`src/db/index.ts`, pool lazy, 1 pool/instance).
- **Google Docs/Drive** là engine render duy nhất cho Document Merge; auth ưu tiên **OAuth user** (`GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN`), fallback **Service Account**, `GOOGLE_ACCESS_TOKEN` chỉ để debug.
- Không có object storage riêng: PDF batch upload thẳng lên **Google Drive**; ảnh branding lưu data-url trong Postgres.

### 1.2 Document Merge hiện tại (main)
| Thành phần | Hiện trạng |
| --- | --- |
| UI | `/admin/document-merge` — 4 tab: `Quản lý Templates`, `Thực hiện Merge`, `Lịch sử Merge`, `Danh mục Placeholders` (`page.tsx` + `merge-workspace.tsx` ~900 dòng, `template-library.tsx`, `resizable-mapping-table.tsx`) |
| Merge workspace | Chọn template cố định (manual) là default; checkbox `Auto Route` **OFF mặc định**; Mapping Inspector inline; Preview 1 hồ sơ (trả text content); nút merge gọi `POST /api/document-merge/merge/execute` và **CHỜ response đến khi xong toàn bộ** |
| Execute API | `POST /api/document-merge/merge/execute` — **synchronous**: render tất cả records trong 1 HTTP request; mỗi record = 1 bản copy Google Docs template + `replaceAllText` (batchUpdate); batch print = export từng Google Doc sang PDF (Drive export, read-only) → `mergePdfBuffers` (pdf-lib) → upload 1 PDF gộp lên Drive; `dispatchToApplicant` ghi link vào `daily_applications` |
| Templates | `merge_templates` — CRUD, activate/deactivate, scan placeholders, map fields; chỉ có **1 template seed** (Dang_ky_Tap_nghe, Google Doc `10D0tG71CbllIZe7DaosYNW3vK7QnP76Yq4UC9FMEiUE`, 51 placeholders đã map) |
| Placeholder system | Pattern `<<...>>`; Scanner = đọc Google Docs content → `extractUniquePlaceholders` → `autoMapAllPlaceholders` → upsert `merge_template_fields`; placeholder bị xoá khỏi doc → `is_orphaned=true` (không hiển thị); Data Resolver 7 source types (CORE_FIELD, DYNAMIC_ANSWER, RELATED_FIELD, COMPUTED_FIELD, SYSTEM_FIELD, STATIC_TEXT, CHECKBOX_OPTION); formatters, checkbox engine (☒/☐), fallback alias map, field catalog |
| Template routing | Manual selection là nguồn quyết định duy nhất khi Auto Route OFF (PR #52); khi bật: DW Cũ → kind A, DW Mới → kind B, fallback GENERIC (PR #51 bỏ fallback nguy hiểm `active[0]`) |
| Google services | `google-docs-service.ts` (copy + replace, snapshot template trong-process để giữ format), `docs-rate-limit-guard.ts` (patch global fetch: batchUpdate ≥ 1100ms/lần + retry 429, cài trong `instrumentation.ts`), `batch-format-preserver.ts` (structural copier — hiện chỉ còn là safety-net), `google-drive-pdf.ts` (export + upload), `batch-pdf.ts` (pdf-lib merge) |
| Jobs/history | `merge_jobs` (PENDING/RUNNING/COMPLETED/FAILED, output_doc_id/output_url, metadata jsonb), `merge_job_records` (PENDING/COMPLETED/FAILED, sort_order = thứ tự), `GET /api/document-merge/history`, `GET/DELETE/POST rerun /history/[id]` |
| RBAC/Data scope | `requirePermission(roles, key)` fail-closed + `getUserScope()` (user_department_scopes → null/[]/[ids]); permissions `document_merge.view/templates.manage/execute/history.view/history.delete` |
| Dispatch | `daily_applications.merged_doc_url / merged_doc_pdf_url / merged_template_id / document_sent_at / signature_data_url / confirmed_answers` — luồng ký điện tử qua `/lookup` |

### 1.3 Schema hiện tại (4 bảng merge)
- `merge_templates`: id, name, description, google_doc_id, output_folder_id, output_file_name_pattern, default_merge_mode, data_sources(jsonb), document_kind(A/B/GENERIC), is_active, created_by/updated_by, created_at/updated_at.
- `merge_template_fields`: id, template_id, placeholder, source_type, source_entity, source_field, source_path, option_value, format_type, fallback_value, is_required, is_orphaned, is_suggested, timestamps; UNIQUE(template_id, placeholder).
- `merge_jobs`: id, template_id, template_name_snapshot, merge_mode, status, record_count, output_doc_id, output_url, created_by, started_at, completed_at, error, metadata(jsonb), created_at, updated_at.
- `merge_job_records`: id, merge_job_id, source_entity, source_record_id, sort_order, status, error, created_at. **(đây chính là bảng "item" — không cần tạo bảng mới)**

### 1.4 PR #58 (đã merge, base hiện tại)
- Đổi luồng batch print: **mỗi hồ sơ = 1 Google Doc riêng** (copy template + replace placeholder — giữ format), export từng file sang PDF qua Drive API, gộp PDF bằng `pdf-lib`, upload đúng 1 PDF batch lên Output Folder, trả `printUrl` + `individualDocs` trong metadata.
- Thêm `src/lib/document-merge/google-drive-pdf.ts` (168 dòng) + `batch-pdf.ts` (17 dòng) + `pdf-lib` vào `package.json`.
- **Lỗi đi kèm**: `package-lock.json` KHÔNG được cập nhật đủ (thiếu `pdf-lib` + `@pdf-lib/*` + `tslib`) → `npm ci` fail trên máy sạch. (Đã sync bằng `npm install` trong lúc audit — 37 dòng trong lockfile; chưa commit.)

### 1.5 PR #59 (OPEN, chưa merge — attempt trước của chính task này)
Branch `arena/01a00ca4-seasonal-worker`, 4 commits (Phases 1–4), 3.544 dòng thêm:
- **Phase 1**: `docs/DOCUMENT-MERGE-ASYNC-MIGRATION.md`, migration `2026-08-20-document-merge-async-pdf.sql` (non-destructive: engine, counts, progress, error_summary, template_id/attempt_count/leased_until/retry_at/pdf_url/storage_key/started_at/completed_at/error_code/error_message + index claim), feature flag `engine-config.ts`, storage abstraction (`storage/types.ts` + `local.ts`), durable queue `queue.ts` (FOR UPDATE SKIP LOCKED, lease 60s, heartbeat, retry backoff, reclaim stall), `queue-types.ts`, `async-job.ts` (validate + snapshot mapping + tạo job/items), `POST/GET /api/document-merge/jobs`.
- **Phase 2**: `html-renderer.ts` (A4 print CSS, escape HTML, `renderApplicantHtml` — Preview = production renderer), `html-pipeline.ts`, `record-loader.ts`, `filename.ts`, template `src/document-templates/dang-ky-tap-nghe/{template.ts,schema.ts}` + `registry.ts` (bản tái dựng layout 5 phần, 51 canonical placeholder).
- **Phase 3**: `worker/` — `Dockerfile` (playwright:v1.49.0-noble), `src/index.ts` (HTTP server, Chromium pool launch 1 lần, `PDF_RENDER_CONCURRENCY` mặc định 4, claim→render→upload→complete, `GET /health`, `POST /run` Bearer `MERGE_WORKER_SECRET`, close browser khi hết việc), `README.md`, tsconfig.
- **Phase 4**: `worker-trigger.ts` — gọi Cloud Run qua `after()` (không giữ HTTP request).
- **Khoảng trống của PR #59** (tự PR ghi nhận, Phases 5–9 chưa làm): Google Drive provider production (chỉ có `local`), batch finalize (PDF tổng + ZIP), Progress UI + retry failed, Google Doc editable action, **visual regression/benchmark**, và thiếu luôn: **template versioning, document_history table, retention/archive agent, SHA-256, manifest, batch output TTL cleanup, filename uniqueness chuẩn, per-item sha256/file_size**.

---

## 2. CURRENT LIMITATIONS (xác nhận qua code)

1. **Giữ HTTP request mở cho cả batch**: 500 records → 500 lần copy Google Doc + export + upload trong 1 request Vercel → timeout function (maxDuration), browser HR phải chờ, không có progress.
2. **Phụ thuộc Google Docs/Drive quota cho PDF**: mỗi PDF = 1 bản copy Docs (write) + 1 export (read). Rate-limit guard là **in-process** (không phối hợp giữa nhiều instance Vercel), và 1100ms/write × 500 ≈ **9–10 phút chỉ riêng phần ghi**, chưa kể export/upload.
3. **Không có cơ chế retry/resume**: job FAILED khi lỗi giữa chừng (catch đánh FAILED toàn bộ job + toàn bộ records); không retry item; không reclaim; lỗi 1 record làm hỏng cả batch.
4. **Không lưu per-item output**: `merge_job_records` không có filename/file_id/sha256 → không xem/tải từng PDF cá nhân, không verify.
5. **Không có document history**: PDF batch chỉ nằm trong `merge_jobs.metadata`; PDF cá nhân không có bảng lịch sử; không biết PDF nào tạo từ template version nào; `daily_applications.merged_doc_*` chỉ ghi bản mới nhất (overwrite).
6. **Không có template versioning**: 1 dòng/1 template, sửa là ảnh hưởng PDF tương lai; không DRAFT/PUBLISH/ARCHIVED; không snapshot mapping khi tạo job (metadata có outputStrategy nhưng không có field mapping snapshot → nếu mapping đổi giữa chừng job cũ bị ảnh hưởng).
7. **Không có storage abstraction**: `google-drive-pdf.ts` hardcode Drive; không có SHA-256, retention, archive, manifest, cleanup batch output.
8. **Filename không chuẩn**: `In_hang_loat_<n>_<Date.now()>.pdf` và tên Google Doc `${kind}_${fullName}_${Date.now()}` — fullName chưa sanitize (khoảng trắng/ký tự đặc biệt), uniqueness chỉ nhờ Date.now().
9. **Preview chỉ là text content**, không phải visual; không bắt được lỗi layout/trang.
10. **API-level default Auto Route ngược nghiệp vụ**: `merge/execute` tính `shouldAutoRoute = autoRoute !== false && ...` → nếu client không gửi field `autoRoute`, server tự bật A/B, trong khi business rule (PR #52) là **manual mặc định**. UI hiện gửi `autoRoute: false` nên chưa gây lỗi, nhưng contract API cần sửa.
11. **Migration seed trùng google_doc_id**: 2 migration seed cùng Google Doc ID `10D0t...` (2026-08-15: kind mặc định GENERIC; 2026-08-16: kind B nhưng `WHERE NOT EXISTS` theo google_doc_id → **bị skip nếu template đầu đã tồn tại**). Cần xác nhận trạng thái thật trên production (tên/kind template đang active) trước khi chuyển engine.
12. **`npm ci` fail** trên máy sạch (lockfile thiếu pdf-lib — mục 1.4).
13. **History DELETE là xoá cứng** job + records (không soft-delete) — cần cân nhắc giữ audit trail.

---

## 3. WHAT TO KEEP (reuse, không xoá)

| Nhóm | Thành phần | Ghi chú |
| --- | --- | --- |
| **Google Docs engine** | `google-docs-service.ts`, `docs-rate-limit-guard.ts`, `batch-format-preserver.ts`, `google-drive-pdf.ts`, `merge/execute` | Giữ nguyên cho: (a) fallback khi `DOCUMENT_MERGE_ENGINE=GOOGLE_DOCS`; (b) action "Tạo Google Doc chỉnh sửa" cho 1 hồ sơ; (c) dispatchToApplicant 1 bản |
| **Placeholder/mapping/data** | `placeholder-extractor.ts`, `data-resolver.ts`, `auto-mapping.ts`, `formatters.ts`, `checkbox-engine.ts`, `preview-merge.ts` (fallback map), `field-catalog.ts`, `applicant-record.ts`, `signature.ts`, `vietnamese-number-words.ts` | **HTML engine sẽ tái sử dụng đúng bộ này** — không xây placeholder system mới (đúng yêu cầu F) |
| **Routing/business rules** | `template-routing.ts` (manual default, kind A/B/GENERIC, không fallback active[0]) | Giữ nguyên; sửa default server-side thành manual |
| **RBAC/data scope/audit** | `requirePermission`, `getUserScope`, `writeAudit`, bảng permissions | Job API mới phải dùng cùng lớp này; thêm job-ownership check |
| **Schema** | `merge_templates`, `merge_template_fields`, `merge_jobs`, `merge_job_records` | Mở rộng non-destructive (xem mục 5); `merge_job_records` = bảng item có sẵn |
| **PR #59 foundation** | `queue-types.ts`, `queue.ts`, `engine-config.ts`, `html-renderer.ts`, `html-pipeline.ts`, `record-loader.ts`, `filename.ts`, `storage/types.ts`, `storage/local.ts`, `async-job.ts`, jobs routes, `worker/` (Dockerfile + index.ts), `document-templates/dang-ky-tap-nghe/` | Nền tảng Phase 1–4 chất lượng tốt; cần **review + cherry-pick + bổ sung** (Drive provider, finalize, history, versioning…) — xem mục 9 |
| **Pattern resumable** | `import-jobs.ts` v3 (self-chaining `after()` + watchdog cron) | Mẫu chuẩn cho worker trigger + reclaim |

---

## 4. WHAT TO DEPRECATE (thay thế dần, KHÔNG xoá ngay)

1. **Batch print qua Google Docs** (`merge/execute` với `batchPrint=true`, nhiều records) → chuyển sang jobs API + HTML/PDF worker khi `DOCUMENT_MERGE_ENGINE=HTML_PDF`. Giữ code để rollback.
2. **`batch-format-preserver.ts`** (structural copier) → không còn dùng trong luồng chính từ PR #58; giữ cài đặt như safety-net, đánh dấu deprecated.
3. **`google-drive-pdf.ts`** (upload trực tiếp) → thay bằng `GoogleDriveStorageProvider` (cùng logic upload, qua interface).
4. **`merge_jobs.status` legacy** (PENDING/RUNNING) → chuẩn hoá QUEUED/PROCESSING/COMPLETED/FAILED/RETRY/CANCELLED với normalize cho dữ liệu cũ.
5. **Preview text-only** → Preview HTML (visual) dùng đúng renderer production (Preview = production renderer, nguyên tắc PR #59 Phase 2).

---

## 5. DB CHANGES (đề xuất, tất cả non-destructive)

> Dựa trên migration PR #59 + bổ sung. Tất cả `ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` — không DROP, không xoá dữ liệu.

### 5.1 `merge_jobs` (mở rộng)
```
engine            varchar(16)  NOT NULL DEFAULT 'GOOGLE_DOCS'   -- GOOGLE_DOCS | HTML_PDF
queued_count      integer      NOT NULL DEFAULT 0
processing_count  integer      NOT NULL DEFAULT 0
completed_count   integer      NOT NULL DEFAULT 0
failed_count      integer      NOT NULL DEFAULT 0
progress_percent  integer      NOT NULL DEFAULT 0
output_pdf_url    text                                          -- PDF tổng (batch output)
output_zip_url    text                                          -- ZIP (batch output)
output_pdf_file_id  varchar(120)                                -- Drive file id PDF tổng
output_zip_file_id  varchar(120)                                -- Drive file id ZIP
batch_expires_at  timestamptz                                   -- TTL 7–30 ngày cho batch output
error_summary     text
-- index: (status, updated_at) cho watchdog reclaim
```

### 5.2 `merge_job_records` (mở rộng — bảng item)
```
template_id       uuid          -- template đã dùng cho item này (snapshot)
attempt_count     integer       NOT NULL DEFAULT 0
leased_until      timestamptz   -- claim lease (worker crash → reclaim)
retry_at          timestamptz   -- exponential backoff
pdf_url           text          -- URL tải PDF cá nhân
storage_key       text          -- key/file_id trong storage provider
filename          varchar(255)  -- tên file chuẩn YYYYMMDD_...
file_size         bigint
sha256            char(64)
started_at        timestamptz
completed_at      timestamptz
error_code        varchar(64)
error_message     text
-- index claim: (merge_job_id, status, sort_order) WHERE status IN ('QUEUED','RETRY')
```

### 5.3 `merge_template_versions` (MỚI — Template versioning, mục E)
```
id uuid PK default gen_random_uuid()
template_id uuid NOT NULL REFERENCES merge_templates(id) ON DELETE CASCADE
version integer NOT NULL                      -- 1,2,3…
status varchar(16) NOT NULL DEFAULT 'DRAFT'   -- DRAFT | PUBLISHED | ARCHIVED
html_body text                                -- nội dung HTML (template HTML engine)
print_css text                                -- CSS print riêng (nếu có)
source_docx_name varchar(255)                 -- file DOCX gốc khi import
retention_years integer NULL                  -- 1/2/3/5/10/NULL(không tự xoá); NULL → kế thừa template
mapping_snapshot jsonb                        -- snapshot merge_template_fields lúc publish
created_by varchar(64) NOT NULL
published_at timestamptz
archived_at timestamptz
superseded_by integer NULL                    -- version thay thế
created_at timestamptz NOT NULL DEFAULT now()
UNIQUE(template_id, version)
-- Chỉ 1 version PUBLISHED/template (partial unique index)
```
- `merge_templates` thêm: `current_published_version integer`, `retention_years integer` (default 3), `html_enabled boolean` (template có bản HTML hay chỉ Google Docs).

### 5.4 `document_history` (MỚI — mục P)
```
id uuid PK
candidate_id uuid NULL
application_id uuid NULL
merge_job_id uuid NULL REFERENCES merge_jobs(id) ON DELETE SET NULL
merge_job_record_id uuid NULL
template_id uuid NULL
template_version integer NULL                 -- snapshot version lúc tạo
document_type varchar(64)                     -- 'DANG_KY_TAP_NGHE' | 'TAI_LIEU_A' | ...
generated_at timestamptz NOT NULL DEFAULT now()
filename varchar(255) NOT NULL
storage_provider varchar(32) NOT NULL         -- 'google_drive' | 'local' | ...
storage_file_id varchar(255)                  -- Drive file id / storage key
file_size bigint
sha256 char(64)
retention_until timestamptz NULL              -- generated_at + retention_years (snapshot)
retention_policy_snapshot jsonb               -- {years: 3} lúc tạo
archive_status varchar(24) NOT NULL DEFAULT 'ONLINE'
  -- ONLINE | ARCHIVED | VERIFIED | ARCHIVE_VERIFY_FAILED | ONLINE_EXPIRED
archived_at timestamptz
archive_verified_at timestamptz
archive_path text                             -- đường dẫn NAS/HDD (agent ghi)
archive_sha256 char(64)
online_deleted_at timestamptz                 -- đã xoá Drive (chỉ sau VERIFIED + hết hạn)
deletion_reason varchar(64)
created_by varchar(64)
-- index: (archive_status, retention_until), (candidate_id), (application_id), (merge_job_id)
```
- **1 record/PDF** — không overwrite; mỗi lần merge tạo mới (Candidate A 3 lần → 3 records).
- `merge_job_records` có thể thêm `document_history_id uuid` liên kết (hoặc để document_history.merge_job_record_id làm chiều ngược).

### 5.5 `archive_runs` (MỚI, nhỏ — cho Archive Agent resume)
```
id uuid PK
run_type varchar(16)            -- DAILY | WEEKLY | MANUAL
started_at timestamptz
completed_at timestamptz
status varchar(24)              -- RUNNING | COMPLETED | PARTIAL | FAILED
manifest_path text              -- đường dẫn manifest.csv đã ghi
downloaded_count integer
verified_count integer
failed_count integer
```
- Agent resume = query các `document_history` có `archive_status IN ('ONLINE','ARCHIVE_VERIFY_FAILED')` và `retention_until <= now()` (hoặc tất cả chưa archive theo cấu hình); không tải lại file đã `VERIFIED`.

### 5.6 Không cần bảng mới cho
- **Queue**: dùng `merge_jobs` + `merge_job_records` (đúng nguyên tắc J/K).
- **Batch output cleanup**: cron đọc `batch_expires_at`, xoá file Drive + clear URL.
- **Feature flag**: ENV `DOCUMENT_MERGE_ENGINE` (không cần DB).

---

## 6. ENV CHANGES

```env
# ---- Engine / queue ----
DOCUMENT_MERGE_ENGINE=GOOGLE_DOCS          # GOOGLE_DOCS (default khi migration) | HTML_PDF
MERGE_JOB_MAX_ATTEMPTS=3                   # retry tối đa
MERGE_JOB_ITEM_LEASE_SECONDS=60            # lease claim
MERGE_JOB_BATCH_TTL_DAYS=14                # TTL PDF tổng + ZIP (7–30)
MERGE_DEFAULT_RETENTION_YEARS=3            # retention mặc định

# ---- Cloud Run worker ----
CLOUD_RUN_MERGE_WORKER_URL=https://merge-pdf-worker-xxxxx-uc.a.run.app
MERGE_WORKER_SECRET=                        # Bearer token worker (secret, chỉ server)

# ---- Storage ----
STORAGE_PROVIDER=google_drive              # google_drive | local (dev/test)
# Reuse (KHÔNG tạo mới): GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
# (OAuth user làm owner — Service Account chỉ fallback, đúng PR #53)
GOOGLE_DRIVE_ROOT_FOLDER_ID=               # 'Seasonal Worker Documents' (tạo 1 lần, share cho OAuth user)
GOOGLE_DRIVE_OUTPUT_FOLDER_ID=             # legacy Output Folder (giữ để tương thích)

# ---- Archive Agent (máy HR/NAS) ----
ARCHIVE_API_URL=https://...                # backend URL
ARCHIVE_API_KEY=                           # agent key (không phải user token)
ARCHIVE_DESTINATION=D:\HR_DOCUMENT_ARCHIVE # hoặc /mnt/nas/hr_archive
ARCHIVE_MANIFEST_INTERVAL=MONTHLY          # MONTHLY | YEARLY
```
- **Không expose** ra client: DATABASE_URL, GOOGLE_REFRESH_TOKEN, GOOGLE_CLIENT_SECRET, service-account key, MERGE_WORKER_SECRET, ARCHIVE_API_KEY.

---

## 7. CLOUD RUN DESIGN

```
Vercel (POST /api/document-merge/jobs)
   │  trả jobId ngay (202)
   ▼
after() → POST {CLOUD_RUN_MERGE_WORKER_URL}/run   (Bearer MERGE_WORKER_SECRET, body {jobId})
   ▼
Cloud Run service (min-instances=0) — worker:
   start → launch Chromium 1 lần
        → claim items: SELECT … FOR UPDATE SKIP LOCKED (theo sort_order)
        → pool N page (PDF_RENDER_CONCURRENCY=4) render song song
        → mỗi item: load data → resolve placeholders (snapshot mapping) → render HTML
                    → page.pdf() → SHA-256 → upload Drive (StorageProvider)
                    → completeItem (filename, file_id, size, sha256, url) → document_history INSERT
        → failItem: RETRY (backoff 2s×2^n, max 3) → FAILED (không fail cả job)
        → heartbeat lease 60s; watchdog reclaim item PROCESSING quá 2 phút
        → khi hết pending → finalize: PDF tổng (pdf-lib) + ZIP (001_..., 002_… theo sort_order)
                    → upload Drive Batch Outputs/YYYY/MM/<jobId>/ → ghi output_pdf_url/zip_url + batch_expires_at
        → shutdown → close browser → scale về 0
```

- **Config đề xuất**: 2 vCPU / 4 GB RAM / min-instances 0 / max-instances 2–3 / concurrency 4 (ENV `PDF_RENDER_CONCURRENCY`), request timeout 60s (worker tự chạy loop tới khi queue rỗng hoặc max budget, `MAX_BATCH_ITERATIONS` chống loop vô hạn).
- **Auth**: endpoint `/run` + `/health`; `/run` yêu cầu `Authorization: Bearer MERGE_WORKER_SECRET`; Cloud Run ingress = "Require authentication" + chỉ nhận từ Vercel egress (hoặc bật `ingress: internal-and-cloud-load-balancing` + allowlist) — quyết định khi deploy.
- **Resume**: Vercel cron watchdog mỗi N phút gọi `/run` (không jobId → worker quét job QUEUED/PROCESSING bị treo và reclaim) — reuse pattern `import-jobs` v3.
- **An toàn khi worker crash**: item PROCESSING quá lease → reclaim về RETRY (attempt_count giữ nguyên, không reset) → worker khác claim lại. Neon = source of truth.

---

## 8. TEMPLATE BUILDER DESIGN (mục D + E)

Mở rộng tab `Quản lý Templates` (giữ nguyên TemplateLibrary hiện tại, thêm):
- **Create / Upload DOCX / Duplicate / Archive / Delete(soft)** template; **Advanced HTML editor** cho Admin (edit html_body + print_css của version DRAFT).
- **Workflow**: Upload DOCX → convert sang HTML/CSS (thư viện mammoth, giữ table/list/heading; nếu layout không giữ 100% → KHÔNG auto publish, bắt Admin review Preview) → Scan Placeholders (đọc `<<...>>` từ html_body — KHÔNG cần Google Docs) → Mapping Inspector (reuse) → Preview PDF (render qua worker pipeline hoặc render local nếu cài playwright) → Publish (tạo version PUBLISHED, snapshot mapping).
- **Versioning**:
  ```
  Đăng ký tập nghề: v1 ARCHIVED → v2 ARCHIVED → v3 PUBLISHED → v4 DRAFT
  ```
  - Mỗi version DRAFT/PUBLISHED/ARCHIVED; chỉ 1 PUBLISHED/template.
  - **PDF tạo ra snapshot `template_version`**; template đổi sau đó KHÔNG regenerate PDF cũ; Document History giữ version.
  - Rollback = publish version cũ (không xoá history).
- **Retention cấu hình theo template** (1/2/3/5/10 năm / Không tự xoá; default 3) — snapshot vào `document_history.retention_policy_snapshot` lúc tạo PDF; đổi sau không ảnh hưởng tài liệu cũ (trừ Admin migration có chủ đích).
- **Không hardcode Dang_ky_Tap_nghe_Template** — nó chỉ là template đầu (đã seed); mọi template mới đi qua builder.

---

## 9. STORAGE DESIGN (mục N + O)

```ts
interface StorageProvider {
  readonly name: string;
  put(key: string, body: Uint8Array|Buffer, contentType?: string): Promise<StoredObject>; // {key,url,size}
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  getDownloadUrl(key: string, expiresInSeconds?: number): Promise<string>;
  getMetadata(key: string): Promise<{size:number; sha256?:string}|null>;
}
```
- `GoogleDriveStorageProvider` — dùng OAuth user (GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN), **OAuth user làm owner** trong My Drive (KHÔNG Service Account làm owner — PR #53 + yêu cầu N); upload multipart như `google-drive-pdf.ts` hiện tại nhưng qua interface; `getDownloadUrl` = `webViewLink`/`webContentLink` (hoặc export link); `delete` = `files/delete` (chỉ khi archive VERIFIED).
- `LocalFilesystemStorageProvider` — dev/test/CI (đã có trong PR #59).
- Folder logic (tạo idempotent bằng `files.create` + cache id trong metadata):
  ```
  Seasonal Worker Documents/
    Candidate Documents/YYYY/MM/DD/
    Batch Outputs/YYYY/MM/<jobId>/
  ```
- **Neon chỉ giữ `storage_provider + storage_file_id`** (document_history) / `storage_key` (merge_job_records) — không lưu binary, không lưu URL xuyên business logic.
- Kiến trúc sẵn sàng cho `R2StorageProvider`/`GCSStorageProvider`/`S3StorageProvider` sau này (chỉ thêm class + chọn qua ENV).

---

## 10. ARCHIVE DESIGN (mục R + S + T + U)

- **Vòng đời**: `ONLINE → ARCHIVED → VERIFIED → ONLINE_EXPIRED` (xóa Drive). `ARCHIVE_VERIFY_FAILED` nếu checksum lệch.
- **Chỉ xoá Drive khi**: `retention_until <= now() AND archive_status = 'VERIFIED'`. Chưa VERIFIED → KHÔNG xoá.
- **Archive Agent**: thư mục `archive-agent/` trong repo (Node CLI, chạy daily/weekly trên máy HR hoặc NAS):
  1. Auth với backend bằng `ARCHIVE_API_KEY` (không dùng session user).
  2. `GET /api/archive/documents?status=ONLINE|ARCHIVE_VERIFY_FAILED` (phân trang).
  3. Download từ Drive qua backend-proxy hoặc `getDownloadUrl` signed (không expose token client).
  4. Lưu `D:\HR_DOCUMENT_ARCHIVE\YYYY\MM\DD\<filename>.pdf`.
  5. Tính SHA-256 local → so khớp `document_history.sha256` → `POST /api/archive/verify` → `VERIFIED` (kèm archive_path) hoặc `ARCHIVE_VERIFY_FAILED` (giữ Drive, tải lại lần sau).
  6. Resume: skip file đã VERIFIED; `archive_runs` ghi tiến trình.
- **Manifest**: `manifest.csv` theo tháng/năm (`ARCHIVE_MANIFEST_INTERVAL`), fields: generated_at, candidate_name, candidate_id, application_id, document_type, template_version, filename, file_size, sha256, archive_path, archived_at. Không chứa secrets/CCCD.
- **Retention cleanup job** (cron Vercel, `document_merge.retention`): chọn `retention_until <= now AND archive_status='VERIFIED'` → xoá Drive → `ONLINE_EXPIRED` + `online_deleted_at`; batch output hết `batch_expires_at` → xoá PDF tổng/ZIP (individual PDFs vẫn còn).

---

## 11. QUEUE / JOB DESIGN (mục I + J + K + X + Y)

- `POST /api/document-merge/jobs`: validate permission + template (active, đúng scope) + records (tồn tại, `deletedAt IS NULL`, trong `getUserScope` deptIds) → snapshot template version + mapping fields → tạo `merge_jobs` (QUEUED, engine, counts) + `merge_job_records` (QUEUED, sort_order = sequence) → trigger worker (`after()`) → **trả `{jobId, status:"QUEUED", total, engine}` ngay, HTTP 202**. Browser có thể đóng.
- **Claim an toàn**: `SELECT … FOR UPDATE SKIP LOCKED` trong 1 transaction (chống 2 worker claim cùng item / duplicate PDF); lease 60s + heartbeat; `attempt_count` tăng mỗi claim; retry backoff 2s×2^n (jitter), `max_attempts=3`; hết retry → FAILED (item-level).
- **Failure isolation**: item lỗi không fail job; job chỉ COMPLETED khi tất cả item terminal; UI có **Retry failed** (reset item FAILED → QUEUED, tăng attempt_count tối đa 3 lần retry thủ công?) và **Cancel** (items QUEUED/RETRY → CANCELLED; job CANCELLED).
- **Finalize**: khi hết pending → nếu có ≥1 COMPLETED: tạo PDF tổng (`mergePdfBuffers` — pdf-lib có sẵn) + ZIP (thư viện `archiver` hoặc `yazl`, thứ tự `sort_order`, tên `001_Ho-Ten.pdf`); upload Drive; ghi URL + `batch_expires_at`; job COMPLETED. Nếu 100% fail → job FAILED kèm error_summary.
- **Progress**: recompute count/progress_percent sau mỗi item (có thể batch-update mỗi N item để tiết kiệm write).
- **Crash safety**: Vercel restart / Cloud Run restart / network drop → item PROCESSING hết lease bị reclaim; job không mất; `merge_jobs.updated_at` watchdog cho job treo.

---

## 12. PROGRESS UI (mục Z)

Tab mới trong Merge Workspace (hoặc view job):
```
MERGE JOB  ·  ENGINE: HTML_PDF
  387 / 500   77.4%
  Completed: 387 · Processing: 4 · Queued: 107 · Failed: 2
  Elapsed: 03:31 · ETA: 01:07
  [Retry failed] [Cancel] [Download PDF tổng] [Download ZIP] [View individual files] [View errors]
```
- Poll `GET /api/document-merge/jobs/[id]` mỗi **3–5 giây** (không 1s); trả counts + items phân trang.
- Errors: hiển thị gọn (error_code + message) cho HR; **technical details expandable chỉ cho Admin** (không stack trace mặc định).
- `Download` dùng Drive `webContentLink`/signed URL (không proxy binary qua Vercel).

---

## 13. SECURITY RISKS & CONTROLS

| Risk | Control |
| --- | --- |
| Worker endpoint bị gọi trái phép | Bearer `MERGE_WORKER_SECRET` + Cloud Run auth; secret chỉ ở server |
| Client gửi arbitrary HTML → render | Worker CHỈ render: published template version + data đã validate (job snapshot); không nhận HTML từ client |
| SSRF từ HTML/assets | Renderer cấm network (`page.route` abort http/https/file), cấm `<img src>` ngoài asset whitelist, cấm script (`page.pdf` không execute JS ngoài font ready — set `javascriptEnabled:false` nếu template không cần) |
| XSS khi preview HTML | `escapeHtml` mọi giá trị placeholder trước khi fill (đã có trong PR #59) |
| PII leakage qua log | Structured logs chỉ jobId/itemId/templateVersion/duration/status/errorCode; không log CCCD/phone/address/bank/token/PDF content |
| Leak Drive token | Token chỉ ở server/worker; Archive Agent dùng API key + download qua backend; không đưa `GOOGLE_REFRESH_TOKEN` vào agent |
| Filename injection / overwrite | Sanitize filename (loại bỏ `\/:*?"<>|`, control chars, chuẩn hoá dấu cách), luôn kèm ApplicationID (uniqueness), `attempt_count` chống duplicate upload |
| ZIP slip | Validate entry name khi giải nén (nếu có) |
| RBAC/data scope/job ownership | `requirePermission` + `getUserScope` ở route; GET job/[id] kiểm tra `created_by` == session hoặc ADMIN/HR_DIRECTOR |
| Template HTML độc (Admin) | HTML editor chỉ Admin; render sandbox như trên |
| Secrets trong repo | `.env.example` chỉ placeholder; không commit `.env*`; worker secret qua Secret Manager/ENV |
| Retention cleanup sai | Chỉ xoá khi `VERIFIED + hết hạn`; xoá ghi `online_deleted_at`; audit event |

---

## 14. MIGRATION PLAN / IMPLEMENTATION ORDER

> KHÔNG commit khổng lồ; mỗi phase: typecheck + build + lint + test pass. KHÔNG tự merge main.

| Phase | Nội dung | Output |
| --- | --- | --- |
| **0** | Fix lockfile (`pdf-lib`), xác nhận template production (tên/kind), quyết định reuse PR #59 (cherry-pick 4 commits → review) | CI xanh, baseline rõ |
| **1** | Audit + architecture (BÁO CÁO NÀY) | docs + approval |
| **2** | DB schema (mục 5) + `document_history` + feature flag `DOCUMENT_MERGE_ENGINE` + storage abstraction (types/local) | migration + typecheck + tests |
| **3** | Template Builder + versioning (`merge_template_versions`, UI publish/draft/archive/rollback, retention config) | API + UI |
| **4** | DOCX import (mammoth) + HTML template engine (`src/document-templates/`, print CSS, escape) + scanner từ HTML + Mapping Inspector cập nhật (ẩn orphan) | engine render chuẩn |
| **5** | Dang_ky_Tap_nghe conversion + **Visual Regression** (render 1 candidate bằng engine mới vs reference Google Docs export → so trang/text/table/border/font/logo/checklist → visual diff báo cáo) | **GATE: đạt mới chuyển production** |
| **6** | Cloud Run Playwright worker (reuse PR #59, bổ sung Drive provider + sha256 + heartbeat + finalize hooks) + Dockerfile + deploy script | image build pass |
| **7** | Neon queue: claim/retry/resume/reclaim + watchdog cron + job/items API (`POST/GET /jobs`, `GET /jobs/[id]`) | queue vững |
| **8** | `GoogleDriveStorageProvider` (OAuth user, folder structure) | upload production |
| **9** | Individual PDF history: mỗi item → `document_history` record (sha256, retention snapshot, filename chuẩn) | history đầy đủ |
| **10** | Batch finalize: PDF tổng + ZIP + TTL cleanup cron | batch output |
| **11** | Progress UI + Retry failed + Cancel + Download | UI hoàn chỉnh |
| **12** | Archive Agent + SHA-256 verify + manifest | agent chạy được |
| **13** | Retention cleanup (chỉ xoá khi VERIFIED + hết hạn) | vòng đời đóng |
| **14** | Google Docs editable action cho 1 hồ sơ (reuse execute route, single record) | fallback giữ nguyên |
| **15** | Benchmark (1/10/50/100 → estimate 500) + security hardening + logging PII audit | báo cáo benchmark |

**Thứ tự ưu tiên** (theo yêu cầu): DATA SAFETY → FORMAT FIDELITY → CORRECTNESS → RESUMABILITY → SECURITY → PERFORMANCE → COST. Không hy sinh format để đạt benchmark.

---

## 15. DEPLOYMENT PLAN

1. **Vercel**: deploy từng phase qua Preview; ENV mới (mục 6) đặt trên Vercel; `DOCUMENT_MERGE_ENGINE=GOOGLE_DOCS` giữ nguyên tới khi Visual Regression + batch test đạt → đổi `HTML_PDF` (rollback = đổi ENV, không revert code).
2. **Migration SQL**: chạy thủ công (hoặc qua drizzle) từng file non-destructive; verify bằng query đếm.
3. **Cloud Run**: `gcloud run deploy` với Dockerfile worker; cấu hình CPU 2/RAM 4G/min 0; secret qua Secret Manager; test `POST /run` với job test.
4. **Archive Agent**: cài trên máy HR/NAS; chạy manual lần đầu (dry-run) → daily/weekly schedule.
5. **Gates trước khi switch production batch sang HTML_PDF**: typecheck/build/tests pass; Vercel Preview pass; Cloud Run image build pass; **visual verification pass**; batch test (1/10/50/100) pass; migration reviewed; không destructive migration; không delete production data; không mutate historical docs.

---

## 16. BASELINE & FINDINGS KÈM THEO

- `npm run typecheck` ✅ · `npm test` **416 pass / 0 fail** ✅ · `npm run lint` **0 error, 42 warnings (có sẵn)** ✅.
- **Finding:** `package-lock.json` thiếu `pdf-lib` (PR #58) → đã sync bằng `npm install` (37 dòng) — **chưa commit**, chờ approval đưa vào Phase 0.
- **Finding:** 2 migration seed trùng `google_doc_id` — cần xác nhận template production thực tế (tên, `document_kind`, version hiện có) trước Phase 5.
- **Finding:** `merge/execute` server-side default `autoRoute=true` khi thiếu field — cần sửa thành manual default (Phase 3/14 cùng lúc sửa route).

---

## 17. OPEN QUESTIONS (cần user quyết định)

1. **Reuse PR #59?** Đề xuất: cherry-pick 4 commits (Phase 1–4) vào branch này → review + sửa → đóng PR #59 (hoặc để đó). Nếu user muốn viết lại từ đầu, báo để điều chỉnh.
2. **Engine default khi migration**: giữ `GOOGLE_DOCS` cho tới khi visual verification đạt (đúng spec AD) — xác nhận.
3. **Archive Agent hình thức**: CLI trong repo (`archive-agent/`) chạy trên máy HR/NAS bằng Node LTS — xác nhận destination thật (D:\HR_DOCUMENT_ARCHIVE hay NAS mount) khi triển khai.
4. **Template A (Cam kết/Tái ký)**: hiện production có thể chỉ có 1 template GENERIC/B — có cần dựng thêm template A trong Phase 5 hay chỉ tập trung Dang_ky_Tap_nghe trước?
5. **ZIP library**: đề xuất `archiver` (production-grade); xác nhận không ngại thêm dependency.
