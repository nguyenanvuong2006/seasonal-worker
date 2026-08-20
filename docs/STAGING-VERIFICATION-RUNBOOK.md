# RUNBOOK — PHASE 16: STAGING REAL E2E VERIFICATION (Cloud Run + Neon staging + Drive staging)

> Máy user YẾU → **KHÔNG clone/npm ci/chạy CLI trên máy user**. Mọi bước dưới đây
> chỉ dùng **trình duyệt** (GitHub Actions + Vercel Preview). Script `scripts/staging-e2e.mjs`
> là công cụ dành cho CI/cloud runner (xem mục 7 — tuỳ chọn), không bắt buộc chạy tay.
>
> Production không bị đụng: Neon **staging**, Drive folder **staging**, Cloud Run **staging**,
> Preview env riêng. `DOCUMENT_MERGE_ENGINE` production vẫn **GOOGLE_DOCS**.

---

## 0. Trạng thái hiện tại (đã xong — checkpoint)

| Hạng mục | Trạng thái |
|---|---|
| PR #61 | OPEN — branch `arena/01a00d24-seasonal-worker` |
| Neon STAGING migration (workflow `Migrate Document Merge DB — STAGING`) | ✅ PASS |
| Cloud Run STAGING deploy (workflow `Deploy Document Merge Worker — STAGING`) | ✅ PASS (kèm smoke `/health`) |
| Service | `seasonal-worker-pdf-staging` @ `asia-southeast1` (private, auth required) |

## 1. Chuẩn bị Vercel **Preview** env (chỉ Preview — không đụng Production env)

Project → Settings → Environment Variables → scope **Preview**:

```
DATABASE_URL=<Neon staging>
GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN=<OAuth user sở hữu Drive staging>
GOOGLE_DRIVE_ROOT_FOLDER_ID=<folder staging>
DOCUMENT_MERGE_ENGINE=HTML_PDF          # CHỈ Preview — Production vẫn GOOGLE_DOCS
PDF_MERGE_WORKER_URL=https://<cloud-run-staging>.run.app   # lấy ở mục 2
MERGE_WORKER_SECRET=<secret worker staging>
VERIFICATION_ENABLED=true               # bật tab Verification (chỉ non-production)

# Vercel OIDC → Google WIF (xem mục 1b — BẮT BUỘC để qua Cloud Run IAM):
GOOGLE_WIF_PROJECT_NUMBER=68054464426
GOOGLE_WIF_POOL_ID=vercel-staging
GOOGLE_WIF_PROVIDER_ID=vercel-preview
GOOGLE_WIF_SERVICE_ACCOUNT=seasonal-worker-merge@seasonal-worker-505710.iam.gserviceaccount.com
# VERCEL_OIDC_TOKEN: do Vercel tự inject (bật OIDC Federation trong project settings) —
# KHÔNG set thủ công.
```

> ⚠️ Kiểm tra: Production env KHÔNG có `DOCUMENT_MERGE_ENGINE=HTML_PDF`, không có `VERIFICATION_ENABLED`.
> Nếu Preview cũ đã build: push 1 commit rỗng (hoặc Redeploy) để env mới có hiệu lực.

## 1b. GCP IAM — Workload Identity Federation (BẮT BUỘC, chạy 1 lần)

> Làm trên máy có `gcloud` (operator). Chỉ tác động STAGING — không đụng production.
> PROJECT_ID = `seasonal-worker-505710`, PROJECT_NUMBER = `68054464426`, REGION = `asia-southeast1`.

1. **Kiểm tra provider pool đã tồn tại + xem attribute mapping** (không đoán mapping):

```bash
gcloud iam workload-identity-pools describe vercel-staging \
  --location=global --project=seasonal-worker-505710
gcloud iam workload-identity-pools providers describe vercel-preview \
  --workload-identity-pool=vercel-staging --location=global \
  --project=seasonal-worker-505710 --format="yaml(attributeMapping,attributeCondition)"
```

   Bắt buộc có `google.subject=assertion.sub`. Nếu chưa có provider, tạo:

```bash
gcloud iam workload-identity-pools providers create-oidc vercel-preview \
  --workload-identity-pool=vercel-staging --location=global \
  --project=seasonal-worker-505710 \
  --issuer-uri="https://oidc.vercel.com/hrstaffing" \
  --allowed-audiences="https://vercel.com/hrstaffing" \
  --attribute-mapping="google.subject=assertion.sub,attribute.environment=assertion.environment,attribute.project=assertion.project,attribute.owner=assertion.owner"
```

