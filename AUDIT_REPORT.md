# Production Stability Audit — Seasonal Worker

**Branch:** `audit/production-stability`
**Base:** `main` @ `a9a9e1b`
**Phase:** Stabilization / Bug-Fix
**Date:** 2026-08-16

> Tài liệu này là báo cáo AUDIT đầy đủ theo yêu cầu của đề bài. Mọi fix kèm
> regression test nằm trong các commit của PR này.

---

## A. Confirmed Bugs (đã xác nhận qua code)

| #   | Mức độ      | Mô tả                                                                                                                                                                                                                                                                | Vị trí                                                                                                                                                              | Trạng thái fix |
| --- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| A1  | **CRITICAL** | `load()` của trang Planning KHÔNG có `try/catch`/`finally` và KHÔNG kiểm `res.ok`. Khi `/api/planning` trả 500 (do DB lỗi, query timeout, dependency ngoại lệ) → `setLoading(false)` không chạy → trang loading vô hạn.                                              | `src/app/(internal)/admin/planning/page.tsx` `load()`                                                                                                               | **FIXED**      |
| A2  | **CRITICAL** | **KPI double-counting bug.** Công thức Balance đang là `Rq - Recruited + Quit` ở 3 nơi. Khi 1 worker nghỉ: Current giảm (đã bị trừ), Quit tăng → Balance bị cộng lại 1 lần. Test bắt buộc: Rq=10, Current-before=10, 1 quit → Current=9, Quit=1 → Balance = 2 (Sai); Expected = 1. | `src/lib/planning-recruitment-core.ts:83-87` `computeBalance`; `src/lib/workforce-request-kpi.ts:127-131` `computeBalance`; `src/lib/recruitment-request-utils.ts:206-219` `computeBalanceFromCanonical`; `src/lib/planning.ts:615-619` `recruitmentNeededMale/Female` | **FIXED**      |
| A3  | **HIGH**   | API `/api/recruitment-requests` cap `limit=1000` nhưng UI gọi `limit=5000` để dựng filter dropdown. Server trả 1000 → distinct facet chỉ dựng được từ tập con → user chọn được filter nhưng kết quả rỗng vì filter không có trong 1000 bản ghi đầu.                      | `src/app/(internal)/admin/recruitment-requests/page.tsx` `loadDistinct`; `src/app/api/recruitment-requests/route.ts:62`                                              | **FIXED** (thêm `/facets`) |
| A4  | **HIGH**   | `loadDistinct()` ở recruitment-requests page KHÔNG `setLoading`/`finally` — nhưng riêng nó đã có guard qua `try/catch` rỗng. Tuy nhiên khi cả 2 fetch chạy song song (`loadData` + `loadDistinct`), request `limit=5000` luôn fail → facet dropdown rỗng.           | `src/app/(internal)/admin/recruitment-requests/page.tsx` `loadDistinct`                                                                                              | **FIXED**      |
| A5  | **HIGH**   | `src/lib/planning-recruitment-core.test.ts:99-128` test KHÔNG bao gồm scenario A2 (quit mà Current đã giảm) → CI sẽ pass dù công thức sai. Cần regression test chính xác.                                                                                          | `src/lib/planning-recruitment-core.test.ts`                                                                                                                          | **FIXED** (thêm regression) |
| A6  | **MEDIUM** | Không có `fetchJsonWithTimeout` chuẩn — 30+ nơi tự `fetch().then().catch()` không timeout, không cancel, dễ infinite loading khi network chậm hoặc serverless cold start kéo dài.                                                                                | Toàn repo                                                                                                                                                            | **FIXED** (helper mới) |
| A7  | **MEDIUM** | Trang recruitment-requests `loadData()` đặt `setLoading(true)` ở đầu, có `try/catch/finally` riêng cho `toast`. Tốt. Nhưng khi `res.ok=false`, error chỉ đi qua `toast` — KHÔNG đặt ErrorState. User vẫn thấy spinner kết thúc + toast bay → có thể miss khi chuyển tab. | `src/app/(internal)/admin/recruitment-requests/page.tsx` `loadData`                                                                                                   | **FIXED** (ErrorState riêng) |
| A8  | **MEDIUM** | `/api/planning` GET: nếu bất kỳ dependency (`batchComputePlanningMetrics`, `batchComputeRequestKpis`, `requestKpiToPlanningMetrics`) throw → Next.js trả HTML 500. UI parse `await res.json()` → SyntaxError → setRows([]) im lặng. Không có requestId/rowCount/duration trong log. | `src/app/api/planning/route.ts`                                                                                                                                     | **FIXED** (structured error + log) |
| A9  | **LOW**    | `planning_periods.request_id` FK tới `recruitment_requests` đã được tạo ở migration 2026-08-16. Nhưng Drizzle schema (line ~640) chỉ khai báo `requestId: uuid("request_id")` KHÔNG CÓ `.references()`. Nếu production chưa chạy migration 2026-08-17 thì column cũng không tồn tại — Phase 1 sẽ phát hiện. | `src/db/schema.ts` `planningPeriods.requestId`                                                                                                                       | **DOCUMENTED** (Phase 1 SQL check) |
| A10 | **LOW**    | `recruitmentRequests.cost` ban đầu là `numeric(12,2)` ở schema gốc, migration 2026-08-17 đổi sang `integer`. Nếu production đang ở `numeric` mà code Drizzle kỳ vọng `integer`, runtime sẽ lỗi khi sort/compare. Cần `verify` và nếu thiếu chạy migration 2026-08-17. | `migrations/2026-08-17-planning-recruitment-upgrade.sql:46-58`                                                                                                      | **DOCUMENTED** |

