# Nâng cấp module Planning (Nhu cầu) — Workforce Recruitment Request

Tài liệu kỹ thuật kèm PR. Mọi mục dưới đây tương ứng với một yêu cầu đã đặt ra.

---

## 1. Schema — trước / sau

Nguyên tắc: **giữ nguyên** `planning_periods`, `planning_targets`,
`planning_allocations`; chỉ **mở rộng**. Không chạy lại `schema.sql`, không
`DROP`/`DELETE` dữ liệu lịch sử. Toàn bộ migration nằm trong một file duy nhất:
`migrations/2026-08-17-planning-recruitment-upgrade.sql` (idempotent).

### 1.1 `recruitment_requests`

| Trước | Sau | Lý do |
|---|---|---|
| `requested_date`, `expected_date`, `offered_date`, `completed_date` | thêm `starting_date`, `end_date` | Yêu cầu #6 — sáu loại ngày tách bạch, không dùng chung một cột |
| `cost numeric`, `recruited_vs_expected numeric` | `integer` | tránh sai lệch dấu phẩy động khi tổng hợp |
| — | `offered_vs_requested`, `completed_vs_requested` (integer, số ngày) | cột báo cáo trong bộ ~40 cột |
| — | `department_id uuid` FK → `departments(id)` | Data Scope phải lọc theo khoá ngoại, không so chuỗi |
| — | `previous_request_id`, `supersedes_request_id` | Yêu cầu #4 — chuỗi lịch sử chỉ-thêm |
| status CHECK 4 giá trị | thêm `EXPIRED` | Yêu cầu #13 — hết hạn **khác** huỷ |

Cột `Offerred Date` viết sai chính tả **không** được tạo thêm; alias được xử lý
ở tầng import (`resolveHeaderAlias`) nên file Excel cũ vẫn dán được.

### 1.2 `planning_allocations` — bảng lịch sử phân bổ

| Trước | Sau |
|---|---|
| `UNIQUE (employment_session_id, planning_period_id)` | thay bằng **partial unique** `planning_alloc_active_uq` trên `(employment_session_id, planning_period_id) WHERE allocation_end_date IS NULL` |
| — | `allocation_start_date`, `allocation_end_date` |
| — | `previous_allocation_id` (chuỗi truy vết) |
| — | `reallocated_by`, `reallocated_at` (ai chuyển, lúc nào) |
| — | `recruitment_request_id` FK + index |

Partial unique là mấu chốt: nó cho phép **đóng rồi mở lại** cùng một cặp
(session, period) — tức là giữ được dòng lịch sử — trong khi vẫn cấm hai phân bổ
*đang hiệu lực* trùng nhau.

### 1.3 Bảng mới

- `planning_column_configs` — cấu hình cột theo `(role, device)`, có
  `column_key`, `visible`, `sticky`, `sort_order`. Cấu hình nằm ở **DB**, không
  phải localStorage.
- `planning_tasks` — Task Center của Planning. Partial unique
  `planning_tasks_open_uq` trên `(task_type, recruitment_request_id)
  WHERE status IN ('OPEN','IN_PROGRESS')` → cron chạy lại không sinh task trùng.

---

## 2. Quyền mới

| Key | Cấp cho | Ý nghĩa |
|---|---|---|
| `planning.reallocate` | ADMIN, HR_RECRUITER | chuyển phân bổ DW sang yêu cầu khác |
| `planning.columns.manage` | ADMIN | sửa cấu hình cột cho mọi role |
| `planning.comment` | DEPT_MANAGER | ghi chú, **không** đổi số liệu nguồn |

`planning.request` và `planning.import` bị **thu hồi** khỏi DEPT_MANAGER bằng
cách upsert `allowed = false` — không `DELETE FROM role_permissions`, để lịch sử
phân quyền còn nguyên.

DEPT_MANAGER cũng bị gỡ khỏi danh sách role của guard ở
`POST /api/recruitment-requests`, `/import`, `/batch` và `PATCH|DELETE /:id`.

---

## 3. Nguồn sự thật của từng KPI

