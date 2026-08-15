# Workforce Intelligence Foundation — Audit & Architecture

**Repository:** `nguyenanvuong2006/seasonal-worker`
**Iteration date:** 2026-08-15
**Principle:** Data → Analytics → Forecast → Risk → AI Insight → Recommended Action

## 1. Phase 0 audit

### 1.1 Existing tables that are reusable

| Table | Reuse in Workforce Intelligence | Notes |
|---|---|---|
| `departments` | Canonical department master | `departments.id` is the only complete canonical organization ID currently available. `location`, `division`, `section`, `group_name` are display/text dimensions, not safe external join keys. The table is not changed. |
| `daily_applications` | Recruitment funnel, conversion, velocity, confirmed future starts | `dept_id` is canonical. `referral_channel`, status and `starting_date` support current Seasonal Worker analytics. No PII is selected into Workforce Intelligence payloads. |
| `worker_profiles` | Stable worker identity and returning-pool aggregation | Worker-level PII stays below the analytics boundary. Only aggregate counts leave the data service. |
| `employment_sessions` | Current active stock, confirmed incoming, historical employment relationship | Latest session per worker is used to avoid counting multiple historical sessions as current supply. |
| `planning_periods` | Primary authorized demand source | Only `ACTIVE`, overlap-with-period and `superseded_by IS NULL` records enter demand. Original and approved supplements remain independent additive demand. |
| `planning_targets` | Male/female/total demand values | Existing fallback is preserved: use male+female when present, otherwise legacy `target_count`. |
| `planning_allocations` | Existing Planning operational logic | Not rewritten. Workforce Intelligence uses employment-session supply directly rather than changing Planning formulas. |
| `workforce_movements` | Confirmed expected exits and completed transfer in/out events | Only approved terminal statuses are forecast supply events; pending requests are not treated as confirmed supply/exits. |
| `workflow_stages` | Status display/configuration | Existing engine remains. Analytics semantic meaning (`APPROVED`, `INACTIVE`, `TRANSFER_COMPLETED`) remains centralized, not inferred by AI. |
| `user_department_scopes` | Server-side Data Scope | Every new API/tool derives scope from `Session` using `getUserScope`; AI never receives or supplies a scope parameter. |
| `roles`, `permissions`, `role_permissions` | Existing fail-closed RBAC | New endpoints reuse `dashboard.view`; no new permission/migration is necessary for this iteration. |
| `audit_logs` | AI usage metadata | Logs operation/model/token estimate/duration/status without prompt, raw data or PII. No `ai_usage_logs` table is needed yet. |
| `field_definitions`, `form_questions` | Current metadata/import/export | Not repurposed as an external integration schema. |
| `import_jobs`, typed staging tables | Existing internal import engine | Kept unchanged. Future external connectors must use standardized integration contracts and canonical mappings, not silently reuse text-name import matching. |

### 1.2 Existing business logic reused

- Lazy PostgreSQL pool/Drizzle client in `src/db/index.ts`.
- JWT session revocation and DB-refreshed role in `src/lib/auth.ts`.
- Dynamic, fail-closed RBAC (`requirePermission`, `hasPermission`).
- Role-independent `getUserScope` convention: `null` unrestricted, `[]` no data, list = exact departments.
- Planning creation, activation, supplements, versioning, `supersededBy`, allocation and existing metrics.
- Worker identity (`worker_profiles`) and employment-history (`employment_sessions`) model.
- Transactional workforce movement actions and workflow stage keys.
- Existing server-side analytics, parameterized SQL, funnel semantics and Asia/Ho_Chi_Minh date handling.
- Existing chart primitives and Dashboard page.
- Existing `audit_logs` rather than creating a duplicate AI logging source.

### 1.3 Components deliberately not rewritten