---

## B. Probable Production Schema Mismatches

(Phase 1 SQL verification — xem `scripts/production-health-check.mjs`.)

| #    | Bảng / Cột                                  | Migrations có thể thiếu                                | Hậu quả nếu thiếu                                                                                                              | Action                                                                                                              |
| ---- | ------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| B1   | `recruitment_requests.starting_date`, `end_date` | `2026-08-17-planning-recruitment-upgrade.sql:24-25`    | Bảng import từ Excel/Google Sheets sẽ throw khi ghi cột mới.                                                                  | Chạy `2026-08-17` (idempotent).                                                                                     |
| B2   | `recruitment_requests.offered_vs_requested`, `completed_vs_requested` | `2026-08-17-planning-recruitment-upgrade.sql:30-31`    | Cột derived bị mất; UI hiển thị NaN/empty.                                                                                     | Chạy `2026-08-17`.                                                                                                  |
| B3   | `recruitment_requests.department_id` FK + idx | `2026-08-16-workforce-request-linkage.sql:25-26` + `2026-08-17:65-67` | Data Scope cho DEPT_MANAGER trả rỗng vì scope so sánh `recruitmentRequests.departmentId` (UUID) với không tồn tại.            | Chạy `2026-08-16-linkage` + `2026-08-17`.                                                                            |
| B4   | `planning_periods.request_id` FK + idx      | `2026-08-16-workforce-request-linkage.sql:34-35`        | `/api/planning` không gắn được KPI từ Recruitment Request; metrics tự tính lại = sai lệch.                                   | Chạy `2026-08-16-linkage`.                                                                                          |
| B5   | `request_allocations` (5 bảng mới)         | `2026-08-16-workforce-request-linkage.sql` (cả file)    | `/api/workforce-requests` 500, Allocation engine không hoạt động, KPI của Plan sai.                                            | Chạy `2026-08-16-linkage`.                                                                                          |
| B6   | `planning_column_configs`, `planning_tasks` | `2026-08-17-planning-recruitment-upgrade.sql:138-189`   | UI recruitment-requests không load được cột config; task center không có task tự đóng.                                         | Chạy `2026-08-17`.                                                                                                  |
| B7   | `recruitment_requests_status_chk` (EXPIRED allowed) | `2026-08-17-planning-recruitment-upgrade.sql:90-99`    | Ghi status='EXPIRED' → constraint violation.                                                                                  | Chạy `2026-08-17`.                                                                                                  |
| B8   | `employment_session_one_active_uq` partial unique | `2026-08-16-employment-lifecycle.sql:108-114` (chỉ tạo khi data sạch) | 2 session ACTIVE cho 1 worker có thể tồn tại ở production.                                                                   | Chạy `scripts/audit-employment-data.mjs` TRƯỚC; nếu clean → chạy migration; nếu dirty → dùng `/admin/employment-reconciliation` rồi chạy lại. |
| B9   | `workforce_movement_session_idx` + các cột lifecycle mới | `2026-08-16-employment-lifecycle.sql:42-45`            | Timeline worker profile không tra cứu được movement theo session.                                                              | Chạy `2026-08-16-employment-lifecycle`.                                                                             |
| B10  | `start_date_corrections` table             | `2026-08-16-employment-lifecycle.sql:75-92`            | Tính năng duyệt điều chỉnh starting date không có chỗ lưu; API 500.                                                          | Chạy `2026-08-16-employment-lifecycle`.                                                                             |
| B11  | `merge_templates`, `merge_template_fields`, `merge_jobs`, `merge_job_records` | `2026-08-15-document-merge-engine.sql` (cả file)       | Document Merge Center không load được.                                                                                         | Chạy `2026-08-15-document-merge-engine`.                                                                             |
| B12  | `daily_applications.worker_declared_*`, `employment_sessions.end_*`, `workforce_movements.employment_session_id` etc. | `2026-08-16-employment-lifecycle.sql:13-44`             | Self-declaration và lifecycle audit bị mất; `lib/employment.ts` throw.                                                         | Chạy `2026-08-16-employment-lifecycle`.                                                                             |
| B13  | `roles`, `permissions`, `role_permissions`  | `2026-08-14-dynamic-rbac-v2.sql` (cả file)             | `rbac.hasPermission` luôn false (bảng rỗng) → user ADMIN bị chặn khỏi mọi API.                                                 | Chạy `2026-08-14-dynamic-rbac-v2`.                                                                                  |
| B14  | `import_jobs`, `import_job_errors`, `staging_department`, `staging_dw_data`, `staging_daily_application` | (chưa thấy migration riêng)                             | Nếu import engine v3 được dùng, các API sẽ 500.                                                                               | Xác minh với query trong health-check; nếu thiếu → báo DevOps.                                                      |
| B15  | `users.session_version`                      | `2026-08-12-production-hardening.sql`                  | Session revocation không hoạt động; đổi password không đăng xuất thiết bị cũ.                                                  | Chạy `2026-08-12-production-hardening`.                                                                              |

