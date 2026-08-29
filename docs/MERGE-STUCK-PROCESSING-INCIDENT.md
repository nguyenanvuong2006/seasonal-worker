# Incident — Merge job stuck PROCESSING / 0-1 / Queued=1 (hardened)

## Symptom
A 1-record merge stayed parent `PROCESSING` / child `QUEUED` (0/1, 0%) with no
error. Root cause was the synchronous GOOGLE_DOCS engine leaving `RUNNING` +
`PENDING` rows when the serverless request died before reaching its terminal
write, with no liveness signal and no watchdog.

## Platform budget (why the sync model was retired)

Vercel Hobby route maxDuration = 300s. The synchronous GOOGLE_DOCS pipeline's
bounded worst case (~344s: 30s read + ≤127s copy + ≤127s batchUpdate retry
amplification + 30s export + 30s upload) exceeds it, so a slow run could be
hard-killed mid-flight. After the 28–29/08 incident, GOOGLE_DOCS moved onto
the existing durable queue + Cloud Run worker (request timeout 3600s):
POST creates a QUEUED job with a frozen snapshot and returns 202; the worker
claims (SKIP LOCKED), heartbeats its 60s lease, performs the Google work and
CAS-commits COMPLETED/FAILED. The HTTP request never calls Google.

## Safety model (race-free A + B)

GOOGLE_DOCS worker liveness (same lease columns as HTML_PDF):

- Item lease 60s; the worker heartbeats `leased_until` every ~20s for the
  WHOLE item (template read → mapping → Doc copy/batchUpdate → export →
  upload → commit). `heartbeatItem` is CAS-guarded (renews only while
  `PROCESSING`); a heartbeat after reclaim is a no-op.
- Claim stays the single atomic `FOR UPDATE SKIP LOCKED` statement; two
  workers cannot claim the same live item.
- `completeItem` is CAS `PROCESSING → COMPLETED`; the job terminal commit is
  CAS `RUNNING/PROCESSING → COMPLETED` (`casSyncJobCompleted`) — FAILED→
  COMPLETED, COMPLETED→FAILED and CANCELLED→COMPLETED are impossible.
- Before and after the irreversible Google Doc copy the worker re-checks its
  lease; a lost owner best-effort trashes the orphan and never commits a
  second successful output reference. Batch print exports each completed Doc
  as PDF (read-only), merges and uploads once; on a lost CAS race the merged
  PDF is best-effort trashed.

## Recovery actors

- GET `/api/document-merge/jobs/[id]` is READ-ONLY (observational) — it never
  fails jobs, reclaims records, or triggers workers. Repeated polling cannot
  mutate RUNNING/PROCESSING/QUEUED/PENDING/RETRY.
- **Worker self-reclaim**: `runJob()` first reclaims the job's own
  PROCESSING items whose lease expired (previous invocation died) — no cron
  sweep needed first.
- **Cloud Scheduler watchdog (independent)**: the production deploy workflow
  provisions a scheduler job hitting the worker `/run` watchdog every
  5 minutes (OIDC + app-secret auth). Vercel-plan-independent; no user action
  and no daily-cron dependency. The watchdog processes the next non-terminal
  job of either engine.
- **Daily cron** (`RECOVER_STALE_MERGE_JOBS` → `recoverStaleMergeJobs`,
  idempotent, SKIP LOCKED, CAS) and the **pre-merge sweep**
  (`runPreMergeStaleRecovery()` at the start of
  POST `/api/document-merge/merge/execute`) remain as backstops. They also
  fail loudly the pure LEGACY zombies (RUNNING job + PENDING items — no
  claimable item shape): `STALE_SYNC_KILLED` with a visible error summary.
  Async-model jobs (QUEUED/RETRY/PROCESSING items) are reclaimed/re-dispatched,
  never failed.
- UI still shows QUEUED / PROCESSING / COMPLETED / FAILED with Vietnamese
  guidance; Progress panel links the Google Doc output and merged PDF.
