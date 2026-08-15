# Workforce Intelligence — Production Hardening & Data Correctness Audit

**Date:** 2026-08-15
**Scope:** hardening only; no ATS/HRIS/Attendance/Recruitment Request connector and no new business feature.

## 1. Executive conclusion

The code is **not yet declared production-ready** because this workspace has no `DATABASE_URL` and therefore the changed transactional/query paths have not run against a production-compatible PostgreSQL dataset. Unit, static, type, lint and build coverage is strong, but a DB preflight is still required before production.

The foundation is suitable for staging verification. Remaining release blockers are listed in section 14.

## 2. Data Scope audit matrix

Canonical rule used everywhere:

```text
scope === null   => unrestricted within granted permission
scope.length = 0 => no department data
scope = [ids]    => exactly those department IDs
```

Role determines **what** a user may do. Scope determines **where**. The only remaining `DEPT_MANAGER` check in Planning preserves the existing DRAFT-only business rule; it is not used as a Data Scope proxy.

| Surface | Before | Hardening result |
|---|---|---|
| Planning list | Scope only for literal `DEPT_MANAGER` | Role-independent `getUserScope`; outside-scope department filter returns no rows. |
| Planning create | Scope only for Manager | Every scoped role is restricted; Manager remains DRAFT-only. |
| Planning activate/revise | No scope check by period ID | Period department is resolved server-side and checked before action. |
| Planning allocation | No period/session scope or department integrity check | Period is scoped; sessions must be APPROVED, open and in the same department. |
| Planning unplanned workers | Caller could omit/use arbitrary department | Requested department intersects session scope; no department returns all scoped departments only. |
| Worker Profile GET/PATCH | Permission only, global profile/history | Profile must have an Employment Session in scope; only scoped sessions are returned. Scoped request gets 404 to avoid existence oracle. |
| DW Data | No department key, global result | Scoped sessions fail closed with 403; global DW count is shown only for `scope === null`. |
| Daily Application GET | Session only; no `registrations.view`; scope also changed status behavior | `registrations.view` enforced; scope only filters department; status restriction is based on process permission, not scope. |
| Daily Application PATCH/DELETE | ID lookup without scope | Existing application department is checked before read/write; target department must also be in scope. |
| Bulk approval | IDs/target department could be outside scope | Target department checked; outside-scope IDs are treated as not found. |
| Registration public POST | Public by design | Remains public; writes are now atomic. No internal scope applies to applicant self-registration. |
| Workforce Movement list | `fromDeptId IN scope` only | Transfer intersects from/to. Source scope gets full record; destination-only gets redacted incoming record. |
| Workforce Movement action | No scope by movement ID | Resignation requires source scope. Destination-only transfer actions are limited to arrival/reschedule/not-arrived; source-side actions remain forbidden. |
| Task Center movement | Transfer source only | Incoming transfer visible to destination scope with worker PII/requester redacted. PII search only checks source-owned records. |
| Global Search worker/application | Global search despite scope | Worker profile scoped through Employment Sessions; application scoped by `deptId`; movement search only returns source-owned full records. |
| Dashboard widgets | Company DW count and possible PII | DW total is unavailable (`null`) for scoped users; phone/CCCD permissions respected. |
| Dashboard overview | Planning could include superseded versions; movement count came from five preview rows | `supersededBy IS NULL`; counts computed before preview limit; destination-only movement preview redacted. |
| Analytics Dashboard/export | Already intersected hierarchy filter and scope | Retained. Recorded workforce query now uses latest valid session and active profile. |
| Workforce Intelligence | Already session-derived scope in central service | Retained; all AI tools call the same service with Session, never a caller-supplied scope. |
| Scenario | Central service scope check | Retained; target department must be authorized. |
| AI Analyze/Chat | Central service scope check | Retained; scope bypass language rejected; model never decides authorization. |
| Department destination lookup | Previously global full department payload | Deliberate transfer exception returns only ID/name/group and requires movement-create permission. |

## 3. Transfer policy

### Worker-level visibility

```text
Resignation:
  from in scope -> FULL
  otherwise     -> NONE

Transfer:
  from in scope                  -> FULL
  only to in scope               -> REDACTED_INCOMING
  neither side in scope          -> NONE
```

Destination-only redaction removes:

- worker ID,
- worker name,
- CCCD,
- reason/note,
- requester,
- related movement ID.

### Aggregate direction

```text
Transfer Out -> filter by fromDeptId
Transfer In  -> filter by toDeptId
```

Workforce Intelligence uses the correct directional metric. A future-dated completed transfer is reconstructed to the source for today's recorded snapshot, then applied as Transfer Out/Transfer In on its effective date.

## 4. Registration transaction