---

## C. API Health Matrix

| Route                              | Page                            | Tables                                                                 | Permission                                                  | Migration Dep           | Error Handling                       | Risk                                               | Recommended Fix                                  |
| ---------------------------------- | ------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------- | ------------------------------------ | -------------------------------------------------- | ------------------------------------------------ |
| `GET /api/planning`                | `/admin/planning`               | planning_periods, departments, planning_targets, recruitment_requests | planning.view                                               | 2026-08-16-linkage + 17 | KHÔNG có try/catch ở route (chỉ try ở POST) | 500 crash nếu dependency lỗi; thiếu structured log | Thêm try/catch + structured error + requestId/duration |
| `POST /api/planning`               | `/admin/planning`               | planning_periods, planning_targets                                     | planning.request                                            | 2026-08-17              | OK (try/catch)                       | OK                                                | —                                                |
| `GET /api/recruitment-requests`    | `/admin/recruitment-requests`   | recruitment_requests, departments                                      | planning.view                                               | 2026-08-16 + 17         | Không try/catch; chỉ ép limit        | N+1 rủi ro nếu không paginate; facet 5000 fail    | Thêm `/facets` endpoint, giữ list 100/page       |
| `GET /api/departments`             | `/admin/planning`               | departments                                                            | requireRole                                                 | 2026-08-13              | Không rõ                             | Dùng làm dropdown trong nhiều trang → load 1 lần fail = nhiều trang hỏng | Thêm try/catch route; trả {rows: []} graceful    |
| `GET /api/recruitment-requests/facets` | (NEW)                       | recruitment_requests (DISTINCT)                                        | planning.view                                               | 2026-08-16 + 17         | MỚI — chuẩn hóa                     | —                                                  | Thêm endpoint mới                                |
| `GET /api/workforce-requests`      | `/admin/workforce-requests`     | recruitment_requests, request_allocations, employment_sessions        | planning.view                                               | 2026-08-16 + 17         | Cần audit                            | KPI phụ thuộc request_allocations                  | Xác minh sau khi sửa Balance                      |
| `POST /api/recruitment-requests`   | `/admin/recruitment-requests`   | recruitment_requests, departments                                      | planning.request                                            | 2026-08-16 + 17         | OK (try/catch)                       | OK                                                | —                                                |
| `POST /api/recruitment-requests/import` | modal import              | recruitment_requests                                                  | planning.import                                             | 2026-08-16 + 17         | Transaction-safe                      | OK                                                | —                                                |
| `GET /api/admin/dashboard`         | `/admin/dashboard`              | daily_applications, departments, recruitment_requests                 | admin.dashboard                                             | 2026-08-17              | Cần audit                            | N+1 rủi ro                                        | Dùng các query aggregate có sẵn                  |
| `GET /api/task-center`             | `/task-center`                  | planning_tasks, recruitment_requests, workforce_movements              | planning.view                                               | 2026-08-17              | Cần audit                            | OK                                                | —                                                |
| `GET /api/admin/notifications`     | `/admin/notifications`          | notifications                                                          | requireRole                                                 | (nền tảng)              | Cần audit                            | OK                                                | —                                                |
| `GET /api/admin/permissions`       | `/admin/permissions`            | permissions, role_permissions                                          | permissions.manage                                          | 2026-08-14              | Cần audit                            | OK                                                | —                                                |
| `GET /api/admin/data-scopes`       | `/admin/data-scopes`            | user_department_scopes, departments                                    | data_scopes.manage                                          | 2026-08-13              | Cần audit                            | OK                                                | —                                                |
| `GET /api/bulk-import`             | `/admin/import-data`            | import_jobs, staging_*                                                 | import.run                                                  | 2026-08-15              | Cần audit                            | Nếu staging thiếu → 500                            | Health check phát hiện                            |
| `GET /api/document-merge/templates` | `/admin/document-merge`        | merge_templates, merge_template_fields                                 | document_merge.manage                                       | 2026-08-15              | Cần audit                            | OK                                                | —                                                |
| `GET /api/employment/reconciliation` | `/admin/employment-reconciliation` | employment_sessions, workforce_movements                          | employment.reconcile                                        | 2026-08-16              | Cần audit                            | OK                                                | —                                                |

