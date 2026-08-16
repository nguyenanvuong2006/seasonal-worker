# Workforce Request ↔ Planning ↔ Employment/Allocation — Kiến trúc liên kết

> PR: bổ sung kiến trúc liên kết Workforce Request (recruitment_requests) ↔
> Planning (planning_periods/planning_targets) ↔ Employment/Allocation
> (employment_sessions + request_allocations).
> **Mục tiêu**: mọi số liệu nhân lực được tính từ **cùng một source of truth** —
> Workforce Request, Planning và Department không tự tính ra số khác nhau.

---

## 1. Source of truth (ai là nguồn dữ liệu của cái gì)

| Dữ liệu | Source of truth | Ghi chú |
|---|---|---|
| Nhu cầu (Male/Female/Total Request) | `recruitment_requests.male_rq / female_rq` | Total Request = Male + Female; fallback cột legacy `total_request` chỉ khi cả 2 = 0 |
| Hiện có (Current Workforce) | **ACTIVE Employment Session + ACTIVE request allocation** (`employment_sessions.status='APPROVED' AND end_date IS NULL` + `request_allocations.status='ACTIVE'`) | KHÔNG dùng Application count thay thế |
| Đã tuyển (Recruited) | Pipeline **Daily Application + Workflow** — `daily_applications` có `request_id` + stage kết thúc `APPROVED` (workflow_stages isEnd) | Các cột `male_recruited...` import tay trên recruitment_requests là snapshot legacy, KHÔNG dùng để tính KPI |
| Nghỉ việc (Quit) | **Workforce Movement** — resignation `INACTIVE` của worker TỪNG có allocation vào request, `effective_date` nằm trong khoảng thời gian request | |
| Worker đang tính vào request nào | `request_allocations` (status=ACTIVE) | Partial unique index: 1 worker ≤ 1 ACTIVE allocation |
| Application/Screened/Interviewed | `daily_applications.request_id` + stage từ `workflow_stages` (động theo cấu hình workflow) | |
| Resignation / Transfer | `workforce_movements` (không đổi) | |
| Mức đáp ứng của Planning | **Được tính TỪ Workforce Request** khi `planning_periods.request_id` có liên kết | Planning là follower, không tự tính |

## 2. Công thức (module thuần `src/lib/workforce-request-kpi.ts`)

```
Total Request = Male Request + Female Request

Current Workforce = đếm ACTIVE Employment Session có ACTIVE allocation vào request

Quit = đếm RESIGNATION INACTIVE của worker từng allocation vào request
       trong khoảng thời gian request:
       [requested_date ?? created_at, expected_date ?? vô hạn]
       và effective_date <= asOfDate (lịch sử), allocated_at <= effective_date

Male Balance   = max(0, Male Request   - Male Current   + Male Quit)
Female Balance = max(0, Female Request - Female Current + Female Quit)
Total Balance  = Male Balance + Female Balance

Fill rate % = min(100, round(Current / Total Request * 100))
```

**KHÔNG dùng Application count thay cho Current Workforce.**

## 3. Warning states (mục 7)

| Code | Mức | Quy tắc |
|---|---|---|
| `MALE_SHORTAGE` / `FEMALE_SHORTAGE` | SOFT | `Current < Request` (với Request > 0) |
| `MALE_OVER_TARGET` / `FEMALE_OVER_TARGET` | SOFT | `Current > Request` — lệch cơ cấu Nam/Nữ ĐƯỢC PHÉP, chỉ cảnh báo. VD: “Nam đang vượt cơ cấu yêu cầu 2 người; tổng nhân lực vẫn trong giới hạn.” |
| `TOTAL_OVER_TARGET` | **BLOCKING** | `Male Current + Female Current > Total Request` → chặn allocation mới (trừ khi override hợp lệ). “Tổng phân bổ đã vượt tổng nhu cầu.” |
| `FULFILLED` | OK | Không shortage, không over, đã đáp ứng đủ |

## 4. Quy tắc phân bổ (mục 4, 5, 6)

1. **Không double count**: 1 worker tối đa 1 ACTIVE request allocation tại 1 thời điểm.
   - Server-side: transaction + `SELECT ... FOR UPDATE` trên request + re-check.
   - DB constraint: partial unique index `request_alloc_one_active_per_worker_uq ON request_allocations(worker_id) WHERE status='ACTIVE'`.
