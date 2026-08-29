# Incident Report — Document Merge zombie jobs (28–29/08/2026)

Investigation + hotfix for the P0 production incident: four GOOGLE_DOCS merge
jobs stuck at parent `PROCESSING` (`RUNNING` rows) on the template
"Đăng ký tập nghề - Quy định tập nghề". Fix delivered in PR #126.

> Note on production data access: no production DB/log credentials are
> available to the investigation sandbox, so per-job timestamps/leases are
> classified from the proven execution-model mechanics (code + git history +
> deploy architecture), not from a direct row read. No production DB write was
> performed and no merge was created during the investigation.

## Phase 0 — deployed code

- `CURRENT_MAIN_SHA = da544b2a89928264b7fd463138fc48558ffda562`
- `PR125_MERGED = YES` (merge commit `da544b2`, 29/08 07:03:46 +0700)
- `PR125_COMMIT_PRESENT_IN_MAIN = YES`
- `PRODUCTION_DEPLOYMENT_SHA = da544b2…` — production is released via GitHub +
  Vercel Git Integration (docs/PRODUCTION-DEPLOY.md); no manual web deploy
  workflow exists, so main == production after the next Vercel deploy.
- `PRODUCTION_CODE_STALE = NO` (today). Caveat: the 29/08 07:06/07:07 jobs were
  created 3–4 minutes after the merge commit — inside the Vercel build window —
  and therefore executed the **pre-#125 deployment** (same as the 28/08 jobs).

## Phase 1 — the four jobs (classification from mechanism, not row reads)