> Chi tiết từng route: xem code review trong PR. Tổng cộng 40+ route, đã rà
> điểm chịu lỗi của nhóm chính (Planning / Recruitment Request / Workforce).

---

## D. Frontend Infinite-Loading Locations (cần chuẩn hóa)

Đã rà toàn bộ `setLoading(true)` qua `grep -RE "setLoading\\(true\\)" src/app` :

| #   | File:line                                                              | Pattern lỗi                                                                                                              | Status |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------ |
| D1  | `src/app/(internal)/admin/planning/page.tsx:140-150`                   | `load()` thiếu try/catch/finally, thiếu res.ok                                                                            | **FIXED** (chuẩn hóa về helper + ErrorState) |
| D2  | `src/app/(internal)/admin/recruitment-requests/page.tsx:270-289`       | `loadData()` có try/finally nhưng KHÔNG có ErrorState — chỉ toast. Có nguy cơ user miss toast.                            | **FIXED** (thêm ErrorState + Retry)            |
| D3  | `src/app/(internal)/admin/recruitment-requests/page.tsx:291-313`       | `loadDistinct()` `try/catch` rỗng — không thông báo gì khi fail                                                            | **FIXED** (chuyển sang endpoint `/facets`)      |
| D4  | `src/app/(internal)/admin/recruitment-requests/page.tsx:218-237`       | `loadColumns()` đã đúng pattern (try/catch/finally)                                                                       | OK     |
| D5  | `src/app/(internal)/admin/dashboard/page.tsx`                          | Cần audit (xem CI)                                                                                                        | **PARTIAL** — helper thêm sẵn; PR này ưu tiên Planning & RR |
| D6  | `src/app/(internal)/admin/permissions/page.tsx`                        | Cần audit                                                                                                                  | **PARTIAL** |
| D7  | `src/app/(internal)/admin/data-scopes/page.tsx`                        | Cần audit                                                                                                                  | **PARTIAL** |
| D8  | `src/app/(internal)/task-center/page.tsx`                              | Cần audit                                                                                                                  | **PARTIAL** |
| D9  | `src/app/(internal)/admin/worker-profiles/page.tsx`                    | Cần audit                                                                                                                  | **PARTIAL** |
| D10 | `src/app/(internal)/admin/workforce-movements/page.tsx`                 | Cần audit                                                                                                                  | **PARTIAL** |
| D11 | `src/app/(internal)/admin/workforce-requests/page.tsx`                 | Cần audit                                                                                                                  | **PARTIAL** |
| D12 | `src/app/(internal)/admin/employment-reconciliation/page.tsx`          | Cần audit                                                                                                                  | **PARTIAL** |
| D13 | `src/app/(internal)/admin/document-merge/page.tsx`                     | Cần audit                                                                                                                  | **PARTIAL** |
| D14 | `src/app/(internal)/admin/import-data/page.tsx`                        | Cần audit                                                                                                                  | **PARTIAL** |
| D15 | `src/app/(internal)/admin/users/page.tsx`                              | Cần audit                                                                                                                  | **PARTIAL** |
| D16 | `src/app/(internal)/admin/system/page.tsx`                              | Cần audit                                                                                                                  | **PARTIAL** |
| D17 | `src/app/(internal)/admin/recycle-bin/page.tsx`                        | Cần audit                                                                                                                  | **PARTIAL** |
| D18 | `src/app/(internal)/admin/notifications/page.tsx`                      | Cần audit                                                                                                                  | **PARTIAL** |
| D19 | `src/app/(internal)/admin/audit/page.tsx`                              | Cần audit                                                                                                                  | **PARTIAL** |
| D20 | `src/app/(internal)/admin/rules/page.tsx`                              | Cần audit                                                                                                                  | **PARTIAL** |
| D21 | `src/app/(internal)/admin/workflow/page.tsx`                           | Cần audit                                                                                                                  | **PARTIAL** |
| D22 | `src/app/(internal)/admin/form-builder/page.tsx`                       | Cần audit                                                                                                                  | **PARTIAL** |
| D23 | `src/app/(internal)/admin/field-definitions/page.tsx`                  | Cần audit                                                                                                                  | **PARTIAL** |
| D24 | `src/app/(internal)/admin/members/page.tsx`                            | Cần audit                                                                                                                  | **PARTIAL** |
| D25 | `src/app/(internal)/hr/registrations/page.tsx`                         | Cần audit                                                                                                                  | **PARTIAL** |
| D26 | `src/app/(internal)/hr/workers/page.tsx`                               | Cần audit                                                                                                                  | **PARTIAL** |
| D27 | `src/app/(internal)/department/page.tsx`                               | Cần audit                                                                                                                  | **PARTIAL** |
| D28 | `src/app/(internal)/profile/page.tsx`                                 | Cần audit                                                                                                                  | **PARTIAL** |
| D29 | `src/app/lookup/page.tsx`                                              | Cần audit                                                                                                                  | **PARTIAL** |
| D30 | `src/app/page.tsx` (root)                                              | Cần audit                                                                                                                  | **PARTIAL** |