2. **Chuyển Request A → B**: kết thúc allocation A (status=ENDED + history `REALLOCATE`), tạo allocation B; Employment Session VẪN ACTIVE; **không tạo Resignation**; không tính đồng thời ở A và B.
3. **Lệch cơ cấu Nam/Nữ**: không hard-block — chỉ warning (mục 5).
4. **Block vượt tổng**: `currentTotal >= totalRequest` → reject `TOTAL_OVER_TARGET` (409).
   - Override yêu cầu quyền **`planning.overallocate`** (mặc định fail-closed, không nằm baseline — admin cấp tại /admin/permissions) + `{confirmed: true, reason}` bắt buộc + ghi **audit riêng** vào `request_allocation_overrides`.
5. **Idempotent (double-click/retry)**: nếu worker đã có ACTIVE allocation đúng request → NOOP; race thật bị partial unique index chặn (onConflict + re-check).

## 5. Transaction

`allocateWorkersToRequest` (src/lib/workforce-request.ts) chạy toàn bộ trong `db.transaction`:
lock request (`FOR UPDATE`) → kiểm tra Data Scope → validate session ACTIVE → đọc ACTIVE allocations → `planAllocation()` (thuần, test được) → kết thúc allocation cũ (nếu re-allocate) → insert allocation mới (onConflict chống race) → ghi `request_allocation_history` (+ `request_allocation_overrides` nếu override) → backfill `daily_applications.request_id` → mirror `planning_allocations` (nếu request liên kết period) → invalidate `request_kpi_cache`. `writeAudit` chạy sau commit.

Nghỉ việc xác nhận (`APPROVE_RESIGNATION`): trong cùng transaction của workforce-movements → `endActiveRequestAllocationsForWorker()` (END + history) — KPI tự cập nhật vì tính lại từ source.

## 6. Indexes (migration)

- `request_alloc_one_active_per_worker_uq` (partial, `status='ACTIVE'`) — chốt DB chống double allocation.
- `request_alloc_request_status_idx`, `request_alloc_session_idx`, `request_alloc_worker_idx`.
- `request_alloc_history_request_idx`, `_worker_idx`, `_from_idx`, `_to_idx` (audit theo request/worker).
- `request_override_request_idx`, `request_comment_request_idx`, `request_kpi_cache_computed_idx`.
- `recruitment_requests_dept_id_idx`, `planning_request_idx`, `daily_app_request_idx` (liên kết ID).

## 7. Data Scope (mục 11)

- Lọc ưu tiên theo **FK** `recruitment_requests.department_id IN scope`; fallback text `department` cho request cũ chưa có department_id (chỉ khi `department_id IS NULL`).
- Dept Manager: **READ ONLY** — API list/detail/dashboard chấp nhận `workforce_request.view`; allocate yêu cầu `workforce_request.allocate` (baseline: HR_RECRUITER, ADMIN) → manager không chỉnh được Request/Recruit/Allocation/Balance. Comment nếu có `workforce_request.comment`.

## 8. Date logic (mục 14) — as of date

- Tham số `asOf` trên API: `today` (mặc định) | `expected` (theo expected_date từng request) | `YYYY-MM-DD` (historical snapshot).
- **Live (hôm nay)**: đếm theo trạng thái HIỆN TẠI (session APPROVED + end_date IS NULL, allocation status=ACTIVE).
- **Lịch sử**: dựng lại từ cửa sổ thời gian `started_at/ended_at` (allocation) và `starting_date/end_date` (session) — không dùng trạng thái hiện tại làm sai báo cáo lịch sử. Quit lọc `effective_date <= asOf`. Pipeline lọc `submitted_at <= asOf`.

## 9. KPI cache (mục 9)

- Bảng `request_kpi_cache` (PK request_id, as_of_date, payload jsonb, **computed_at timestamp**).
- Chỉ dùng cho dashboard tổng hợp, TTL 5 phút; API trả `source: LIVE|CACHE` + `computedAt`.
- **Recompute job**: `RECOMPUTE_REQUEST_KPI_CACHE` trong `scheduler.ts` (chạy qua /api/cron/run — Vercel Cron).
- Mọi quyết định allocation **LUÔN tính live trong transaction** — cache không phải source of truth; allocation còn chủ động xoá cache của các request bị ảnh hưởng.