Public registration validation, DW matching, form targeting and Rule Engine execution remain unchanged and read-only.

All business writes now run in one Drizzle transaction:

```text
insert daily_applications
        ↓
upsert worker_profiles by active CCCD
        ↓
insert employment_sessions
        ↓
commit all or rollback all
```

The database unique index remains the race-safe duplicate guard. PostgreSQL `23505` on `daily_app_cccd_date_uq` is returned as HTTP 409 rather than a 500/raw DB error.

Synthetic transaction tests cover:

- all writes commit,
- profile failure rollback,
- employment-session failure rollback,
- duplicate registration rollback,
- returning-worker profile upsert,
- route uses `db.transaction`.

## 5. Worker identity and diagnostics

Workforce Intelligence now returns:

```ts
completeness: {
  applications,
  applicationsWithoutSession,
  sessionsWithoutWorker,
  sessionsWithDeletedWorker,
  sessionsWithoutApplication,
  workersWithoutSession,
  missingApplicationDepartment,
  missingSessionDepartment,
  duplicateActiveWorkerProfiles,
  completenessRate,
  warnings,
}
```

Scoped views report only attributable department diagnostics. Global-only diagnostics that cannot be safely attributed are `null`, not zero.

Forecast confidence is reduced by incomplete application/session linkage. Current and incoming SQL joins only non-deleted Worker Profiles, so orphan/deleted profiles cannot create supply.

No historical record is automatically deleted or repaired.

## 6. Workforce semantics

### Recorded current workforce

```text
latest Employment Session per worker
AND valid non-deleted Worker Profile
AND status = APPROVED
AND startingDate/regDate <= today
AND endDate is null or > today
```

API/UI/AI describe this as `recordedCurrentWorkforce`:

> Hệ thống ghi nhận X lao động theo Employment Session; chưa phải dữ liệu chấm công thời gian thực.

`realTimePresentWorkforce` is `null` while Attendance is unavailable.

### Confirmed incoming

```text
latest valid session per worker
AND status = APPROVED
AND today < startingDate <= forecastTo
AND no end before startingDate
```

A future starter cannot be current workforce on the same snapshot. Rejected/cancelled/ended sessions do not count.

### Expected exits

Workflow configuration currently lacks analytics semantic tags. Stable analytics stage mapping is centralized in:

`src/lib/workforce-intelligence/semantics.ts`

Only confirmed resignation status `INACTIVE` counts. `PENDING_HR`, `REJECTED`, rescheduled and waiting-decision states never reduce confirmed supply.

## 7. Planning and daily forecast correctness

Fixtures prove:

| Case | Result |
|---|---:|
| Original 100 | 100 |
| Original 100 + Supplement 20 | 120 |
| Original v1 100 superseded by v2 130 | 130 |
| Active v2 130 + Supplement 20 | 150 |
| Expired/outside effective period | 0 |
| Independent overlapping plans | additive only on overlap dates |

A Planning requirement of 100 from 01/09–10/09 means **100 on each date**, never 1,000 workers.

Demand filters remain:

```text
status = ACTIVE
supersededBy IS NULL
startDate <= date <= endDate
```

No Planning business workflow was changed to simplify analytics.

## 8. Conversion, required applications and velocity

### Conversion

Workforce Intelligence uses an Application Registration Cohort over the previous 30 completed calendar days:

```text
cohort = application.regDate between from/to
applications = applications in that cohort
approved = cohort applications currently approved or with a recorded start
started = cohort applications with Employment Session startingDate <= cohort end
```

It does not divide August applications by starts from an unrelated July cohort. The output explicitly carries:

```text
semantics = APPLICATION_REGISTRATION_COHORT
cohort.from / cohort.to
```

### Required applications

The estimate is `null` when:

- conversion is zero/null,
- sample is below 30 applications,
- forecast confidence is LOW.

When available, the warning states that the value is conditional on current cohort conversion continuing. AI prompt requires “ước tính khoảng”, never “chính xác”.

### Velocity

```text
applications/day = cohort applications / 30 completed calendar days
approved/day     = cohort approved / 30 completed calendar days
started/day      = cohort started / 30 completed calendar days
```

Today is excluded because it is incomplete. Zero started velocity returns `expectedDaysToCloseGap = null`.

## 9. Risk and action safety

Risk remains deterministic and clamped 0–100.

Hardening:

- no-demand/no-data produces LOW/0, not shortage risk,
- low confidence adds uncertainty only when a real calculated shortage exists,
- tiny absolute shortages cap the low-coverage contribution,
- large/far-future shortage remains visible without short-lead contribution,
- missing critical sources cap confidence below HIGH.

Action safety:

- internal transfer requires same-date in-scope surplus evidence,
- returning-worker action requires opportunity > 0,
- expected-exit review requires confirmed exits,
- referral campaign requires a qualified referral source and usable application estimate,
- `OPEN_SUPPLEMENT_REQUEST` is no longer inferred from a supply shortage; a supplement increases demand and does not close a supply gap,
- Analyze output risk/confidence/actions are overwritten with deterministic backend values.

## 10. AI runtime hardening

The Gemini transport is isolated in a testable provider core with injected `fetch`.

Covered behavior:

- valid structured JSON,
- malformed JSON,
- partial structured response,
- timeout,
- network failure,
- HTTP 429,
- HTTP 500 with one bounded retry,
- empty response,
- overly long response,
- unsupported risk/action,
- missing provider credentials.

Limits:

- 50,000 input characters,
- 20,000 response characters before parsing,
- operation-specific output token limit,
- timeout,
- at most one retry for timeout/network/5xx,
- provider bodies/errors are not exposed to users.

The UI failure message is:

> AI hiện không khả dụng. Các số liệu phân tích bên trên vẫn được tính trực tiếp từ hệ thống.

### Prompt injection and authorization

Backend rejects requests for:

- PII,
- credentials/raw database/SQL,
- prompt-instruction override,
- Data Scope bypass/company-wide analysis when the session is scoped.

This is in addition to, not instead of, the central scoped analytics service.

### Data minimization guard

`assertNoSensitiveFields` recursively rejects sensitive keys in grounding. Tests prove the payload contains no CCCD, phone, email, exact DOB, address, password hash, session/auth secret, DB connection or raw worker list.

Grounding includes provenance, diagnostics, source status and the explicit Employment Session/Attendance limitation.

## 11. Scenario safety

- Input is non-negative and bounded: worker overrides <= 10,000, multiplier <= 3.
- Target department is mandatory and scoped.
- Computation clones/derives forecast points in memory.
- Route has no insert/update/delete or audit write.
- Returning activation is capped by the recorded returning pool.
- Response is labelled:

```text
mode = SIMULATION
classification = ESTIMATED
confidence = LOW
```

## 12. Query/index audit

### Existing indexes used

- `employment_session_worker_idx`: latest-session partition path.
- `employment_session_daily_app_uq`: diagnostic/conversion application link and one-session-per-application.
- `workforce_movement_worker_idx`: movement/session correlation.
- `workforce_movement_type_status_idx`: confirmed movement filtering.
- `planning_dept_status_idx`: scoped active demand.
- `planning_target_period_uq`: exactly one target per period.
- `planning_alloc_session_idx`, `planning_alloc_period_idx`, pair unique index.
- `daily_app_date_status_idx`: historical application range/status path.

Existing production indexes from `schema.sql` are now also declared in Drizzle schema metadata; no DB index was added.

### Deferred index candidates

The following could help only if production `EXPLAIN (ANALYZE, BUFFERS)` and table size prove a need:

- `daily_applications(dept_id, reg_date) WHERE deleted_at IS NULL`,
- `employment_sessions(worker_id, reg_date DESC, created_at DESC)`,
- directional movement indexes including effective date.

No index migration was added without a real execution plan.

## 13. Constraint audit

### Must fix now — resolved at application/query layer

- Partial registration writes: resolved by transaction.
- Orphan/deleted profile creating supply: excluded and diagnosed.
- Cross-department Planning allocation: rejected.
- Superseded Planning double count: filtered.
- Duplicate application race: existing unique index + 409 handling.

### Can defer pending production data audit

Potential foreign keys currently absent:

- `employment_sessions.worker_id -> worker_profiles.id`,
- `employment_sessions.daily_application_id -> daily_applications.id`,
- `employment_sessions.dept_id -> departments.id`,
- movement worker/from/to references,
- Planning department/allocation references.

Adding these immediately could fail production due to historical orphans. Diagnostics must be run on a production copy first; then constraints can be introduced with an explicit remediation/`NOT VALID` validation plan. No destructive migration is included.

## 14. Required DB preflight blockers

Before production deployment:

1. Run the app against a staging copy of PostgreSQL with the real schema.
2. Call overview, department detail, movement source/destination scope, exports and scenario under `null`, `[]` and one-department scopes.
3. Record diagnostics counts and investigate non-zero orphan/duplicate values.
4. Exercise registration success and forced rollback against PostgreSQL.
5. Run `EXPLAIN (ANALYZE, BUFFERS)` for latest-session, movement and cohort queries at production-like volume.
6. Verify actual production indexes match `schema.sql`.

Until these are completed, the release status is **NOT READY FOR PRODUCTION**. The blocker is runtime DB verification/data baseline—not TypeScript compilation or missing feature work.