| Created (+0700) | Records | Class | Why |
|---|---|---|---|
| 28/08 17:07:55 | 5 | `LEGACY_STALE` | pre-#125 code: no timeout, no liveness, no recovery. Killed mid-flight → RUNNING + PENDING forever |
| 28/08 17:09:56 | 1 | `LEGACY_STALE` | same; user retried with 1 record, request died again |
| 29/08 07:06:26 | 1 | `STALE` (created in the #125 deploy window; executed pre-#125 code) | same zombie mechanism |
| 29/08 07:07:29 | 1 | `STALE` (same window) | same |

None of the four requests can still be executing: Vercel serverless functions
are hard-killed at the platform `maxDuration`; the rows show `PROCESSING`
only because the terminal write never ran and no recovery actor ran since.
Child records: `PENDING` (normalised `QUEUED`) under the old model — the old
route never wrote `PROCESSING` on items.

## Phase 2 — PR #125 recovery compatibility for legacy jobs

- Legacy rows: `status=RUNNING`, `engine='GOOGLE_DOCS'` (schema default),
  `updated_at` = creation time (old route never refreshed it),
  items `status=PENDING` with `leased_until NULL`.
- The new predicate selects them: `status IN ('RUNNING','PROCESSING')` ✓,
  `COALESCE(engine,'GOOGLE_DOCS')='GOOGLE_DOCS'` ✓, `updated_at < cutoff` ✓,
  no live PROCESSING lease to exempt them ✓. Items are failed via
  `status NOT IN (COMPLETED/FAILED/CANCELLED)` → PENDING included.
- **`LEGACY_RECOVERY_GAP = NO`** — the predicate covers the legacy shape
  (regression tests added). The gap is the actor, not the predicate.

## Phase 3 — recovery actor trace

`Vercel cron (vercel.json "0 20 * * *", DAILY)` → `GET /api/cron/run`
(Bearer `CRON_SECRET`, fail-closed) → `runDueJobs()` (rows of `scheduled_jobs`,
seeded via `ensureSeed` incl. `recover_stale_merge_jobs`) →
`RECOVER_STALE_MERGE_JOBS` → `recoverStaleMergeJobs({fire: triggerPdfWorker})`
→ single conditional SQL statements (SKIP LOCKED / CAS).

- `CRON_CONFIGURED = YES` (daily 20:00 UTC)
- `CRON_FREQUENCY = DAILY` (Vercel Hobby caps cron at 1/day — documented in
  scheduler.ts)
- `CRON_AUTH_OK = UNKNOWN` from repo (code is fail-closed; secret presence
  cannot be verified without Vercel access)
- `SCHEDULER_TASK_REGISTERED = YES`
- `RECOVERY_TASK_EXECUTED = NO` since #125 deploy — the cron that ran at
  29/08 03:00 +0700 executed pre-#125 code; the next run is 30/08 03:00 +0700
- **`RECOVERY_FREQUENCY_BUG = YES`** — a zombie could remain up to ~24 h.

## Phase 4/5 — why the current 1-record jobs "take minutes"

The rows never reach a terminal state, so the UI shows `PROCESSING`
indefinitely — the request itself died inside the platform budget. One-record
GOOGLE_DOCS pipeline (constructed from code; zombies never wrote
`metadata.timing`):

| Stage | Bound |
|---|---|
| QUEUE_WAIT | ~0 ms (synchronous; items flipped to PROCESSING at start) |
| DATA_LOAD | 1 joined SELECT (~10–100 ms) |
| MAPPING | local (<100 ms) |
| TEMPLATE_READ (`files.export text/plain`) | ≤ 30 s (fetchWithTimeout, no retry) |
| GOOGLE_DOC_COPY (`files.copy`) | ≤ ~127 s worst (4 attempts × 30 s + 1/2/4 s backoff on 429/502/503) |
| DOCS_BATCH_UPDATE (`documents:batchUpdate`, 49 replaceAllText) | ≤ ~127 s worst (same retry loop; plus global ≥1100 ms write spacing and the guard's own 429 retry loop) |
| DRIVE_EXPORT (PDF) | ≤ 30 s |
| DRIVE_UPLOAD (merged PDF) | ≤ 30 s |
| TOTAL | healthy ≈ 15–40 s; pathological ≈ 6+ min → exceeds platform maxDuration → hard kill |

- `GOOGLE_API_CALL_COUNT = 5` per record (+1–2 OAuth token exchanges on cold start)
- `DB_HEARTBEAT_COUNT ≈ 8` (start / template_read / per-candidate / doc_create / pdf_export / drive_upload / commit + ownership checks)
- `MAX_SINGLE_OPERATION_WAIT_MS ≈ 127 000`
- `MAX_ONE_RECORD_GOOGLE_WAIT_MS ≈ 344 000` (before token exchanges)
- `FIRST_SLOW_STAGE = GOOGLE_DOC_COPY → BATCH_UPDATE` — the only
  retry-amplified operations; files.copy is the first of them. (Exact
  production durations unavailable: the evidence jobs never wrote timing.)
- The current GOOGLE_DOCS request is NOT reaching Google for the four evidence
  jobs — there is no live request; the rows are dead. A new merge reaches
  Google normally (read → copy → batchUpdate → export → upload).

## Phase 6 — v11-era comparison

Execution path diff between the 26/08 fast era (fd76987) and current main:
PR #125 only (heartbeats, fetchWithTimeout, CAS terminals, orphan trash).
The Google/Drive call sequence and counts are IDENTICAL pre- and post-#125.

- `OLD_GOOGLE_CALLS == CURRENT_GOOGLE_CALLS` (5 per record)
- `OLD_DRIVE_CALLS == CURRENT_DRIVE_CALLS`
- `CURRENT_DB_WRITES = OLD_DB_WRITES + liveness heartbeats (~8 × 2 queries)`
- `V11_TEMPLATE_ITSELF_CAUSED_SPEED_DIFFERENCE = NOT_PROVEN` — code path
  unchanged; template content changed (v16), no evidence ties it to the hang.

## Phase 7 — first broken transition

- `FIRST_BROKEN_TRANSITION = STALE → WATCHDOG_RECOVERY` (the recovery actor
  ran only once/day — and had not run at all since the #125 deploy — so all
  four dead jobs stayed PROCESSING; for the legacy-code jobs the first broken
  transition inside the job itself was `JOB_CREATED → ITEM_PROCESSING`, which
  the old model never performed).
- `FIRST_SLOW_STAGE = GOOGLE_DOC_COPY` (first retry-amplified Google write).

## Phase 8/9 — fix

PR #126: `runPreMergeStaleRecovery()` at the start of
`POST /api/document-merge/merge/execute` — the same liveness/CAS sweep as the
cron watchdog, running BEFORE the new job is inserted. The next merge attempt
fails every zombie loudly (`STALE_SYNC_KILLED` + visible error summary) in
seconds; the daily cron remains the backstop; GET polling remains read-only;
a throwing sweep can never block a merge. No template/mapping/candidate
changes; no migration; no manual production DB updates.

## Safety gates

- `ACTIVE_REQUEST_FALSE_FAILURE_POSSIBLE = NO` (normal path: heartbeats keep
  `updated_at` fresh; worst single-stage gap ≈ 2×127 s < 5 min stale window)
- `FAILED_TO_COMPLETED_POSSIBLE = NO` (CAS predicates, tested)
- `OUTPUT_AFTER_STALE_FAILURE_POSSIBLE = NO` (ownership checks + orphan trash)
- `DUPLICATE_SUCCESSFUL_OUTPUT_POSSIBLE = NO` (single-owner CAS terminal commit)

## Quality gates

- `TESTS = PASS` (1786 node + 15 DOM; 10 new)
- `TYPECHECK = PASS` · `LINT = PASS` (0 errors; 57 pre-existing warnings) · `BUILD = PASS`

## Delivery

- `BRANCH = arena/01a04adb-seasonal-worker`
- `COMMIT_SHA = 9646c11`
- `PR_URL = https://github.com/nguyenanvuong2006/seasonal-worker/pull/126`
- `SAFE_TO_MERGE = YES` (pending review — not auto-merged)