> **Lý do "PARTIAL":** Helper `fetchJsonWithTimeout()` + `useAsyncPageState` đã
> được ship trong PR này. Mỗi trang muốn migrate chỉ cần ~5 dòng. PR stabilization
> chỉ migrate 2 trang ưu tiên (Planning, Recruitment Requests) để tránh phá
> nghiệp vụ đang chạy. Các trang khác sẽ migrate dần trong các PR sau.

### Chuẩn hóa trạng thái

- `LOADING` (skeleton hoặc spinner) — chỉ hiển thị khi `loading=true`.
- `SUCCESS` — dữ liệu có; render table/list.
- `EMPTY` — server trả 200 nhưng `rows.length === 0`; hiển thị EmptyState.
- `ERROR` — fetch fail / res.ok=false; hiển thị `ErrorState` với mã lỗi, message thân thiện, nút "Thử lại".
- `TIMEOUT` — quá 12s không phản hồi; abort + ErrorState với mã lỗi `TIMEOUT`.
- `FORBIDDEN` — server trả 401/403; hiển thị thông báo phân quyền, không lộ stack.

### Helper mới (xem `src/lib/api-client.ts`)

```ts
fetchJsonWithTimeout<T>(url, { timeoutMs = 12000, signal? }): Promise<ApiResult<T>>
// ApiResult = { ok: true; data; status; durationMs } | { ok: false; code; message; status?; durationMs }
```