- Planning CRUD, versioning and allocation behavior.
- `departments` and its current UUIDs.
- Registration/public applicant flow.
- Worker profile lifecycle and backfill.
- Workforce movement approval transaction.
- Workflow Engine, Rule Engine, Metadata Engine, Import Engine and Export behavior.
- Existing historical/operational Analytics Dashboard. Workforce Outlook is added above it as a future-looking layer.

### 1.4 Missing capabilities found in the audit

- No canonical IDs/tables for location, division, section, group or position.
- No external-system mapping persistence or active connector.
- No Recruitment Request, ATS, HRIS or Attendance data.
- No pipeline probabilities or historical model version.
- No explicit expected-return event. A historical returning pool exists, but it is an opportunity, not forecast supply.
- No source sync/freshness persistence for external systems.
- No forecast confidence, deterministic risk score or deterministic action recommendation engine.
- No safe AI provider/tool boundary.
- No forward daily demand/supply/gap forecast in the current dashboard.

### 1.5 Existing risks to address in later hardening

These are audit findings, not silently rewritten in this iteration:

1. `location`, `division`, `section`, `groupName` are text. External joins on these values would create false matches and split metrics.
2. `planning_periods` stores hierarchy display snapshots as text. Analytics must continue joining by `department_id`; text fields are display/history only.
3. `employment_sessions.worker_id`/`dept_id` are not declared as hard foreign keys in the Drizzle schema, increasing orphan-data risk.
4. Registration creation writes application/profile/session in separate statements rather than one transaction; a mid-request failure can leave an incomplete digital worker file.
5. The existing Planning list applies Data Scope only for the literal `DEPT_MANAGER` role, while the newer architecture describes scope as role-independent. Custom/scoped HR roles need a dedicated hardening pass.
6. Existing worker-profile detail is permission-protected but does not intersect Data Scope; this matters if a privileged role is intentionally assigned a restricted scope.
7. Existing `getDashboardOverview` counts pending movement types from a result limited to five rows, so its counts are alert-preview counts rather than full totals.
8. Existing configurable recent-application table should consistently include `deleted_at IS NULL` in every branch.
9. Workflow configuration describes valid/display statuses, but analytics still requires stable semantic stage keys. Renaming keys without a semantic mapping would break funnel/supply meaning.
10. Planning's operational `recruitmentNeeded` formula must not be reused as a general expected-supply formula. Workforce Intelligence therefore models each supply component explicitly.

### 1.6 Migration decision

**No migration is added in this iteration.**

Reasoning:

- There is no external connector that writes mappings/source status yet.
- Adding `external_system_mappings` or source-sync tables now would create unused persistence without an owner, retention policy or active read path.
- `departments.id` already provides the canonical department key needed by current Seasonal Worker analytics.
- AI usage metadata safely reuses `audit_logs`.

Future migration trigger: when the first real external connector is implemented. At that time it must define canonical organization masters/mappings, writer ownership, retention, unique constraints and indexes (for example unique active mapping by `source_system + entity_type + external_id`).

## 2. Target architecture

```text
External Business Systems
  Seasonal Worker | Recruitment Request | ATS | HRIS | Attendance | Future
                              |
                              v
Workforce Integration Contracts + Mapping Boundary
                              |
                              v
Scoped Server-side Workforce Analytics Service
          Demand | Supply | Pipeline | Provenance | Freshness
                              |
                              v
Daily Forecast -> Deterministic Risk -> Deterministic Actions
                              |
                    Aggregate/no-PII JSON
                              |
                              v
       Dashboard + Controlled AI Workforce Analyst
```

There is no Kafka, warehouse, Redis, vector database, autonomous agent or arbitrary SQL layer.

## 3. Canonical master data strategy

- Current canonical entity: `departmentId = departments.id`.
- External records must resolve `externalId → internalId` before analytics.
- Contract fields for `locationId`, `divisionId`, `sectionId`, `groupId`, `positionId` are nullable until real canonical masters exist.
- Display names may accompany a contract but may never be used as analytics join keys.
- `ExternalSystemMapping` and mapping resolver contracts are implemented in `src/lib/integrations`.
- Persistence will be added only together with a real connector and migration ownership.

