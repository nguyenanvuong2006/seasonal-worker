# Incident — Merge job stuck PROCESSING / 0-1 / Queued=1 (hardened)

## Symptom
A 1-record merge stayed parent `PROCESSING` / child `QUEUED` (0/1, 0%) with no
error. Root cause was the synchronous GOOGLE_DOCS engine leaving `RUNNING` +
`PENDING` rows when the serverless request died before reaching its terminal
write, with no liveness signal and no watchdog.

## Safety model after hardening (race-free A + B)

GOOGLE_DOCS liveness (NO migration — reuses `merge_jobs.updated_at` +
`merge_job_records.leased_until`):

- `GOOGLE_DOCS_LEASE_MS = 60_000` (item `leased_until`; `SYNC_ITEM_LEASE_SECONDS`).
- Heartbeat policy: `touchSyncMerge(jobId)` refreshes `merge_jobs.updated_at`
  (job last-progress) and the item `leased_until`, CAS-guarded to active states,
  around EVERY meaningful stage — start, per-candidate iteration, template read,
  Doc copy/create (before and re-checked after the external call), PDF export,
  Drive upload (re-checked after), and final commit. Ownership is re-verified
  (`syncMergeOwnsJob`) after each irreversible external write.
- `GOOGLE_FETCH_TIMEOUT_MS = 30_000` (`fetchWithTimeout`; bounded retry on 429/
  502/503). Worst-case gap between heartbeats for one candidate is a couple of
  fetch timeouts — well under the stale window.
- `STALE_AFTER_NO_PROGRESS_MS = 5 * 60_000`. Recovery reclaims a GOOGLE_DOCS job
  ONLY when `merge_jobs.updated_at < now - STALE_AFTER_NO_PROGRESS_MS` AND no
  item holds a fresh `leased_until` (i.e. NO progress at all for the window).
  A long healthy batch keeps updating `updated_at`, so it is never failed no
  matter how long it runs. Wall-clock `created_at` is NOT used.

Terminal compare-and-set (no terminal overwrite):
- Job success `RUNNING/PROCESSING → COMPLETED` via `casSyncJobCompleted` (status
  predicate). Failure `casSyncJobFailed`; items `casSyncItemsCompleted/Failed`
  only flip non-terminal rows. Thus FAILED→COMPLETED, COMPLETED→FAILED and
  CANCELLED→COMPLETED are all impossible for a non-owning execution.
- If the CAS loses the race (watchdog FAILED or operator CANCELLED won first),
  the merge returns 409, does NOT write `outputUrl`, does NOT link applicant
  docs, and best-effort trashes every Google/Drive file it created (orphan
  cleanup), logging any file it could not trash.

Output ownership / idempotency:
- Before irreversible Doc copy/PDF upload and again after the long call, the
  execution re-checks ownership; on loss it trashes the orphan and aborts.
- Filenames embed the stable `job.id` + `recordId` (not `Date.now()`) so a
  retry of the same logical operation is identifiable. A genuinely NEW merge
  intentionally creates a new document; a stale duplicate owner can never commit
  a second successful output reference because the terminal CAS is a single
  owner.

HTML_PDF (Cloud Run worker):
- Lease 60s; heartbeat now runs for the WHOLE item (data load → render → upload
  → history → dispatch → commit), not just Chromium render. `heartbeatItem` is
  CAS-guarded (renews only while `PROCESSING`); a heartbeat after reclaim is a
  no-op. `completeItem` is CAS `PROCESSING → COMPLETED` and returns the commit
  count; if the lease was lost the worker aborts and does not link/complete.
- Claim stays the single atomic `FOR UPDATE SKIP LOCKED` statement; two workers
  cannot claim the same live item; reclaim only touches items whose lease has
  been expired for the stale window and uses SKIP LOCKED.

Recovery actor:
- GET `/api/document-merge/jobs/[id]` is READ-ONLY (observational) — it never
  fails jobs, reclaims records, or triggers workers. Repeated polling cannot
  mutate RUNNING/PROCESSING/QUEUED/PENDING/RETRY.
- Recovery runs via TWO explicit actors: (1) the authenticated daily cron
  handler (`RECOVER_STALE_MERGE_JOBS` → `recoverStaleMergeJobs`, idempotent,
  SKIP LOCKED, CAS), and (2) the interactive merge-write trigger
  (`runPreMergeStaleRecovery()` at the start of
  POST `/api/document-merge/merge/execute` — the same sweep runs BEFORE a new
  job is inserted, so the Vercel Hobby daily-cron cap can never leave a
  zombie PROCESSING for up to 24 hours again). UI still shows QUEUED /
  PROCESSING / COMPLETED / FAILED and Vietnamese guidance.
