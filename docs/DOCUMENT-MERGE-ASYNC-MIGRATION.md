# Document Merge — Async PDF Engine Migration (Audit + Plan)

**Branch:** `arena/01a00ca4-seasonal-worker`
**Base:** `main` @ `50c364a` (Merge PR #58)
**Date:** 2026-08-16

> Đây là báo cáo AUDIT + IMPLEMENTATION PLAN theo đúng thứ tự yêu cầu:
> AUDIT TRƯỚC → sau đó mới code. Mọi thông tin dưới đây được đọc trực tiếp từ
> source thật (`src/lib/document-merge/*`, `src/app/api/document-merge/*`,
> `src/db/schema.ts`, `migrations/*`), không giả định schema/API.

---

## 1. CURRENT ARCHITECTURE (đã xác nhận qua source)

### 1.1 Document Merge UI

- `src/app/(internal)/admin/document-merge/page.tsx` — 4 tab:
  `templates` (TemplateLibrary), `merge` (MergeWorkspace), `history`, `fields`.
- `src/components/document-merge/merge-workspace.tsx` (~900 dòng) — chứa:
  - Chọn template **cố định** (manual selection) là DEFAULT.
  - `Auto Route` (checkbox, **OFF mặc định**): DW Cũ → Tài liệu A, DW Mới → Tài liệu B.
  - Mapping Inspector (inline trong `MergeWorkspace`, component `MappingInspector`).
  - Preview 1 hồ sơ (gọi `POST /api/document-merge/preview`, trả về **text content**).
  - Nút merge: "Đẩy tài liệu merge đến Người tìm việc" (dispatch) và
    "Chỉ xuất file" — cả hai đều gọi `POST /api/document-merge/merge/execute`
    và **CHỜ response cho đến khi toàn bộ merge xong** (synchronous).
- `src/components/document-merge/template-library.tsx` — quản lý template.
- `src/components/document-merge/resizable-mapping-table.tsx` — bảng mapping.

### 1.2 API routes hiện tại (document-merge)

| Route | Method | Chức năng |
| --- | --- | --- |
| `/api/document-merge/templates` | GET/POST | List / create template |
| `/api/document-merge/templates/[id]` | GET/PUT/DELETE | Detail / update / delete |
| `/api/document-merge/templates/[id]/activate` | POST | Activate template |
| `/api/document-merge/templates/[id]/scan` | POST | Scan Google Docs → placeholders → upsert mapping |
| `/api/document-merge/templates/[id]/fields` | GET/PUT | List / save mapping |
| `/api/document-merge/templates/[id]/fields/[fieldId]` | — | Single field |
| `/api/document-merge/field-catalog` | GET | Catalog field khả merge |
| `/api/document-merge/preview` | POST | Preview 1 hồ sơ (text) |
| `/api/document-merge/merge/execute` | POST | **Merge thực tế (synchronous, 1 request)** |
| `/api/document-merge/history` | GET | List jobs |
| `/api/document-merge/history/[id]` | GET/DELETE + `/rerun` | Detail / delete / rerun |

### 1.3 Schema hiện tại (merge)

- `merge_templates` — Google Doc ID + output folder + `document_kind` (A/B/GENERIC).
- `merge_template_fields` — placeholder mapping (source_type/source_field/source_path/
  option_value/format_type/fallback_value/is_required/is_orphaned/is_suggested).
- `merge_jobs` — id, template_id, template_name_snapshot, merge_mode, status
  (PENDING/RUNNING/COMPLETED/FAILED), record_count, output_doc_id, output_url,
  created_by, started_at, completed_at, error, metadata(jsonb), created_at, updated_at.
- `merge_job_records` — id, merge_job_id, source_entity, source_record_id, sort_order,
  status, error, created_at. → **ĐÂY LÀ BẢNG "ITEM" HIỆN CÓ.**

### 1.4 Mapping / Template architecture

- Placeholder pattern: `<<...>>` (`src/lib/document-merge/placeholder-extractor.ts`).
- Scanner: `POST .../scan` đọc Google Docs content → `extractUniquePlaceholders` →
  auto-map bằng `autoMapAllPlaceholders` → upsert `merge_template_fields`; placeholder
  bị xoá khỏi doc được đánh `is_orphaned=true` (không hiển thị cho user).
- Data resolver: `src/lib/document-merge/data-resolver.ts` — source types
  `CORE_FIELD / DYNAMIC_ANSWER / RELATED_FIELD / COMPUTED_FIELD / SYSTEM_FIELD /
  STATIC_TEXT / CHECKBOX_OPTION`; format types ở `formatters.ts`.
- Checkbox engine: `checkbox-engine.ts` (☒/☐).
- Flattened record: `applicant-record.ts` (`buildApplicantMergeRecord`).
- Fallback aliases: `preview-merge.ts` (`FALLBACK_PLACEHOLDER_MAP`).
- Field catalog: `field-catalog.ts`.

### 1.5 Template hiện tại (Dang_ky_Tap_nghe)

- Google Doc ID `10D0tG71CbllIZe7DaosYNW3vK7QnP76Yq4UC9FMEiUE`.
- Seed tại `migrations/2026-08-16-first-vocational-registration-template.sql`
  với **51 placeholder** được audit từ Google Doc thật (Ho_ten, Ngay_sinh,
  So_CCCD, So_dien_thoai, Dia_chi_thuong_tru, Dia_chi_tam_tru, Ngay_ky_day/month/year,
  ~20 checkbox option, …).
- **Không hardcode**: mapping thật nằm trong `merge_template_fields`, được scan/map
  động qua Mapping Inspector.

### 1.6 Google Docs service / OAuth

- `google-docs-service.ts` — `RealGoogleDocsService` + `MockGoogleDocsService`;
  copy template → replace placeholder → preserve format. Auth: OAuth refresh token
  (ưu tiên) hoặc Service Account (fallback) hoặc `GOOGLE_ACCESS_TOKEN` (debug).
- `docs-rate-limit-guard.ts` — patch global `fetch`, giới hạn `batchUpdate`
  ≥1100ms/lần, retry 429 (installed trong `instrumentation.ts`).
- `batch-format-preserver.ts` — structural merge snapshot để giữ format gốc.
- `google-drive-pdf.ts` — export Google Doc → PDF, upload PDF lên Drive.

### 1.7 Batch PDF hiện tại (điểm cần thay)

- `merge/execute/route.ts`: render TẤT CẢ records **trong 1 request** →
  mỗi record = 1 Google Doc (copy template) → export PDF từng doc →
  `mergePdfBuffers` (`batch-pdf.ts`, dùng `pdf-lib`) → upload 1 PDF gộp lên Drive.
- `dispatchToApplicant`: ghi `daily_applications.merged_doc_url/merged_doc_pdf_url/
  document_sent_at` để `/lookup` hiển thị + chữ ký điện tử.

### 1.8 Constraints đã xác nhận

- **Vercel serverless**: không có worker nền thật; hàm bị giới hạn `maxDuration`.
  Pattern resumable hiện có = **self-chaining `after()`** (xem `import-jobs.ts` v3) +
  watchdog cron (`/api/cron/run`). Import engine v3 là mẫu chuẩn để tái sử dụng.
- **Neon (Free)**: pool qua `pg` (`src/db/index.ts`, lazy). Tiết kiệm connection.
- **RBAC**: `requirePermission(roles, permissionKey)` (fail-closed, ADMIN bypass)
  + `getUserScope(session)` cho data scope.
- **Không có object storage** hiện tại: branding ảnh lưu data-url trong Postgres;
  output PDF lưu trên Google Drive.

---

## 2. TARGET ARCHITECTURE

```
Vercel/Next.js (UI + API) ──POST /api/document-merge/jobs──▶ Neon (merge_jobs + items)
        ▲                                                          │ claim (SKIP LOCKED)
        │ poll (3-5s)                                              ▼
        └──────────── progress UI ◀──────────────────── Google Cloud Run Worker
                                                          (Playwright/Chromium pool)
                                                                   │ HTML → PDF
                                                                   ▼
                                                          Object Storage (individual PDFs)
                                                                   │
                                                            Finalize: PDF tổng + ZIP
                                                                   ▼
                                                          HR download (signed URL)
```

- `DOCUMENT_MERGE_ENGINE` = `GOOGLE_DOCS` (legacy fallback) | `HTML_PDF` (mới).
- Google Docs KHÔNG bị xoá — trở thành **editable fallback** cho 1 hồ sơ.

---

## 3. GAPS (cần xây)

1. **Không có async job queue** cho merge (render nằm trong 1 request).
2. **Không có HTML/CSS print template engine** (template = Google Doc).
3. **Không có Playwright/Chromium renderer** (PDF từ Drive export).
4. **Không có object storage abstraction** (đang ghi thẳng Drive).
5. **Không có progress/resume/retry** ở tầng item (chỉ có job level).
6. **Không có PDF merger streaming/chunking** cho file lớn (pdf-lib load toàn bộ vào RAM).
7. **Không có feature flag** chuyển engine.
8. **Không có benchmark harness**.

---

## 4. MIGRATION PLAN (theo phase — mỗi phase build/typecheck/lint/test)

| Phase | Nội dung | Files chính |
| --- | --- | --- |
| **1** | Audit + DB migration (mở rộng `merge_jobs`/`merge_job_records`) + feature flag + storage abstraction + queue claim/retry/resume + `POST /api/document-merge/jobs` | `migrations/…async-pdf.sql`, `db/schema.ts`, `lib/document-merge/engine-config.ts`, `lib/document-merge/queue*.ts`, `lib/storage/*`, `app/api/document-merge/jobs/**` |
| 2 | HTML template engine + `Dang_ky_Tap_nghe` template (TSX + print.css) + visual verification | `src/document-templates/dang-ky-tap-nghe/*` |
| 3 | Playwright Cloud Run worker + Dockerfile + Chromium pool + `PDF_RENDER_CONCURRENCY` | `worker/*`, `Dockerfile` |
| 4 | Queue claim/lease/heartbeat/resume + retry (đã nền ở Phase 1, hoàn thiện wiring) | `lib/document-merge/queue.ts` |
| 5 | Object storage (GCS/S3 provider) + individual PDF upload | `lib/storage/*` |
| 6 | Batch PDF tổng (merge chunk) + ZIP | `lib/document-merge/finalize.ts` |
| 7 | Progress UI + retry failed + cancel | `components/document-merge/*` |
| 8 | Google Doc editable fallback (1 record on-demand) | route + UI action |
| 9 | Benchmark + security + regression + visual regression | `scripts/benchmark-pdf.mjs`, tests |

### Nguyên tắc an toàn

- **Không xoá/sửa Google Docs engine** (fallback + editable output).
- **Không destructive migration** (chỉ `ADD COLUMN IF NOT EXISTS` + index).
- **Không giữ request Vercel mở** khi merge 500 hồ sơ.
- **Reuse** `merge_job_records` làm bảng item (không tạo bảng trùng).
- **Neon = job state only**, không lưu PDF binary.

---

## 5. Quyết định thiết kế (Phase 1)

- **Reuse** `merge_job_records` → bổ sung cột item-level (attempt_count, lease,
  pdf_url, storage_key, error_code/message, started/completed) thay vì tạo
  `merge_job_items` trùng lặp (theo đúng chỉ dẫn "reuse thay vì tạo bảng trùng").
- **Status item**: `QUEUED / PROCESSING / COMPLETED / FAILED / RETRY / PAUSED / CANCELLED`
  (map legacy `PENDING→QUEUED`, `RUNNING→PROCESSING` để history UI không vỡ).
- **Queue = Neon durable queue** dùng `SELECT … FOR UPDATE SKIP LOCKED` qua raw SQL
  (`pool`), lease + heartbeat + `retry_at` exponential backoff, watchdog reclaim.
- **Storage abstraction** `StorageProvider` (put/get/delete/getSignedUrl/exists) +
  provider `local` (dev/test) làm mặc định; GCS/S3 provider = Phase 5.
- **Feature flag default** = `GOOGLE_DOCS` (an toàn, giữ nguyên hành vi hiện tại).