---

## E. KPI Integrity Issues

### E1 — Double-counting Balance (CRITICAL)

**Công thức hiện tại (3 nơi):**

```
Balance = max(0, Rq - Recruited + Quit)
```

**Tại sao sai:**

Khi worker nghỉ:
- `Recruited/Current` giảm (worker rời ACTIVE).
- `Quit` tăng (ghi nhận workforce movement RESIGNATION).
- Nhưng `Quit` KHÔNG nên được cộng thêm — vì cùng 1 worker đó đã bị loại khỏi Current.

**Test bắt buộc theo đề bài:**
| Biến | Trước | Sau 1 resign |
|------|-------|---------------|
| Request | 10 | 10 |
| Current (Active) | 10 | 9 |
| Quit | 0 | 1 |
| **Balance (formula cũ)** | 0 | **10 - 9 + 1 = 2 (SAI)** |
| **Balance (formula mới)** | 0 | **max(0, 10 - 9) = 1 (ĐÚNG)** |

**Source-of-truth mới:**

```
Need To Recruit = max(0, Request - Current)
```

`Quit` KHÔNG còn dùng để tính Balance. Nó vẫn được lưu như một **historical KPI** riêng (`totalQuit` để báo cáo attrition), nhưng KHÔNG cộng vào nhu cầu tuyển mới.

**Files sửa:**

1. `src/lib/planning-recruitment-core.ts:83-87` — `computeBalance()` đổi công thức.
2. `src/lib/workforce-request-kpi.ts:127-131` — `computeBalance()` đổi công thức.
3. `src/lib/recruitment-request-utils.ts:206-219` — `computeBalanceFromCanonical()` đổi công thức.
4. `src/lib/planning.ts:615-619` — `recruitmentNeededMale/Female` đổi công thức.
5. `src/lib/planning.ts:670-674` — `recruitmentNeededMale: kpi.maleBalance` ← nguồn từ `kpi` đã sửa, tự consistent.
6. `src/app/api/recruitment-requests/route.ts:99-101` (POST handler) — `computeBalance({...})` ← tự consistent.
7. `src/lib/recruitment-request.ts:154-170` (import path) — `computeBalanceFromCanonical()` ← tự consistent.

**Backfill SQL cần thiết:** Có. Mọi bản ghi `recruitment_requests` hiện tại có `total_balance` được tính bằng công thức cũ. Cần **recompute** sau khi deploy. Xem migration: `migrations/2026-08-18-balance-recompute.sql` (idempotent, không xoá dữ liệu).

### E2 — ACTIVE Employment Definition

```ts
// src/lib/workforce-request-kpi.ts
export function isActiveEmploymentSession(status, endDate): boolean {
  return status === "APPROVED" && endDate == null;
}
```

Đã đúng, đã có test trong `workforce-request.test.ts`. **CONFIRMED OK.**

### E3 — Allocation after resignation

