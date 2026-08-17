# Document Merge PDF Worker (Cloud Run)

Worker render HTML → PDF bằng Playwright/Chromium, chạy bất đồng bộ qua durable
queue trên Neon. Không phụ thuộc Google Docs API quota cho batch PDF.

## Cấu trúc

```
worker/
  src/index.ts      # HTTP service + render loop + Chromium pool
  Dockerfile        # base mcr.microsoft.com/playwright:v1.49.0-noble
  package.json
  tsconfig.json     # paths @/* -> ../src/*
```

## Env variables (Cloud Run)

| Var | Bắt buộc | Mô tả |
| --- | --- | --- |
| `DATABASE_URL` | ✅ | Neon connection string (cùng DB với Vercel app) |
| `MERGE_WORKER_SECRET` | ✅ | Bearer token Vercel dùng để gọi POST /run |
| `PDF_RENDER_CONCURRENCY` | — | Số render song song (default 4; benchmark 6–8) |
| `STORAGE_PROVIDER` | — | `gcs`/`s3` (production, Phase 5); `local` cho dev |
| `PORT` | — | default 8080 |

## Build & deploy

```bash
# Build image (từ thư mục gốc repo, vì Dockerfile cần cả src/)
gcloud builds submit --tag gcr.io/PROJECT/document-merge-worker \
  --file=worker/Dockerfile .

# Deploy thành Cloud Run service (min-instances=0 → scale-to-zero)
gcloud run deploy document-merge-worker \
  --image gcr.io/PROJECT/document-merge-worker \
  --region asia-southeast1 \
  --cpu 2 --memory 4Gi \
  --min-instances 0 --max-instances 3 \
  --timeout 3600 \
  --set-env-vars DATABASE_URL=...,MERGE_WORKER_SECRET=...,STORAGE_PROVIDER=gcs,PDF_RENDER_CONCURRENCY=4 \
  --no-allow-unauthenticated
```

- **Không cho phép public unauthenticated** (`--no-allow-unauthenticated`): chỉ Vercel
  (qua service account có quyền `run.invoker`) gọi được POST /run.
- Benchmark ban đầu: **2 vCPU / 4 GB, concurrency 4** → sau đó thử 6, 8.

## Security model

- Vercel → Cloud Run: dùng Workload Identity Federation / service account `run.invoker`,
  KHÔNG dùng public arbitrary-execution endpoint.
- `MERGE_WORKER_SECRET` chỉ nằm ở server-side (Vercel env + Cloud Run env) — không
  expose ra client.
- Worker không log CCCD / phone / address / tên — chỉ log `jobId` + `sequence` + ms.
- Job ownership / data scope được validate ở Vercel (POST /jobs) trước khi enqueue.

## Local dev

```bash
cd worker && npm install
DATABASE_URL=... MERGE_WORKER_SECRET=dev PDF_RENDER_CONCURRENCY=2 STORAGE_PROVIDER=local \
  npx playwright install chromium
npm start   # lắng nghe :8080
# trigger: curl -XPOST -H "Authorization: Bearer dev" localhost:8080/run -d '{"jobId":"..."}'
```

## Visual verification (Phase 5)

```bash
# 1. Tạo sample HTML (đã fill dữ liệu mẫu) từ ĐÚNG template.ts + renderer production
cd worker && npm run generate:sample
# → docs/visual-verification/dang-ky-tap-nghe-sample.html
#   Mở trong trình duyệt → Print (A4) → Save as PDF → so với export Google Docs gốc.

# 2. Render + kiểm tra cấu trúc qua Chromium (cần npx playwright install chromium)
cd worker && npm run verify:visual
# → docs/visual-verification/out/report.json + rendered.pdf + full.png

# 3. GATE: CHỈ publish version khi report pass + so sánh visual với reference
#    (số trang, text position, tables, borders, font, checkbox, header/footer, tiếng Việt).
```