2. **Lấy PROJECT_NAME thật của Vercel project** (claim `sub` = `owner:hrstaffing:project:<PROJECT_NAME>:environment:preview`):
   - Cách nhanh: Vercel Dashboard → project → Settings → General → "Project Name".
   - Cách chính xác (decode token thật từ 1 preview deployment — chạy trong GH Actions hoặc
     `vercel logs` trên máy operator): giải mã payload JWT (`VERCEL_OIDC_TOKEN` hoặc header
     `x-vercel-oidc-token`) → đọc `sub` và `environment`.

3. **Grant principal → impersonate service account** (roles/iam.serviceAccountTokenCreator).
   Dùng ĐÚNG 1 trong 2 dạng sau (tuỳ mapping provider ở bước 1):

   a) Nếu provider có `attribute.environment` (khuyến nghị — không cần biết project name):

```bash
gcloud iam service-accounts add-iam-policy-binding \
  seasonal-worker-merge@seasonal-worker-505710.iam.gserviceaccount.com \
  --project=seasonal-worker-505710 \
  --role=roles/iam.serviceAccountTokenCreator \
  --member="principalSet://iam.googleapis.com/projects/68054464426/locations/global/workloadIdentityPools/vercel-staging/attribute.environment/preview"
```

   b) Nếu chỉ có `google.subject` (dùng principal theo `sub` claim — thay `<PROJECT_NAME>`):

```bash
gcloud iam service-accounts add-iam-policy-binding \
  seasonal-worker-merge@seasonal-worker-505710.iam.gserviceaccount.com \
  --project=seasonal-worker-505710 \
  --role=roles/iam.serviceAccountTokenCreator \
  --member="principal://iam.googleapis.com/projects/68054464426/locations/global/workloadIdentityPools/vercel-staging/subject/owner:hrstaffing:project:<PROJECT_NAME>:environment:preview"
```

4. **Grant service account → invoke Cloud Run** (service-level IAM, roles/run.invoker):

```bash
gcloud run services add-iam-policy-binding seasonal-worker-pdf-staging \
  --region=asia-southeast1 --project=seasonal-worker-505710 \
  --role=roles/run.invoker \
  --member="serviceAccount:seasonal-worker-merge@seasonal-worker-505710.iam.gserviceaccount.com"
```

5. **Verify binding** (không in secret):

```bash
gcloud iam service-accounts get-iam-policy seasonal-worker-merge@seasonal-worker-505710.iam.gserviceaccount.com \
  --project=seasonal-worker-505710 --flatten="bindings[].members" --filter="bindings.role:roles/iam.serviceAccountTokenCreator"
gcloud run services get-iam-policy seasonal-worker-pdf-staging \
  --region=asia-southeast1 --project=seasonal-worker-505710 --flatten="bindings[].members" --filter="bindings.role:roles/run.invoker"
```

## 2. Lấy Cloud Run URL (browser-only)

GitHub → Actions → run **Deploy Document Merge Worker — STAGING** mới nhất → bước **"Show service URL"**:
copy URL dạng `https://seasonal-worker-pdf-staging-xxxx-uc.a.run.app` → dán vào `PDF_MERGE_WORKER_URL` ở mục 1.

## 3. E2E qua Website (browser-only — path chính)

Mở **Vercel Preview URL** → đăng nhập admin → **Document Merge → tab Verification**:

| # | Nút | Mục tiêu (gate) | Kỳ vọng |
|---|---|---|---|
| 1 | **Check Database** | DATABASE | `pass:true`, counts + danh sách template/version (name, status, retention, html_len) |
| 2 | **Check Worker** | CLOUD_RUN | `pass:true`, workerStatus ok |
| 3 | **Check Google Drive** | GOOGLE_DRIVE | probe file create → metadata → delete, `pass:true` |
| 4 | **Run 1-record Test** | 1_RECORD | `pass:true`, stages: seed/job/workerTrigger/poll/items/history/finalize |
| 5 | **Run 10-record Test** | 10_RECORD | `pass:true`, completed=10 failed=0, history=10, retentionOk |
| 6 | **Run Visual Verification** | VISUAL | upload reference PDF (mục 4) → report (pageCountMatch, diff%, warnings, pass) |
| 7 | **Run Benchmark** | BENCHMARK | runs 1/10/50/100, failed=0, avg/p95 render ms |

**Template v1 DRAFT?** Check Database sẽ hiện `versions: [{version:1, status:"DRAFT"}]`.
Trước khi Run 1-record: vào **Templates tab → version 1 → Preview → Publish** (chỉ staging;
không ảnh hưởng production). Sau đó Check Database lại → `published_versions ≥ 1`.