Khi workforce_movement RESIGNATION được xác nhận:
- `employment_sessions.status` vẫn 'APPROVED' cho đến khi được đóng explicit.
- `employment_sessions.end_date` = `effectiveDate` của movement.
- `request_allocations.status` cho worker đó cần được set ENDED (đã có logic ở `lib/workforce-movements.ts`).
- Sau đó worker KHÔNG còn trong `request_allocations WHERE status='ACTIVE'` → KHÔNG còn trong Current.

**Đã đúng nghiệp vụ** sau khi sửa Balance formula.

---

## F. Performance Problems

| #   | Vấn đề                                                                                                                                                                                              | Mức độ      | Vị trí                                                              | Fix                                                                                       |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| F1  | `loadDistinct()` gọi `/api/recruitment-requests?limit=5000` để dựng filter dropdown. Server cap 1000 → facet chỉ chứa 1000 bản ghi → user chọn filter ngoài tập 1000 sẽ thấy "không có dữ liệu". | **HIGH** | `src/app/(internal)/admin/recruitment-requests/page.tsx:291-313`     | Tạo `/api/recruitment-requests/facets` chạy `SELECT DISTINCT` cho 5-7 cột, không load rows. |
| F2  | `/api/recruitment-requests` có `limit=1000` (hard cap). Không có pagination client-side. UI luôn `setRows(pData.rows ?? [])` mà không biết còn trang 2. | **MEDIUM** | `src/app/api/recruitment-requests/route.ts:62`                       | Tài liệu hóa rằng server cap = 1000; UI chuyển sang phân trang 100/page (mục tiêu của user). |
| F3  | Mỗi `useEffect([loadData])` chạy cả `loadColumns + loadData + loadDistinct` song song. Khi user đổi filter, 3 request phát sinh → race condition có thể setRows của request cũ sau request mới. | **MEDIUM** | `src/app/(internal)/admin/recruitment-requests/page.tsx`            | Thêm `AbortController` + token để abort stale request.                                   |
| F4  | `load()` ở planning page không abort khi status đổi nhanh.                                                                                                                              | **MEDIUM** | `src/app/(internal)/admin/planning/page.tsx:140-150`                | Thêm `AbortController` qua helper.                                                       |
| F5  | `/api/planning` không có try/catch — bất kỳ dependency nào throw đều trả 500 HTML → frontend parse fail im lặng.                                                                    | **HIGH** | `src/app/api/planning/route.ts:24-118`                              | Thêm try/catch, structured error, requestId/duration logging.                              |
| F6  | `planning.ts:670-674` `recruitmentNeededMale: kpi.maleBalance` ← `kpi.maleBalance` đã được tính bằng `computeBalance` cũ. Sau khi sửa formula sẽ tự consistent. Nhưng cần `totalBalance` được recompute ở DB cho dữ liệu cũ. | **HIGH** | `src/lib/planning.ts` + `recruitment_requests.total_balance`        | Migration `2026-08-18-balance-recompute.sql` recompute trên production.                     |

---

## G. Architecture Duplication (Planning vs Recruitment Request)

**Phân tích nghiệp vụ:**
- `planning_periods` / `planning_targets` / `planning_allocations` đại diện cho **giai đoạn kế hoạch** (theo Dept + thời gian + version).
- `recruitment_requests` / `request_allocations` đại diện cho **yêu cầu tuyển dụng thực tế** (theo Request Code, có requester, dates, status PENDING/PROCESSING/...).
- Hiện tại, code đã có `planning_periods.request_id` FK tới `recruitment_requests`. Mỗi Plan có thể liên kết 0 hoặc 1 Request.

**Đề xuất canonical architecture (KHÔNG xoá bảng nào trong PR này):**

```
recruitment_requests       = Workforce Request / business entity chính.
                              (1 record = 1 nhu cầu thật từ bộ phận)

planning_periods           = Versioning / history / planning period
                              (nhiều period cho cùng 1 request nếu revise;
                               hoặc nhiều supplement cho cùng 1 period gốc).

planning_targets           = Demand numbers (Nam/Nữ/Tổng) của period.
planning_allocations       = Mapping worker → period (nguồn 1).

request_allocations        = Mapping worker → request (nguồn 2 — bám theo request).
request_allocation_history = Audit mọi thay đổi allocation.
```

