# Document Merge (HTML→PDF) — Production Runbook

Tài liệu này bổ sung cho `docs/PRODUCTION-DEPLOY.md` (runbook chung của
toàn bộ ứng dụng) — phạm vi ở đây CHỈ là tính năng Document Merge / engine
`HTML_PDF` (Cloud Run worker + Playwright/Chromium).

**Cập nhật 2026-09-02: hạ tầng production ĐÃ tồn tại và ĐÃ được xác nhận
healthy.** Tuyên bố "hạ tầng production CHƯA tồn tại" trước đây trong tài
liệu này đã LỖI THỜI (viết trước khi `deploy-worker-production.yml` từng
được chạy thành công lần đầu) — giữ nguyên phần dưới đây gây hiểu nhầm cho
operator tiếp theo nên đã được sửa.

Bằng chứng xác nhận (từ chính log GitHub Actions, không phải suy đoán):
`deploy-worker-production.yml` đã chạy thành công nhiều lần kể từ
2026-08-21 (lần gần nhất trước bản cập nhật này: run #17, commit
`4bd0216`, health check trả `{"ok":true}`, `/diag/*` xác nhận 404 đúng
như kỳ vọng `WORKER_ENV=production`). Cloud Run service thật:
`seasonal-worker-pdf-production`, region `asia-southeast1`, project
`seasonal-worker-505710`. Service account runtime thật ghi nhận được từ
log deploy: `seasonal-worker-merge-producti@seasonal-worker-505710.iam.gserviceaccount.com`
(khác chút ít so với quy ước `...-merge-prod@...` ở bảng mục 2 bên dưới —
giữ nguyên giá trị thật đang chạy, không đổi theo tài liệu).

`DOCUMENT_MERGE_ENGINE` production vẫn là `GOOGLE_DOCS` (mặc định an
toàn — không cần set gì để giữ nguyên hành vi hiện tại); việc worker tồn
tại KHÔNG đồng nghĩa HTML_PDF đã được kích hoạt — xem mục 1.

