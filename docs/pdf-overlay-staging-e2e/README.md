# PR5 — Controlled Staging E2E: PDF Overlay (Runbook)

> Mục tiêu: chứng minh toàn bộ staging flow end-to-end cho **PDF Overlay renderer**:
> queue → worker → renderer → storage → history → idempotency, chỉ trên STAGING,
> không mutation production, không production /run, không merge job production,
> không kích hoạt engine.

## Tổng quan kiến trúc (đã merge trong PR5)

| Thành phần | File | Ghi chú |
|---|---|---|
| Fixture NON-PRODUCTION + snapshot | `src/lib/document-merge/pdf-overlay/staging-e2e.ts` | Template blank A4 2 trang, 12 positions (TEXT/MULTILINE_TEXT/DATE/NUMBER/CHECKBOX×2), field values GIẢ (assertFixtureSafe), deterministic |
| Worker runner (queue thật) | `src/lib/document-merge/pdf-overlay/worker-overlay-e2e.ts` | `runOverlayE2EJob`: claim → render → sha256 → storage → document_history → completeItem → batch finalize; retry semantics (defer khi chờ backoff); CLAIM_STALLED parity |
| Endpoint worker | `worker/src/index.ts` → `POST /run-overlay` | Body `{jobId}`; auth như /run; **bị chặn 404 khi WORKER_ENV=production** |
| Gate production | `src/lib/document-merge/worker-diag-gate.ts` | `shouldBlockRestrictedWorkerRequest` (gộp `/diag/*` + `/run-overlay`) |
| E2E script | `scripts/staging-e2e-overlay.mjs` | Tạo ĐÚNG 1 job success + 1 job failure (synthetic), trigger worker, verify toàn bộ, xuất evidence JSON |
| Workflow CI (operator-install) | `docs/pdf-overlay-staging-e2e/github-workflow-staging-e2e-overlay.yml` | `workflow_dispatch`, environment `staging`, upload evidence artifact. ⚠️ Bot PR không có GitHub `workflows` permission nên file này nằm NGOÀI `.github/workflows/` — operator copy vào `.github/workflows/staging-e2e-overlay.yml` (sau PR5 merge hoặc trên branch bất kỳ) rồi dispatch |
| Readiness model | `src/lib/document-merge/pdf-overlay/verification/{readiness,types}.ts` | Gate mới `STAGING_E2E_1_RECORD` / `STAGING_E2E_10_RECORD`; ACTIVATION_ALLOWED không bao giờ tự PASS |

## Luồng dữ liệu

```
scripts/staging-e2e-overlay.mjs (CI runner)
  ├─ tạo merge_jobs (engine='PDF_OVERLAY', metadata.e2e = snapshot fixture)
  ├─ tạo merge_job_records (QUEUED, source_record_id = uuid GIẢ)
  └─ POST {WORKER}/run-overlay {jobId}
        worker/src/index.ts (/run-overlay, staging-only)
        └─ runOverlayE2EJob (src/lib/.../worker-overlay-e2e.ts)
             ├─ markJobProcessing + recordJobStage(JOB_CLAIMED)
             ├─ claimItems(jobId, concurrency)            ← queue THẬT (FOR UPDATE SKIP LOCKED)
             ├─ processOverlayE2EItem(item)
             │    ├─ renderStagingE2EItem(...)            ← renderer pdf-overlay (deterministic, font DejaVu)
             │    ├─ assertStagingE2EItemComplete(...)    ← no unresolved placeholders
             │    ├─ storage.put(storageKey, bytes)       ← storage STAGING
             │    ├─ createDocumentHistory(...)           ← history THẬT (retention ~3y, sha256)
             │    └─ completeItem(...)                    ← status COMPLETED + output
             ├─ recomputeJobProgress
             └─ finalizeBatchOutputs → finalizeJob(COMPLETED)
```

## Retry / idempotency / failure semantics (có test)

- **Item lỗi** → `failItem(RENDER_FAILED, attempt_count)` → RETRY (backoff 2s→4s), attempt 3 → FAILED.
- **Toàn bộ item còn lại đang RETRY chờ backoff** → worker kết thúc vòng, job giữ PROCESSING
  (lần `/run-overlay` kế tiếp claim tiếp) — KHÔNG fail job sớm.
- **Item QUEUED không claim được (không chờ backoff)** → CLAIM_STALLED: fail job + fail toàn bộ item (parity HTML runner).
- **Duplicate /run-overlay trên job COMPLETED** → `{processed:0}`, history KHÔNG tăng, item outputs (key+sha256) KHÔNG đổi.
- **Re-run job FAILED** → giữ FAILED, không history, không output.
- **Storage failure** → item FAILED (RENDER_FAILED), KHÔNG history, KHÔNG completeItem (unit test).
- **Production isolation** → `/run-overlay` trả 404 (gate) khi `WORKER_ENV=production`;
  job chỉ được tạo bởi script (created_by='staging-e2e-overlay', engine PDF_OVERLAY);
  fixture vượt `assertFixtureSafe` (không PII).

