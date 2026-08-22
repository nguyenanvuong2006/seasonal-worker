# PR5 — Final Report: Controlled Staging E2E (PDF Overlay)

> Generated: 2026-08-22 (UTC) · Branch `arena/01a02943-seasonal-worker` · PR #78
> **UPDATED POST-MERGE**: PR #78 merged by operator at 2026-08-22T12:36:36Z (merge commit `3bf768c`).

## Operator decisions (đầu vào)

```
VISUAL_GATE_APPROVED   = PASS   (đã duyệt manual — PR #77)
BENCHMARK_GATE_APPROVED= PASS   (đã duyệt manual — PR #77)
ACTIVATION_ALLOWED     = NO     (giữ nguyên — PR6 + operator approval)
```

## Report

| Field | Value |
|---|---|
| **PR5_STATUS** | **MERGED** (operator instruction 2026-08-22; merge commit `3bf768cec5bb187494784142e960b59178f8bed8`) — staging E2E live-run vẫn còn PENDING (operator-gated) |
| **BASE_MAIN_SHA** | `2f3cb44de0d6ac7f10051777ec38722960edcca2` (PR #73/#74/#76/#77 verified in main) |
| **BRANCH** | `arena/01a02943-seasonal-worker` |
| **COMMITS** | `1b9cff9` (feat: staging E2E path) · `b655f25` (chore: workflow operator-install) · `b790ccb` (fix: PdfOverlayError code in failure message) |
| **FILES_CHANGED** | 15 (6 new: worker runner, fixture, 2 test files, E2E script, runbook/workflow docs; 9 modified: worker/index.ts, worker-diag-gate(.ts/.test.ts), readiness(.ts/.test.ts), verification/types.ts, 2 docs) |
| **STAGING_E2E_1_RECORD** | **PENDING** — cần operator chạy (bot token không có `workflows`/`actions:write`/secrets) |
| **STAGING_E2E_10_RECORD** | **PENDING** — chạy CHỈ khi 1-record PASS |
| **QUEUE_FLOW** | Đã implement + test: job engine=`PDF_OVERLAY`, items QUEUED → claimItems (FOR UPDATE SKIP LOCKED) → PROCESSING → COMPLETED; transitions ghi trong evidence |
| **WORKER_FLOW** | Đã implement + test: `POST /run-overlay` (staging-only, 404 khi WORKER_ENV=production); runner `runOverlayE2EJob` (claim → render → sha256 → storage → history → completeItem → batch finalize) |
| **STORAGE_RESULT** | Đã implement + test: storage staging (google_drive/local), key `Candidate Documents/YYYY/MM/DD/<file>.pdf`; verify metadata + page count trong script |
| **HISTORY_RESULT** | Đã implement + test: 1 row/item, sha256 khớp item, retention ~3y, `created_by='staging-e2e-overlay'`, document_type `PDF-Overlay-E2E` |
| **IDEMPOTENCY_RESULT** | Đã implement + test: duplicate `/run-overlay` → `{processed:0}`, history KHÔNG tăng, item outputs (key+sha256) KHÔNG đổi |
| **FAILURE_SEMANTICS** | Đã implement + test: item lỗi → RETRY (backoff) ×3 → FAILED (RENDER_FAILED + code); chờ backoff → defer (job giữ PROCESSING); QUEUED kẹt → CLAIM_STALLED fail job+items; storage failure → failItem, không history; re-run job FAILED giữ FAILED |
| **PRODUCTION_ISOLATION** | PASS — `/run-overlay` 404 ở production worker; script chặn `WORKER_ENV=production`; fixture non-PII (assertFixtureSafe); evidence JSON không secret/PII; không đổi env production |
| **TEST_RESULTS** | Full suite **902/902 PASS**; focused PDF Overlay + gate **233/233 PASS** (22 tests mới) |
| **QUALITY_GATES** | Root typecheck ✅ · Worker typecheck ✅ · Focused PDF Overlay tests ✅ · Verification tests ✅ · Full suite ✅ · Lint 0 errors (51 warnings có sẵn) ✅ · Production build ✅ |
| **PR_NUMBER / PR_URL** | #78 — https://github.com/nguyenanvuong2006/seasonal-worker/pull/78 |
| **PR_CHECKS** | Vercel Preview Comments ✅ · Vercel – seasonal-worker ✅ (deployment pass) |
| **MERGEABLE** | YES (`mergeable=MERGEABLE`, `mergeStateStatus=CLEAN`) |
| **MERGED** | **YES** (operator instruction — 2026-08-22T12:36:36Z, `3bf768c`) |
| **PRODUCTION_CHANGED** | NO |
| **ENGINE_DEFAULT** | GOOGLE_DOCS (không đổi) |
| **ACTIVATION_ALLOWED** | NO |

## Bằng chứng test (chạy trong repo, trước khi mở PR)

```
$ npm test                                  → 902/902 PASS (~56s)
$ node --test --import tsx $(find src/lib/document-merge/pdf-overlay -name '*.test.ts') \
    src/lib/document-merge/worker-diag-gate.test.ts   → 233/233 PASS
$ npm run typecheck (root)                  → PASS
$ (cd worker && npm run typecheck)          → PASS
$ npm run lint                              → 0 errors (51 warnings có sẵn)
$ npm run build                             → PASS (production build)
```

## ONE NEXT OPERATOR ACTION

```bash
# 1. Copy workflow vào .github/workflows/ (bot PR không có workflows permission):
cp docs/pdf-overlay-staging-e2e/github-workflow-staging-e2e-overlay.yml .github/workflows/staging-e2e-overlay.yml

# 2. Deploy worker staging từ branch PR5 (bật /run-overlay):
gh workflow run "Deploy Document Merge Worker — STAGING" --ref arena/01a02943-seasonal-worker

# 3. Chạy E2E 1-record:
gh workflow run "Staging E2E — PDF Overlay (PR5)" --ref arena/01a02943-seasonal-worker -f records=1

# 4. CHỈ khi 1-record PASS — chạy 10-record:
gh workflow run "Staging E2E — PDF Overlay (PR5)" --ref arena/01a02943-seasonal-worker -f records=10

# 5. Gửi evidence artifacts (evidence-overlay-1.json / evidence-overlay-10.json)
#    → cập nhật STAGING_E2E_1_RECORD / STAGING_E2E_10_RECORD → duyệt PR5 → merge.
# ACTIVATION_ALLOWED vẫn NO — thuộc PR6 + approval tường minh.
```

> PR5 đã được merge theo operator instruction (2026-08-22). STAGING_E2E_1_RECORD / STAGING_E2E_10_RECORD vẫn PENDING cho tới khi operator chạy staging E2E (xem ONE NEXT OPERATOR ACTION). ACTIVATION_ALLOWED vẫn NO — thuộc PR6 + approval tường minh.