## 4. Integration contracts

Implemented contracts include:

- `IntegrationRecordMeta`: `sourceSystem`, `externalRecordId`, `effectiveFrom`, `effectiveTo`, `lastUpdatedAt`.
- `CanonicalOrganizationRef`.
- `ExternalSystemMapping`.
- Future `RecruitmentDemand`, including canonical department, male/female/total, approval state, logical de-duplication key and supersede key.
- `RecruitmentPipelineSnapshot`.
- `WorkforceSupplyEvent`.
- `IntegrationSourceStatus` and `IntegrationBatch`.
- Connector registry, normalization and validation boundaries.

Source-of-truth rule for the current iteration:

1. Planning is the only enabled demand source.
2. Only active, non-superseded Planning versions count.
3. Supplements are additive approved demand, not replacement versions.
4. Recruitment Request/manual demand remain unavailable and contribute zero.
5. A future connector must provide `logicalDemandKey`/`supersedesDemandKey` to avoid cross-source double counting.

## 5. Deterministic formulas

### Demand

For each date and department:

```text
Demand(date) = SUM(authorized demand records effective on date)
```

Current authorized records are Planning rows where:

```text
status = ACTIVE
AND supersededBy IS NULL
AND startDate <= date <= endDate
```

Dashboard headline demand is the demand on the date with the greatest projected shortage (or peak demand when no shortage), not a sum of daily headcount requirements.

### Supply

```text
Expected Supply
= Recorded Current Workforce (Employment Session-derived)
+ Confirmed Incoming
+ Expected Returning
+ Transfer In
- Expected Exits
- Transfer Out
```

Current implementation:

- Recorded Current Workforce: latest valid APPROVED employment session per worker, started by today and not ended by today. This is not real-time Attendance/presence.
- Confirmed Incoming: latest APPROVED employment sessions with a future `starting_date`.
- Expected Returning: zero unless an explicit expected-return event exists. Historical returning pool is shown separately.
- Expected Exits: approved resignation (`INACTIVE`) applied on effective date.
- Transfer In/Out: completed transfer applied on effective date. Because current movement code moves the session immediately on confirmation, the service reconstructs today's pre-effective snapshot before applying a future transfer.
- ATS/HRIS/Attendance: unavailable, never faked.

### Gap and coverage

```text
gap = expectedSupply - demand
shortage = max(0, -gap)
surplus = max(0, gap)
coverageRate = demand > 0 ? expectedSupply / demand * 100 : null
```

Negative gap always means shortage throughout the new foundation.

### Conversion

```text
Application -> Approved = approved / applications
Approved -> Started = started / approved
Application -> Started = started / applications
requiredApplications = ceil(shortage / applicationToStarted * (1 + safetyBuffer))
```

If the denominator/sample is missing, the backend returns `null` and a warning instead of asking AI to calculate or invent a rate.

### Recruitment velocity

```text
applicationsPerDay = applications / observationDays
approvedPerDay = approved / observationDays
startedPerDay = started / observationDays
expectedDaysToCloseGap = shortage / startedPerDay
```

A warning is returned for a short period or fewer than 30 applications.

## 6. Forecast and confidence

- Forecast is a daily point-in-time series, maximum 90 days (default 30).
- Each point includes demand, current supply, incoming, returning, exits, transfers, expected supply and canonical gap.
- Output derives `firstRiskDate`, `peakShortageDate` and `peakShortage`.
- No ML or future supply invention is used.
- Confidence is deterministic (0–100; HIGH/MEDIUM/LOW) based on demand/supply availability, confirmed-data ratio, historical sample size, volatility input, horizon, stale sources and missing critical sources.
- A scenario is always downgraded to LOW and classified `ESTIMATED`.

## 7. Risk model

Central policy: `src/lib/workforce-intelligence/risk.ts`.