## Chạy (CI/cloud runner — không chạy trên máy user)

> ⚠️ **Bước 0 (operator, 1 lần):** copy `docs/pdf-overlay-staging-e2e/github-workflow-staging-e2e-overlay.yml`
> → `.github/workflows/staging-e2e-overlay.yml` rồi push (GitHub App của bot PR
> không có `workflows` permission — operator account thì có). Workflow yêu cầu
> environment `staging` với `GCP_WORKLOAD_IDENTITY_PROVIDER` / `GCP_SERVICE_ACCOUNT`
> / `STAGING_DATABASE_URL` (đã dùng bởi deploy/migrate staging workflows) + quyền
> đọc Google Secret Manager cho `STAGING_MERGE_WORKER_SECRET`,
> `STAGING_GOOGLE_DRIVE_ROOT_FOLDER_ID`, `STAGING_GOOGLE_CLIENT_ID`,
> `STAGING_GOOGLE_CLIENT_SECRET`, `STAGING_GOOGLE_REFRESH_TOKEN`.

### 1. Deploy worker staging từ branch PR5 (có /run-overlay)

```bash
gh workflow run "Deploy Document Merge Worker — STAGING" --ref arena/01a02943-seasonal-worker
# chờ deploy xong (Actions → workflow → Show service URL)
```

### 2. Chạy E2E 1-record

```bash
gh workflow run "Staging E2E — PDF Overlay (PR5)" --ref <branch> -f records=1
```

### 3. Chạy E2E 10-record (CHỈ khi 1-record PASS)

```bash
gh workflow run "Staging E2E — PDF Overlay (PR5)" --ref <branch> -f records=10
```

Artifact `staging-e2e-overlay-<n>-evidence` chứa `evidence-overlay-<n>.json` (+ `.sha256`) + log.

### Chạy tay (khi có secrets staging)

```bash
export STAGING_E2E_CONFIRM=1
export DATABASE_URL=<Neon staging> MERGE_WORKER_URL=<run.app> MERGE_WORKER_SECRET=<...>
export STORAGE_PROVIDER=google_drive GOOGLE_DRIVE_ROOT_FOLDER_ID=<staging root>
export GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... GOOGLE_REFRESH_TOKEN=...
node --import tsx scripts/staging-e2e-overlay.mjs --records 1 --json evidence-1.json
node --import tsx scripts/staging-e2e-overlay.mjs --records 10 --json evidence-10.json
node --import tsx scripts/staging-e2e-overlay.mjs --dry-run        # preflight, không ghi
node --import tsx scripts/staging-e2e-overlay.mjs --cleanup        # liệt kê job E2E (không xoá)
```

## Evidence JSON (machine-readable — KHÔNG secret/PII)

```jsonc
{
  "jobId": "...",                 // merge_jobs.id (uuid)
  "recordCount": 1,               // 1 | 10
  "itemCount": 1,
  "completed": 1, "failed": 0, "retryCount": 0,
  "renderDurationMs": 1234,
  "storageIds": ["Candidate Documents/..."],
  "sha256s": ["<64 hex>"],
  "historyCount": 1,
  "workerRevision": "staging-...", // /health revision (public)
  "outputUrls": ["..."],          // batch PDF/ZIP URLs (staging)
  "statusTransitions": [{"status":"QUEUED",...},{"status":"PROCESSING",...},{"status":"COMPLETED",...}],
  "idempotency": {"historyBefore":1,"historyAfter":1,"itemsUnchanged":true,"jobStatusAfter":"COMPLETED"},
  "failure": {"jobId":"...","transitions":[...],"finalItem":{"status":"FAILED","attemptCount":3,"errorCode":"RENDER_FAILED"},"historyCount":0,"storageOutputCount":0},
  "productionIsolation": {"engineDefault":"GOOGLE_DOCS","activationAllowed":false,"productionMutated":false,"piiInFixtures":false}
}
```

## Stop conditions (dừng ngay nếu)

Production DB/Drive/worker bị trỏ tới · `/run-overlay` trả 404 (đang chạy production worker) ·
job tạo ra có PII thật · history/sha256 lệch · duplicate output · cleanup đụng data không-test ·
bất kỳ ai đổi DOCUMENT_MERGE_ENGINE / ACTIVATION_ALLOWED.
