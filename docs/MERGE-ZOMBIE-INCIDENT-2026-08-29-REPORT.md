# Incident Report — Document Merge zombie jobs (28–29/08/2026)

Investigation + durable fix for the P0 production incident: four GOOGLE_DOCS
merge jobs stuck at parent `PROCESSING` (`RUNNING` rows) on the template
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
- `PRODUCTION_CODE_STALE = NO` (today).
- **Correction (review gate):** whether the 29/08 07:06/07:07 jobs executed
  pre-#125 code is **NOT proven**. A GitHub merge timestamp is not a
  production deployment-ready timestamp. `PRODUCTION_0706_DEPLOYMENT_PROVEN = NO`.
  Those two jobs are classified `UNKNOWN` (created inside the #125 deploy
  window); both the legacy and the post-#125 mechanisms can explain their
  state, and the fix does not depend on which one applies.

## Phase 1 — the four jobs (classification from mechanism, not row reads)

| Created (+0700) | Records | Class | Why |
|---|---|---|---|
| 28/08 17:07:55 | 5 | `LEGACY_STALE` | pre-#125 code: no timeout, no liveness, no recovery. Killed mid-flight → RUNNING + PENDING forever |
| 28/08 17:09:56 | 1 | `LEGACY_STALE` | same; user retried with 1 record, request died again |
| 29/08 07:06:26 | 1 | `UNKNOWN` (created in the #125 deploy window; deployment state unproven) | zombie mechanism |
| 29/08 07:07:29 | 1 | `UNKNOWN` (same window) | zombie mechanism |

None of the four requests can still be executing: Vercel serverless functions
are hard-killed at the platform `maxDuration`; the rows show `PROCESSING`
only because the terminal write never ran and no recovery actor ran since.
Child records: `PENDING` (normalised `QUEUED`) under the old model — the old
route never wrote `PROCESSING` on items.

## Phase 2 — PR #125 recovery compatibility for legacy jobs

- Legacy rows: `status=RUNNING`, `engine='GOOGLE_DOCS'` (schema default),
  `updated_at` = creation time (old route never refreshed it),
  items `status=PENDING` with `leased_until NULL`.
- The recovery predicate selects them: `status IN ('RUNNING','PROCESSING')` ✓,
  `COALESCE(engine,'GOOGLE_DOCS')='GOOGLE_DOCS'` ✓, `updated_at < cutoff` ✓,
  no live PROCESSING lease to exempt them ✓. Items are failed via
  `status NOT IN (COMPLETED/FAILED/CANCELLED)` → PENDING included.
- **`LEGACY_RECOVERY_GAP = NO`** — the predicate covers the legacy shape
  (regression tests added). The gap is the actor/frequency, not the predicate.

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
  This is the architectural gap fixed below (async executor + independent
  Cloud Scheduler watchdog + worker self-reclaim).

## Platform budget question (review gate)

- `VERCEL_ROUTE_MAX_DURATION = 300s (5 min)` — Vercel Hobby default/maximum
  per the official Vercel docs (vercel.com/docs/functions/configuring-functions/duration;
  the repo sets no route-level `maxDuration` for merge/execute).
- `GOOGLE_DOCS_WORST_CASE_MS ≈ 344 000` (one record, ONE_DOCUMENT):
  template read 30s + Doc copy ≤~127s (4 attempts × 30s + backoff on
  429/502/503) + batchUpdate ≤~127s (same retry loop, plus the global
  ≥1100ms Docs write pacing and the rate-limit guard's own 429 loop) +
  PDF export 30s + Drive upload 30s — before OAuth token exchanges and DB
  round-trips.
- `SYNC_EXECUTION_FITS_PLATFORM_BUDGET = NO` — the bounded worst case
  (~5.7+ min) exceeds the 300s Hobby budget, so the synchronous model can be
  hard-killed mid-flight exactly as observed. Recovery alone is NOT the
  durable fix.

## The durable fix (PR #126, second iteration)

GOOGLE_DOCS moved onto the EXISTING durable queue + Cloud Run worker
(reviewer's preferred end state — no second queue architecture):

- `POST /api/document-merge/merge/execute` now: pre-merge recovery sweep
  (legacy zombie cleanup) → validate/plan → freeze an immutable `googleDocs`
  snapshot into job metadata → insert QUEUED job + QUEUED items →
  `after()`-trigger the worker → return 202 `{jobId, status:"QUEUED"}`.
  **Zero Google calls in the HTTP request.**
- Worker (`worker/src/index.ts`): accepts GOOGLE_DOCS; claims items
  (SKIP LOCKED, sequential per job), heartbeats the 60s lease every ~20s
  through every Google stage, runs template read → mapping → Doc
  copy+batchUpdate → CAS `completeItem` → (batch print: export each PDF,
  merge, upload once) → CAS job COMPLETED. Transient Google errors (timeout/
  network/429/5xx) → RETRY with the standard attempt cap; 403/404/config →
  FAIL immediately. Orphan Docs are best-effort trashed on lease loss.
  Cloud Run request timeout is 3600s (deploy workflow) — comfortably above
  the bounded worst case.
- Recovery independence:
  - worker `runJob()` first **reclaims its own expired-lease items**
    (live owners heartbeat, so they are never touched) — the worker is
    self-sufficient without a cron sweep first;
  - worker `/run` watchdog mode now covers GOOGLE_DOCS + HTML_PDF;
  - **Cloud Scheduler watchdog (independent, 5 min)**: idempotent
    provisioning script `scripts/provision-merge-worker-watchdog.sh`
    (gcloud create-or-update, OIDC + app-secret auth). Ops action: run it
    once against the production worker after deploying this PR — from then
    on recovery is Vercel-plan-independent, needs no user action and no
    daily cron. (The agent sandbox's GitHub App token lacks the `workflows`
    permission, so the provisioning ships as a script rather than a
    deploy-workflow edit; wiring it into
    `.github/workflows/deploy-worker-production.yml` is a trivial follow-up
    for any maintainer with push rights.)
  - daily cron + pre-merge sweep remain as belt-and-braces backstops;
  - stale-recovery predicates updated: legacy zombies (all non-terminal items
    PENDING/RUNNING) are still failed loudly; async jobs (QUEUED/RETRY/
    PROCESSING items) are reclaimed/re-dispatched, never failed.
- GET polling remains strictly read-only; item retry route now supports
  GOOGLE_DOCS (claimable queue engine).

## Corrected conclusions

```
PRODUCTION_0706_DEPLOYMENT_PROVEN = NO
INCIDENT_REPORT_CORRECTED = YES
EXECUTION_PERFORMANCE_FIXED = YES   (Google work off the Vercel request; worker budget 3600s vs ~344s worst case)
RECOVERY_LATENCY_FIXED = YES        (worker self-reclaim + 5-min Cloud Scheduler watchdog; no user action, no daily cron)
ZOMBIE_JOB_FIXED = YES              (legacy zombies failed loudly by the sweep; async jobs reclaimed/retried)
```

## Safety gates

- `ACTIVE_REQUEST_FALSE_FAILURE_POSSIBLE = NO` (heartbeat keeps the lease
  fresh; reclaim/claim keys on expired leases)
- `FAILED_TO_COMPLETED_POSSIBLE = NO` / `COMPLETED_TO_FAILED_POSSIBLE = NO` /
  `CANCELLED_TO_COMPLETED_POSSIBLE = NO` (CAS predicates, tested)
- `OUTPUT_AFTER_STALE_FAILURE_POSSIBLE = NO` (ownership checks + orphan trash)
- `DUPLICATE_SUCCESSFUL_OUTPUT_POSSIBLE = NO` (SKIP LOCKED claim + CAS
  completeItem; single-owner CAS terminal commit)

## Quality gates

- `TESTS = PASS` (root 1794 + 15 DOM; worker 9; new tests: route async
  creation, worker GOOGLE_DOCS execution/retry/batch-print/finalize,
  recovery predicate async exclusions, error classification)
- `TYPECHECK = PASS` (root + worker) · `LINT = PASS` (0 errors;
  pre-existing warnings unchanged) · `BUILD = PASS`

## Delivery

- `BRANCH = arena/01a04adb-seasonal-worker`
- `FINAL_COMMIT_SHA =` (see PR head)
- `PR_URL = https://github.com/nguyenanvuong2006/seasonal-worker/pull/126`
- `SAFE_TO_MERGE = YES` (pending review — not auto-merged)