Còn CHƯA xác nhận được (ngoài phạm vi những gì log deploy tự chứng minh):
migration Document Merge của candidate-document consent
(`2026-09-01-candidate-document-consent.sql`, PR #127/#128) — runner định
kỳ (`migrate-production.yml`) đã đăng ký migration này nhưng lần chạy
thành công gần nhất của chính workflow đó (run #6, 2026-08-24) diễn ra
TRƯỚC khi migration này tồn tại, nên vẫn cần 1 lần chạy nữa (yêu cầu xác
nhận backup thủ công — xem `docs/PRODUCTION-DEPLOY.md` mục "Sao lưu bắt
buộc"). Cloud Scheduler watchdog (`scripts/provision-merge-worker-watchdog.sh`,
nay có thể chạy qua `provision-watchdog-production.yml`) cũng chưa
provision được — Cloud Scheduler API chưa bật trên project và identity
deploy không có quyền tự bật (`serviceusage.services.enable` bị từ chối
có chủ đích) — cần 1 thao tác bật API 1 lần trong GCP Console trước khi
chạy lại workflow đó.

## 1. Nguyên tắc bắt buộc

- `DOCUMENT_MERGE_ENGINE=HTML_PDF` **KHÔNG BAO GIỜ** được set trên Vercel
  Production bởi bất kỳ workflow tự động nào trong repo này. Không workflow
  nào trong `.github/workflows/` chạm tới biến môi trường Vercel.
- Client **không thể** chọn engine per-job (xem `src/lib/document-merge/async-job.ts`
  — `engine` không nhận từ request body, luôn resolve qua
  `getDocumentMergeEngine()` phía server). Vì vậy việc worker production tồn
  tại/deploy xong **không đồng nghĩa** với việc HTML_PDF được kích hoạt.
- Kích hoạt HTML_PDF là **quyết định thủ công, tách biệt hoàn toàn** khỏi
  việc deploy hạ tầng — xem mục 5.

## 2. Tài nguyên production (đặt tên tách biệt hoàn toàn khỏi staging)

| Loại | Staging (đã tồn tại) | Production (tạo mới, KHÔNG dùng chung) |
|---|---|---|
| Cloud Run service | `seasonal-worker-pdf-staging` | `seasonal-worker-pdf-production` |
| Artifact Registry tag | `worker-staging:<sha>` | `worker-production:<sha>` |
| Runtime service account | `seasonal-worker-merge@<project>.iam.gserviceaccount.com` | `seasonal-worker-merge-prod@<project>.iam.gserviceaccount.com` |
| GitHub Environment | `staging` | `production` |
| DB secret | `STAGING_DATABASE_URL` | `PROD_DATABASE_URL` |
| Google OAuth secrets | `STAGING_GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN` | `PROD_GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN` |
| Worker app secret | `STAGING_MERGE_WORKER_SECRET` | `PROD_MERGE_WORKER_SECRET` |
| Drive root folder | `STAGING_GOOGLE_DRIVE_ROOT_FOLDER_ID` | `PROD_GOOGLE_DRIVE_ROOT_FOLDER_ID` — **PHẢI là 1 folder Drive khác hoàn toàn** với staging (tài liệu tài khoản/quyền folder ở mục 8). |

Nếu quy ước đặt tên thực tế của tổ chức khác bảng trên, giữ nguyên quy ước
đã có — chỉ cần đảm bảo **không dùng chung** bất kỳ resource nào giữa 2 môi
trường.

## 3. Trình tự thiết lập hạ tầng (KHÔNG kích hoạt HTML_PDF)

Thực hiện đúng thứ tự — mỗi bước là 1 GitHub Actions `workflow_dispatch`
thủ công, không có gì tự động chạy khi push code:

1. **Tạo GitHub Environment `production`** (Settings → Environments) nếu
   chưa có, và thêm 6 secret: `PROD_DATABASE_URL`, `PROD_GOOGLE_CLIENT_ID`,
   `PROD_GOOGLE_CLIENT_SECRET`, `PROD_GOOGLE_REFRESH_TOKEN`,
   `PROD_MERGE_WORKER_SECRET`, `PROD_GOOGLE_DRIVE_ROOT_FOLDER_ID` (hoặc bộ
   service-account nếu dùng domain-wide delegation thay OAuth — xem
   `src/lib/storage/google-drive.ts`). Xem mục 6 để biết chính xác cách tạo
   từng secret.
2. **Backup**: tạo snapshot/branch Neon production (hoặc `pg_dump`, theo
   `docs/PRODUCTION-DEPLOY.md` mục 2).
3. Chạy workflow **"Migrate Document Merge DB — PRODUCTION"**
   (`migrate-production.yml`) — nhập `confirm=PRODUCTION` và xác nhận đã
   backup. Chỉ chạy 7 migration Document Merge (không đụng bảng khác), báo
   counts, không seed dữ liệu test. Runner này KHÔNG BAO GIỜ chứa migration
   cleanup xoá dữ liệu (sự cố 2026-08-24) lẫn migration seed body canonical
   pre-v7 (2026-08-23-trainee-registration-canonical-html-draft.sql — chỉ còn
   trong git history) — chỉ gồm migration idempotent, non-destructive, chạy
   lại an toàn.
4. Chạy workflow **"Deploy Document Merge Worker — PRODUCTION"**
   (`deploy-worker-production.yml`) — build + deploy Cloud Run service
   `seasonal-worker-pdf-production`, `--no-allow-unauthenticated`, smoke
   test `/health` (PASS) + xác nhận `/diag/*` trả 404. **Không gọi `/run`.**
5. Trên Vercel Production, thêm các biến trong bảng ở mục 6 —
   **NGOẠI TRỪ `DOCUMENT_MERGE_ENGINE`** (để nguyên mặc định `GOOGLE_DOCS`,
   hoặc set tường minh `DOCUMENT_MERGE_ENGINE=GOOGLE_DOCS` nếu muốn rõ ràng
   — cả 2 đều an toàn như nhau).
6. Gọi `GET /api/document-merge/production-readiness` (Admin) — xác nhận
   `overallStatus: "PASS"` cho DATABASE/MIGRATIONS/CLOUD_RUN/AUTH/STORAGE.
   Route này **không** tự đánh giá VISUAL_GATE/BENCHMARK_GATE (nghiêm cấm
   render thật trong route production — xem mục 5).

Sau bước 6, hạ tầng production đã sẵn sàng nhưng **HTML_PDF vẫn CHƯA được
kích hoạt** — hệ thống production tiếp tục dùng `GOOGLE_DOCS` như trước.

## 4. Production readiness — cách đọc kết quả

`GET /api/document-merge/production-readiness` (ADMIN, an toàn chạy trên
production thật — chỉ đọc, không ghi job/candidate/probe nào):

- `overallStatus: "BLOCKED"` ngay lập tức nếu `DOCUMENT_MERGE_ENGINE` đã là
  `HTML_PDF` — route từ chối đánh giá tiếp (đây là rào chắn, không phải lỗi).
- `overallStatus: "PASS"` chỉ khi DATABASE + MIGRATIONS + CLOUD_RUN + AUTH +
  STORAGE đều pass **và** engine vẫn `GOOGLE_DOCS`.
- `VISUAL_GATE`/`BENCHMARK_GATE` luôn trả `"NOT_AUTOMATED_HERE"` — 2 gate
  này **bắt buộc xác nhận thủ công** qua `worker/scripts/visual-verify.mjs`
  / `worker/scripts/benchmark.mjs`, hoặc qua Verification (staging) trước
  khi coi là đã chứng minh. Route production **không được phép** tự render
  PDF để tránh side-effect trên hạ tầng thật.

`PASS` ở đây có nghĩa **hạ tầng sẵn sàng**, không có nghĩa **HTML_PDF nên
được bật ngay**.

## 5. Điều kiện kích hoạt HTML_PDF (quyết định thủ công, sau cùng)

Chỉ set `DOCUMENT_MERGE_ENGINE=HTML_PDF` trên Vercel Production sau khi
**TẤT CẢ** các điều kiện sau đã xác nhận, theo đúng thứ tự:

1. Staging E2E (1-record + 10-record) PASS liên tục, không còn CLAIM_STALLED
   hay lỗi khác.
2. Visual diff PASS so với reference Google Docs thật
   (`worker/scripts/visual-verify.mjs`, hoặc nút "Run Visual Verification"
   trong Verification panel).
3. Benchmark PASS (`worker/scripts/benchmark.mjs`, 1/10/50/100 bản ghi,
   thời gian/tỷ lệ lỗi chấp nhận được).
4. Production worker smoke test PASS (`/health` qua Cloud Run IAM thật).
5. Production DB migration đã chạy xong, counts đã kiểm tra.
6. Production Drive/auth đã xác nhận đọc được root folder riêng (không
   phải root folder staging).
7. **Phê duyệt tường minh của người có thẩm quyền** — không phải suy luận
   từ "mọi gate tự động đều xanh".

Không có cơ chế tự động nào trong repo này được phép thực hiện bước kích
hoạt — đây luôn là 1 thao tác tay trên Vercel dashboard.

## 6. Biến môi trường Production (Vercel)

| Biến | Giá trị |
|---|---|
| `DATABASE_URL` | connection string Postgres production hiện có (không đổi) |
| `PDF_MERGE_WORKER_URL` | URL Cloud Run service `seasonal-worker-pdf-production` (in ra ở bước "Show service URL" của workflow deploy) |
| `MERGE_WORKER_SECRET` | **PHẢI khác** giá trị staging — tạo mới bằng `openssl rand -base64 32`, lưu vào GitHub secret `PROD_MERGE_WORKER_SECRET` **và** Vercel Production đồng thời |
| `GOOGLE_WIF_PROJECT_NUMBER` / `POOL_ID` / `PROVIDER_ID` / `SERVICE_ACCOUNT` | Cấu hình WIF cho Cloud Run IAM — dùng service account production (`seasonal-worker-merge-prod@...`), không phải service account staging |
| `STORAGE_PROVIDER` | `google_drive` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN` | OAuth production (tài khoản Drive production — xem mục 8), hoặc bộ service-account tương ứng |
| `GOOGLE_DRIVE_ROOT_FOLDER_ID` | Folder Drive production — **khác** staging |
| `DOCUMENT_MERGE_ENGINE` | Để mặc định, hoặc set tường minh `GOOGLE_DOCS` — **không set `HTML_PDF`** cho tới khi mục 5 hoàn tất |

**Không copy giá trị staging sang production.** Mỗi secret ở trên phải là
credential/endpoint RIÊNG.

## 7. Trạng thái template production

`GET /api/document-merge/production-readiness` → `checks.TEMPLATE` báo:
`templateCount`, `fieldCount`, `publishedVersionCount`, và trạng thái riêng
của template "Đăng ký tập nghề" (`dangKyTapNghe.hasPublishedVersion`).

Migration `2026-08-21-dang-ky-tap-nghe-html-draft.sql` chỉ seed 1 version
**DRAFT** (chưa publish) — production readiness KHÔNG được coi là "sẵn sàng
kích hoạt" chỉ vì hạ tầng pass; template vẫn cần Admin **tự tay** publish
qua Template Builder UI sau khi visual-verify xác nhận đúng (mục 5, bước 2).
Đây là 2 khái niệm tách biệt: hạ tầng sẵn sàng ≠ template đã duyệt visual.

## 8. Chiến lược Google Drive production

- Tạo 1 folder Drive **mới**, tên gợi ý `Seasonal Worker Documents
  (Production)`, dưới tài khoản Drive dùng cho production (không phải tài
  khoản/tài nguyên đang dùng cho staging).
- Lấy folder ID (chuỗi sau `/folders/` trong URL Drive), set vào secret
  `PROD_GOOGLE_DRIVE_ROOT_FOLDER_ID`.
- Code (`GoogleDriveStorageProvider`) luôn tạo/parent mọi file bên trong
  `rootFolderId` cấu hình qua `GOOGLE_DRIVE_ROOT_FOLDER_ID` — không có
  đường nào ghi ra ngoài root folder đã cấu hình.
- `production-readiness` route đọc metadata root folder (`getRootFolderMetadata()`)
  — thuần đọc, xác nhận folder tồn tại + có quyền truy cập, không tạo/sửa gì.

## 9. Rollback

### Rollback nhanh nhất (luôn ưu tiên trước)

```
DOCUMENT_MERGE_ENGINE=GOOGLE_DOCS
```

đặt lại trên Vercel Production (hoặc xoá biến — mặc định vốn đã là
`GOOGLE_DOCS`). Có hiệu lực ngay từ deployment kế tiếp, không cần revert
code, không cần rollback database.

### Vô hiệu hoá worker production

```bash
gcloud run services update-traffic seasonal-worker-pdf-production \
  --region <region> --project <project> --to-latest=false
# hoặc xoá hẳn service:
gcloud run services delete seasonal-worker-pdf-production --region <region> --project <project>
```

### Revert Vercel `PDF_MERGE_WORKER_URL`

Xoá biến hoặc trỏ về rỗng — `callWorker()` trả lỗi `CONFIG` rõ ràng thay vì
gọi nhầm 1 URL sai; job HTML_PDF (nếu vô tình được tạo) sẽ fail rõ ràng
(`CLAIM_STALLED`/timeout có log), không silent.

### Rollback 1 revision Cloud Run cụ thể

```bash
gcloud run services update-traffic seasonal-worker-pdf-production \
  --region <region> --project <project> --to-revisions <revision-name>=100
```

### Rollback database

**Không cần** — mọi migration Document Merge đều additive (`ADD COLUMN IF
NOT EXISTS` / `CREATE TABLE IF NOT EXISTS`), không có migration nào xoá cột
hay đổi kiểu dữ liệu hiện có. Không cần `DROP` gì để rollback ứng dụng.

## 10. Bảo mật (tóm tắt — chi tiết ở audit)

- Cloud Run production luôn `--no-allow-unauthenticated`.
- Xác thực 2 lớp độc lập (Cloud Run IAM qua WIF + `MERGE_WORKER_SECRET`
  app-level) — không đổi kiến trúc auth cho production.
- `/diag/*` tắt hoàn toàn (404) trên worker có `WORKER_ENV=production`.
- Không secret nào được in ra log ở bất kỳ workflow nào trong repo.