| Cột | Nguồn | Excel ghi đè được? |
|---|---|---|
| Male/Female Rq, Cost | người dùng nhập | ✅ |
| Total Request | `computeTotalRequest(maleRq, femaleRq)` | ❌ |
| Male/Female Application, Screened | Daily Application | ❌ |
| Male/Female Interviewed, Interview | workflow phỏng vấn | ❌ |
| Male/Female Recruited, Recruit | `planning_allocations` đang mở + `employment_sessions` APPROVED | ❌ |
| Male/Female Quit | `workforce_movements` `movement_type='resignation'`, `status='INACTIVE'` | ❌ |
| Male/Female/Total Balance | công thức bên dưới | ❌ |
| Recruited vs Expected, Offered/Completed vs Requested | tính từ ngày & số liệu trên | ❌ |

18 cột được liệt kê chính xác trong `SYSTEM_OWNED_COLUMN_KEYS`. Hàm
`stripSystemOwnedFields()` chặn chúng ở **mọi** đường ghi (POST, PATCH, import)
và trả về danh sách `rejectedFields` để HR biết giá trị nào trong file Excel đã
bị bỏ qua — im lặng bỏ qua sẽ khiến người dùng tưởng đã cập nhật.

### Công thức Balance

```
maleBalance   = max(0, maleRq   − maleRecruited   + maleQuit)
femaleBalance = max(0, femaleRq − femaleRecruited + femaleQuit)
totalBalance  = maleBalance + femaleBalance
```

Cộng `Quit` vì người nghỉ làm nhu cầu **hở lại**. `max(0, …)` tránh số âm khi
tuyển vượt chỉ tiêu.

---

## 4. Planning là lịch sử chỉ-thêm

Ba chỗ trước đây phá lịch sử, nay đã sửa:

1. `reviseActivePeriod()` — trước: `UPDATE planning_allocations SET
   planning_period_id = <version mới>`. Bản kế hoạch cũ mất sạch dấu vết ai đã
   được phân bổ. Nay: đóng từng phân bổ đang mở (`allocation_end_date`,
   `reallocated_by`, `reallocated_at`) rồi `INSERT` dòng mới trỏ về version mới,
   nối bằng `previous_allocation_id`.
2. `autoAllocateInternship()` — trước: `DELETE` phân bổ cũ. Nay: đóng rồi chèn
   mới; nếu DW **đã** ở đúng kế hoạch thì trả về sớm, không ghi gì (idempotent).
3. Yêu cầu tuyển dụng — `previous_request_id` / `supersedes_request_id` được
   `POST /api/recruitment-requests` nhận, kiểm tra tồn tại + Data Scope, và
   `GET /api/recruitment-requests/:id` trả về cả tổ tiên lẫn hậu duệ.

Hệ quả bắt buộc: mọi truy vấn **đếm** phân bổ phải thêm
`allocation_end_date IS NULL`, nếu không một DW bị tính hai lần. Đã bổ sung cho
`autoAllocateInternship`, `batchComputePlanningMetrics` (cả nhánh allocated lẫn
resigned) và `getUnplannedSessions`.

---

## 5. Task Center — điều kiện kích hoạt

Task `PLANNING_REALLOCATION_REQUIRED` được tạo khi **đồng thời**:

- `end_date < today`, **và**
- yêu cầu chưa ở trạng thái kết thúc (`COMPLETED` / `CANCELLED`), **và**
- còn ít nhất một phân bổ `allocation_end_date IS NULL`.

Job `expire_recruitment_requests` trong `src/lib/scheduler.ts` chạy định kỳ.
Chống trùng bằng partial unique `planning_tasks_open_uq` + `ON CONFLICT DO
NOTHING` — chạy cron 100 lần vẫn đúng một task.

Task tự động `DONE` khi phân bổ mở cuối cùng của yêu cầu đó được chuyển đi
(`shouldAutoCloseReallocationTask`).

Hết hạn **không** đổi status thành `CANCELLED`, **không** tạo
`workforce_movements`, **không** set ngày nghỉ, **không** set cờ inactive.

---

## 6. Transaction chuyển phân bổ

`reallocateDws()` trong `src/lib/planning-reallocation.ts`, tối đa 500 DW/lần:

```
BEGIN
  SELECT yêu cầu nguồn + đích            FOR UPDATE   -- khoá, kiểm tra Data Scope
  SELECT phân bổ đang mở theo allocationIds FOR UPDATE -- chống race double-click
  validateReallocationInput(...)                        -- nguồn ≠ đích, id hợp lệ
  UPDATE  đóng phân bổ cũ  (allocation_end_date, reallocated_by, reallocated_at)
  INSERT  phân bổ mới      (previous_allocation_id = phân bổ cũ)  ON CONFLICT DO NOTHING
  UPDATE  planning_tasks → DONE  nếu không còn phân bổ mở
COMMIT
```

Không có `DELETE`. Không đụng `employment_sessions`. Không đụng
`workforce_movements`. DW vẫn `ACTIVE` — **hết hạn yêu cầu ≠ DW nghỉ việc**.
Điều này còn được bảo đảm về mặt cấu trúc: `insert(workforceMovements)` chỉ tồn
tại ở `src/lib/workforce-movements.ts` và
`src/app/api/workforce-movements/route.ts`, không ở bất kỳ đường nào của
Planning.

---

## 7. Thực thi Data Scope (server-side)

Mọi API đều gọi `getUserScope(session)` rồi `scopeAllowsDepartment(scope,
departmentId)` **trước khi** đọc/ghi. Trả **404** chứ không 403 khi ngoài phạm
vi, để không tiết lộ sự tồn tại của bản ghi.

Bug đã sửa: bộ lọc scope cũ của route import so `row["Department"]` (chuỗi tự do
trong file Excel) với mảng UUID bằng `includes` — luôn `false`, tức là **không
lọc gì**. Nay giải chuỗi qua `matchHierarchy()` thành `department_id` rồi mới so.
Tương tự, `PATCH /:id` cũ so `existing.department` với scope và cho lọt mọi bản
ghi không có phòng ban.

Scope rỗng (`[]`) → 403 ở import, không thấy gì ở các endpoint đọc.
Scope `null` → không giới hạn (ADMIN / HR).

---

## 8. Thứ tự triển khai

1. Chạy `migrations/2026-08-17-planning-recruitment-upgrade.sql` **trước**.
   Mọi cột mới đều NULLable hoặc có DEFAULT → code **cũ** vẫn chạy bình thường
   sau khi migrate, nên không cần downtime.
2. Deploy code.
3. Kiểm tra job `expire_recruitment_requests` xuất hiện trong `scheduled_jobs`.

## 9. Chiến lược quay lui

Khối `ROLLBACK` (đã comment sẵn ở cuối file migration) khôi phục unique index
cũ, bỏ hai bảng mới và gỡ job. **Không** xoá cột nào của
`planning_allocations`: chúng NULLable nên code cũ không quan tâm, còn dữ liệu
tái phân bổ thì giữ được. Chỉ xoá cột khi đã chắc chắn không cần lịch sử.

Ở tầng code, quay lui về commit trước là an toàn vì không có migration phá vỡ
tương thích ngược.

---

## 10. Kiểm thử

`npm test` — 328 test, 327 đạt. Một lỗi duy nhất (`Batch print with page break`)
đã hỏng từ trước nhánh này, không liên quan.

| Bộ | Số test | Phạm vi |
|---|---|---|
| `planning-recruitment-core.test.ts` | 16 | Balance, sắp xếp theo Expected Date, hết hạn, chặn cột hệ thống |
| `planning-reallocation.test.ts` | 21 | chuyển 20 DW, Data Scope, cron không trùng task, không có RESIGNATION |
| `recruitment-request-db.test.ts` | 19 | import 100 dòng, trùng Request Code, whitelist ORDER BY, scope |
| `import/route.test.ts` | 9 | DEPT_MANAGER bị chặn import, preview, giới hạn 5000 dòng |
| `planning-history.test.ts` | 7 | append-only: không DELETE, nối `previous_allocation_id`, idempotent |

Tổng 72 test cho riêng phần Planning — vượt mức tối thiểu 12 và phủ hết các
tình huống đã liệt kê.

`npm run typecheck` sạch. `npm run build` thành công, không cảnh báo.
`npm run lint` giữ nguyên mức nền 2 lỗi / 41 cảnh báo (cả hai lỗi có sẵn ở
`main`, thuộc TanStack Table và `sidebar.tsx`, không nằm trong phạm vi PR này).