**Quy tắc không destructive (giữ cho PR này):**
- KHÔNG xoá `planning_periods`. Vẫn dùng để version + supplement.
- KHÔNG xoá `planning_allocations`. Vẫn dùng cho "phân bổ DW vào period".
- KHÔNG ép user phải tạo 2 record. UI hiện tại ĐÃ có 2 nút: "Kế hoạch gốc mới" và "Yêu cầu bổ sung" — đây là phân biệt giữa **tạo mới từ đầu** và **bổ sung cho kế hoạch gốc đang có**, không phải giữa 2 nghiệp vụ tách biệt.
- UI đã tốt ở mức "không buộc tạo 2 record" — chỉ cần đảm bảo mỗi Plan có thể link 1 Request, và metrics của Plan đọc từ Request (đã code trong `/api/planning`).

**Refactor plan (đề xuất cho PR sau, KHÔNG làm trong PR này):**
1. Chuẩn hóa "Create Workforce Request" là entry point chính ở `/admin/recruitment-requests`.
2. Planning page chỉ hiển thị các period đã link tới request, ẩn các period "DRAFT đứng độc lập" (giữ code cũ cho back-compat nhưng deprecate UI).
3. Cho phép tạo Plan kèm Request trong 1 form (form hiện đã có đủ field).
4. Bỏ `daily_quota` cũ trên `departments` (đã deprecated từ migration 2026-08-13).

---

## Triển khai Fix trong PR này

Xem các commit trong `audit/production-stability`. Tóm tắt:

| Commit nội dung                                                              |
| ---------------------------------------------------------------------------- |
| `fix(planning): add try/catch/finally + ErrorState + abort to load()`        |
| `fix(api): add structured error + requestId/duration logging to /api/planning` |
| `fix(kpi): correct Balance formula to remove Quit double-count (3 files)`    |
| `fix(recruitment-requests): add /facets endpoint; abort stale requests; ErrorState` |
| `feat(api): introduce fetchJsonWithTimeout helper + ApiError type`            |
| `feat(api): normalize /api/recruitment-requests error response`              |
| `feat(api): normalize /api/departments error response`                       |
| `test: add regression for Balance double-count + API error states`           |
| `feat(scripts): production-health-check.mjs (read-only verification)`        |
| `feat(migration): 2026-08-18-balance-recompute.sql (idempotent)`             |
| `chore(audit): add AUDIT_REPORT.md`                                          |

---

## Deploy Order (bắt buộc theo thứ tự)

1. **SQL verification (READ-ONLY)**: chạy `node scripts/production-health-check.mjs` để xác nhận production đang thiếu migration nào (B1-B15).
2. **Apply missing migrations (idempotent)**: chạy các file `migrations/2026-08-*.sql` bị thiếu theo thứ tự ngày. KHÔNG chạy `schema.sql`.
3. **Apply balance recompute**: chạy `migrations/2026-08-18-balance-recompute.sql` (recompute `male_balance/female_balance/total_balance` cho các bản ghi hiện tại).
4. **Deploy code**: push branch `audit/production-stability` → Vercel. KHÔNG cần downtime vì toàn bộ thay đổi backward compatible.
5. **Smoke test**: gọi `GET /api/health` (mới), `GET /api/planning?status=ACTIVE`, `GET /api/recruitment-requests?limit=10`, `GET /api/recruitment-requests/facets`. Mở `/admin/planning` — phải thấy "Đang tải" → "Kế hoạch" trong ≤ 2s hoặc "Không tải được. Thử lại." trong 12s.
6. **Rollback** (nếu cần):
   - Code: `vercel rollback` về deployment trước.
   - Migration `2026-08-18-balance-recompute`: tính lại bằng công thức cũ (xem ROLLBACK block cuối file migration) — NHƯNG không cần thiết vì đây là recompute, dữ liệu gốc (Rq/Recruited/Quit) không đổi.
   - Migration `2026-08-17` / `2026-08-16-linkage` / `2026-08-16-employment-lifecycle`: rollback theo block cuối mỗi file (idempotent, additive, nên giữ nguyên cũng không sao).

