# RUNBOOK — Staging Verification trên hạ tầng THẬT (Cloud Run + Neon + Google Drive)

> Dành cho người vận hành chạy trên máy có network tới Google (không phải sandbox).
> Mục tiêu: verify E2E **1 hồ sơ** rồi **10 hồ sơ** TRƯỚC khi merge PR #61.
> Production KHÔNG bị ảnh hưởng: dùng Neon **staging** + Drive folder **staging** + service Cloud Run **staging** riêng.

---

## 0. Prerequisites

- Node.js ≥ 20 (có `npm`), `git`, `gcloud` CLI đã auth (`gcloud auth login`), project GCP đã chọn.
- **Neon**: tạo project/branch **STAGING** (mới, không phải production) → lấy `DATABASE_URL`.
- **Google Drive**: tạo folder staging `Seasonal Worker Documents STAGING` → lấy `GOOGLE_DRIVE_ROOT_FOLDER_ID`; dùng OAuth user **có quyền** với folder đó.
- **Vercel**: project đã link repo; chuẩn bị set env cho **Preview environment** (xem bước 3).

## 1. Clone branch + cài deps

```bash
git clone -b arena/01a00d24-seasonal-worker https://github.com/nguyenanvuong2006/seasonal-worker.git
cd seasonal-worker
npm ci
cd worker && npm ci && cd ..
```

## 2. Migrations trên Neon STAGING

```bash
export DATABASE_URL=postgresql://USER:PASS@HOST/neondb   # ⚠️ STAGING — KHÔNG dùng production
node scripts/run-migrations.mjs
# Kỳ vọng: 22/22 PASS (gồm 2026-08-21-dang-ky-tap-nghe-html-draft.sql — seed version DRAFT v1)
```

> Lưu ý: version v1 là **DRAFT** (không auto-publish — spec D/H). Để E2E dùng HTML engine,
> publish thủ công qua UI Template Builder (Publish v1) **hoặc** chạy SQL staging:
> ```sql
> UPDATE merge_template_versions SET status='PUBLISHED', published_at=now()
> WHERE template_id=(SELECT id FROM merge_templates WHERE google_doc_id='10D0tG71CbllIZe7DaosYNW3vK7QnP76Yq4UC9FMEiUE') AND version=1;
> UPDATE merge_templates SET current_published_version=1 WHERE google_doc_id='10D0tG71CbllIZe7DaosYNW3vK7QnP76Yq4UC9FMEiUE';
> ```

## 3. Deploy Cloud Run staging worker

```bash
export DATABASE_URL=...            # Neon STAGING
export GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... GOOGLE_REFRESH_TOKEN=...
export GOOGLE_DRIVE_ROOT_FOLDER_ID=...   # folder STAGING
export MERGE_WORKER_SECRET=$(openssl rand -hex 32)   # giữ giá trị này
export GCP_PROJECT=...
./worker/deploy-staging.sh
# Output: URL service (vd https://seasonal-worker-pdf-staging-xxxx-uc.a.run.app) + MERGE_WORKER_SECRET
```

## 4. Cấu hình Vercel **Preview** (chỉ Preview — không đụng Production env)

Project → Settings → Environment Variables → scope **Preview**:

```
DATABASE_URL=<Neon staging>
GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN=<OAuth user>
GOOGLE_DRIVE_ROOT_FOLDER_ID=<folder staging>
DOCUMENT_MERGE_ENGINE=HTML_PDF          # CHỈ Preview — Production vẫn GOOGLE_DOCS
PDF_MERGE_WORKER_URL=<URL Cloud Run staging từ bước 3>
MERGE_WORKER_SECRET=<giá trị ở bước 3>
```

Deploy lại preview (push commit rỗng hoặc redeploy) → lấy **Preview URL** (vd `https://seasonal-worker-xxxx.vercel.app`).

> ⚠️ Kiểm tra: Production env KHÔNG có `DOCUMENT_MERGE_ENGINE=HTML_PDF`.

## 5. E2E smoke — 1 hồ sơ TEST

```bash
export STAGING_API_URL=https://<preview-url>.vercel.app
export MERGE_WORKER_URL=https://<cloud-run-staging>.run.app
export MERGE_WORKER_SECRET=<giá trị bước 3>
export DATABASE_URL=<Neon staging>
export GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... GOOGLE_REFRESH_TOKEN=...
export GOOGLE_DRIVE_ROOT_FOLDER_ID=...
node --import tsx scripts/staging-e2e.mjs --records 1
```

Kỳ vọng output:
```
✅ Seeded 1 hồ sơ TEST
✅ Job created: <uuid> (QUEUED, total=1)
✅ Worker triggered: 200
   poll N: COMPLETED — completed=1/1 failed=0
✅ ITEMS: COMPLETED | 2026MMDD_<Ten>_Dang-ky-tap-nghe_<appId>.pdf | sha256=… | size=…
   history: template_version=1 retention_until=<+3 năm> (✅) archive=ONLINE provider=google_drive sha256=✅
✅ Drive <filename>: exists=true size=… sha256Checksum=…
✅ PDF tổng: 200 <bytes> · ZIP: 200 <bytes>
🎉 STAGING E2E PASS
```

## 6. E2E — 10 hồ sơ

```bash
node --import tsx scripts/staging-e2e.mjs --records 10
```

## 7. Visual diff với reference Google Docs

1. Export reference thật: mở Google Docs `Dang_ky_Tap_nghe` → File → Download → PDF → `reference.pdf`.
2. Render HTML sample bằng đúng engine (trên máy có Chromium):
   ```bash
   cd worker && npm run generate:sample
   npx playwright install chromium   # nếu chưa có
   CHROMIUM_EXECUTABLE_PATH=... node scripts/visual-verify.mjs   # bỏ CHROMIUM_EXECUTABLE_PATH nếu dùng playwright mặc định
   ```
3. So sánh `docs/visual-verification/out/rendered.pdf` với `reference.pdf`:
   - **Số trang** (pdf-lib/`pdfinfo`): kỳ vọng 6 = 6.
   - Mở cả 2 cạnh nhau: page breaks, tables, borders, font, font size, line/paragraph spacing, checkbox ☐☒, signatures, alignment, margins, logo, tiếng Việt, orphan/widow, overflow.
   - Gửi lại cho tôi: 2 file PDF + `report.json` + mô tả khác biệt.
4. Nếu khác biệt ảnh hưởng nội dung/bố cục/pagination → báo tôi để sửa template/CSS.

## 8. Gửi lại kết quả

Gửi tôi (paste vào chat hoặc note trong PR #61):
- Output bước 5 (1 record) và bước 6 (10 records)
- `docs/visual-verification/out/report.json` + `reference.pdf` + `rendered.pdf`
- Benchmark có network/upload (tuỳ chọn — `cd worker && npm run benchmark`)
- Cloud Run URL + Vercel Preview URL + deployment status

Tôi sẽ tổng hợp → báo **recommendation MERGE / DO NOT MERGE** → chờ approval cuối cùng.