**Đọc kết quả:** mỗi nút trả JSON — copy nguyên văn gửi lại cho tôi (hoặc ghi vào comment PR #61).
Banner PRODUCTION READY chỉ sáng khi **tất cả 7 gate PASS** — chưa đổi production engine.

## 4. Chuẩn bị reference PDF cho Visual Verification

1. Mở Google Docs template `Dang_ky_Tap_nghe` (Drive staging) → **File → Download → PDF** → `reference.pdf`.
   - Nếu doc còn `<<placeholder>>` chưa fill, reference vẫn dùng được cho các check **cấu trúc**
     (số trang 6 vs 6, page break, overflow, font, table, checkbox, tiếng Việt); diff % sẽ cao
     (dự kiến) → visual gate chưa PASS là kết quả HONEST của phase này.
   - Muốn diff sát hơn: fill các giá trị mẫu vào doc (xem `SAMPLE_FIELD_VALUES` trong
     `worker/src/verification.ts`) rồi export lại.
2. Upload `reference.pdf` vào nút **Run Visual Verification** (≤25MB, PDF).
3. Xem report: `referencePages`, `renderedPages`, `pageCountMatch` (6 vs 5 = FAIL),
   `diff[]` theo trang, `warnings[]`, `pass`. Tải `rendered.pdf` để so cạnh nhau.

## 5. Negative / resilience (qua UI + Actions)

- **UI**: tạo job bằng nút Merge thường trên Preview → bấm **Cancel** (job đang QUEUED/PROCESSING)
  → xác nhận CANCELLED; bấm **Retry** item FAILED (nếu có).
- **Worker-level** (nếu chạy mục 7): invalid jobId → `500 {"error":"job not found"}`; không token → `401`;
  duplicate `/run` → không duplicate history; re-run khi queue rỗng → `{processed:0}`.

## 6. Khi có kết quả — gửi lại cho tôi

- JSON 7 nút ở mục 3 (hoặc ảnh chụp + text), Cloud Run URL, Preview URL, deployment status.
- `reference.pdf` + `rendered.pdf` (hoặc nêu khác biệt quan sát được).
- Tôi sẽ tổng hợp → báo **recommendation** (MERGE / DO NOT MERGE / MERGE CODE KEEP GOOGLE_DOCS)
  → chờ approval. **KHÔNG merge PR, KHÔNG đổi production engine** trước khi có approval.

## 7. (Tuỳ chọn) Script E2E CLI cho CI/cloud runner — `scripts/staging-e2e.mjs`

Không bắt buộc (mục 3 đã đủ). Dành cho runner có network tới Google + secrets:

```bash
export STAGING_E2E_CONFIRM=1
export DATABASE_URL=<Neon staging> MERGE_WORKER_URL=<run.app> MERGE_WORKER_SECRET=<...>
export STORAGE_PROVIDER=google_drive
export GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... GOOGLE_REFRESH_TOKEN=... GOOGLE_DRIVE_ROOT_FOLDER_ID=...
node --import tsx scripts/staging-e2e.mjs --records 1      # 1 record
node --import tsx scripts/staging-e2e.mjs --records 10 --negative   # 10 + negatives
node --import tsx scripts/staging-e2e.mjs --dry-run        # audit template/worker/storage, không ghi gì
node --import tsx scripts/staging-e2e.mjs --cleanup        # soft-delete hồ sơ [STAGING-E2E] + liệt kê job/history
```

Script: seed prefix `[STAGING-E2E]` → tạo job in-process (HTML_PDF) → trigger worker → poll DB →
verify item/history (sha256, retention +3y, không duplicate) → Drive metadata (individual + batch PDF/ZIP)
→ negatives (invalid jobId / 401 / duplicate / idle) → in evidence (ids). Yêu cầu template version PUBLISHED.

## 8. Cleanup sau khi thu thập evidence

- Records test: `--cleanup` hoặc UI tự soft-delete (`deleted_by='verification-cleanup'` / `'staging-e2e-cleanup'`).
- Drive files test: xoá thủ công trong folder Verification/ + Batch Outputs/ (chỉ staging root).
- `merge_jobs` + `document_history`: **giữ nguyên** (snapshot/audit semantics) — chỉ xoá thủ công nếu cần và đã lưu evidence.

## 9. Stop conditions (dừng ngay nếu)

Production DB/Drive bị trỏ tới · template sai bị publish · job chạm data production thật ·
worker crash · history sai (sha256/retention/duplicate) · batch PDF/ZIP thiếu · duplicate processing ·
visual khác biệt lớn · cleanup đụng data không-test.