## 10. Audit (mục 15)

- `request_allocation_history`: `worker_id, from_request_id, to_request_id, action (ALLOCATE|REALLOCATE|END|OVERRIDE), reason, changed_by, changed_at, override_confirmed`.
- `request_allocation_overrides`: log RIÊNG cho override vượt tổng (reason bắt buộc, current_total, total_request, confirmed).
- `audit_logs`: `ALLOCATE_TO_REQUEST` / `OVERRIDE_REQUEST_ALLOCATION` / `LINK_REQUEST_TO_PLANNING`.

## 11. Migration (mục 18)

`migrations/2026-08-16-workforce-request-linkage.sql` — **additive, idempotent** (`CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`), KHÔNG DROP, KHÔNG DELETE/UPDATE dữ liệu `planning_periods/planning_targets/planning_allocations` hiện có. Bảng mới: `request_allocations`, `request_allocation_history`, `request_allocation_overrides`, `request_comments`, `request_kpi_cache`; cột mới: `recruitment_requests.department_id`, `planning_periods.request_id`, `daily_applications.request_id`. `schema.sql` (production snapshot) đã cập nhật tương ứng.

## 12. Tests (mục 16) — `src/lib/workforce-request.test.ts`

| Test | Kết quả kỳ vọng |
|---|---|
| A. 5M+5F, phân bổ 7M+3F | ALLOWED + MALE_OVER_TARGET (+ FEMALE_SHORTAGE), không TOTAL_OVER_TARGET |
| B. Tổng 10, người thứ 11 | REJECTED `TOTAL_OVER_TARGET` |
| C. `planning.overallocate` + reason | ALLOWED + `overrideApplied` + warning vượt tổng vẫn hiển thị |
| D. Chuyển A → B | A giảm 1, B tăng 1, tổng công ty không đổi, không Resignation |
| E. Nghỉ việc | Current giảm 1, Quit tăng 1, Balance = max(0, 5-4+1) = 2 |
| F. Request hết hạn | Employment Session ACTIVE không phụ thuộc trạng thái request/planning |
| G. Gọi lặp / double-click | NOOP — không double allocation |

Chạy: `npm test` (node:test). Toàn bộ suite: 271 pass / 1 fail pre-existing (document-merge “Batch print with page break” — nằm ngoài phạm vi PR này).

## 13. API

| Endpoint | Mô tả |
|---|---|
| `GET /api/workforce-requests` | Danh sách request + KPI Nam/Nữ + warnings (asOf, scope) |
| `GET /api/workforce-requests/dashboard` | Planning Dashboard: Total Requested / Current / Recruited / Quit / Need To Recruit (Nam/Nữ) + drill-down |
| `GET /api/workforce-requests/[id]` | Chi tiết + drill-down workers/resigned + history + overrides + comments |
| `POST /api/workforce-requests/[id]/allocate` | Phân bổ / tái phân bổ / override (mục 4-6) |
| `PATCH /api/workforce-requests/[id]` | Liên kết Planning Period bằng ID (2 chiều) |
| `GET/POST /api/workforce-requests/[id]/comments` | Bình luận (Dept Manager comment) |
| `GET /api/workforce-requests/unplanned` | Danh sách session ACTIVE cho phân bổ |

## 14. Ghi chú kỹ thuật đáng biết

- `request_allocations` dùng **tham chiếu mềm** (không FK) tới recruitment_requests/employment_sessions: request dùng soft-delete và lịch sử allocation phải sống sót để tính Quit/history (FK thật sẽ bị cascade khi xoá cứng ở Recycle Bin). FK thật vẫn nằm ở các cột liên kết (department_id, request_id, planning_period_id).
- Drizzle khai báo `planning_periods.request_id` dạng soft reference để tránh vòng kiểu planningPeriods ↔ recruitmentRequests; FK thật nằm trong SQL migration.
- Mirror 2 chiều: allocate vào request → upsert `planning_allocations` (nếu có period liên kết); autoAllocate planning (period có `request_id`) → `mirrorPlanningAllocationToRequest` (tôn trọng block vượt tổng, không tự override). Mirror chỉ THÊM, không xoá dữ liệu planning legacy.
- Recruited của request cũ trước migration = 0 cho tới khi pipeline được liên kết (`daily_applications.request_id`) — allocate tự backfill khi session có daily_application_id.