```text
0–24 LOW
25–49 MEDIUM
50–74 HIGH
75–100 CRITICAL
```

Factors currently supported:

- low coverage (up to +35),
- shortage size/rate (up to +25),
- short lead time (up to +20),
- no/insufficient started velocity (+10),
- confirmed expected exits (up to +8),
- weak ATS pipeline when available (+8),
- low conversion (+7),
- low data confidence (+5).

Every factor contains `key`, `contribution`, explanation and structured evidence. Returning pool is never subtracted from risk because it is not confirmed supply.

## 8. Action model

Central policy: `src/lib/workforce-intelligence/actions.ts`.

Actions are emitted only when rule evidence exists. They include action key, priority, affected canonical department, numeric target, deadline and evidence. AI cannot add actions; Analyze responses have their action list overwritten from deterministic backend candidates.

The action layer is read-only. It does not create Planning, approve workers, transfer workers, approve resignation, send email or mutate recruitment data.

## 9. AI architecture and safety

```text
Session + permission
       ↓
Controlled backend tool (scope derived server-side)
       ↓
Compact aggregate grounding payload
       ↓
Provider abstraction (Gemini adapter first)
       ↓
Strict JSON validation
       ↓
Backend-authoritative risk/confidence/actions
```

Controls:

- Provider module has no database import and receives no credentials other than its own API key.
- AI never receives `DATABASE_URL`, SQL access, raw tables, worker rows or PII.
- Ask AI rejects likely CCCD/phone/email input in phase one.
- At most 10 departments and 30 forecast points are sent to AI.
- Prompt, question and raw payload are not stored in audit logs.
- Input size, output tokens, timeout and one limited retry are configured centrally.
- Best-effort in-process rate limit: 10 AI requests/user/minute. No Redis is introduced.
- No cross-user cache is enabled.
- If AI is unconfigured/unavailable, deterministic analytics remains available and API returns `AI_UNAVAILABLE`.

Environment:

```text
AI_PROVIDER=gemini
AI_MODEL=gemini-2.5-flash
GEMINI_API_KEY=...
```

## 10. APIs

- `GET /api/workforce-intelligence/overview`
- `GET /api/workforce-intelligence/departments`
- `GET /api/workforce-intelligence/department/[id]`
- `POST /api/workforce-intelligence/scenario`
- `POST /api/workforce-intelligence/ai/analyze`
- `POST /api/workforce-intelligence/ai/chat`

All routes authenticate, require `dashboard.view`, apply `getUserScope` inside the service and return no worker PII.

## 11. Dashboard result

`/admin/dashboard` now places a future-looking Workforce Outlook above existing historical/operational analytics:

- demand, expected supply, projected gap, coverage,
- daily demand vs expected-supply trend,
- HIGH/CRITICAL department list,
- Department Risk Matrix and drill-down,
- recruitment velocity,
- returning-worker opportunity,
- expected exits,
- deterministic recommended actions,
- AI Analyze and Ask AI,
- confidence and unavailable-source warnings.

The existing Dashboard/Planning components are retained.

## 12. What-if foundation

Scenario overrides are applied in memory to one explicit, authorized target department:

- additional incoming,
- retained expected exits,
- returning workers activated (capped by aggregate returning pool),
- recruitment velocity multiplier.

No database write occurs. The output is marked `ESTIMATED` with LOW confidence.

## 13. Remaining limitations

- External systems are contracts only; no connector or fake production data exists.
- Current active supply is an employment-session snapshot, not real-time attendance.
- Returning pool has no contactability/availability probability and is not supply.
- ATS pipeline is unavailable; no probability-weighted supply is enabled.
- No canonical master IDs yet for location/division/section/group/position.
- Forecast has no demand history snapshot or volatility model.
- AI adapter requires deployment environment configuration.
- In-memory AI rate limiting is per warm instance; a shared limiter can be added later only if scale requires it.
- Existing audit risks listed in section 1.5 remain separate hardening work.
