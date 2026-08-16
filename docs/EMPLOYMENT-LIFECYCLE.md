# Employment Lifecycle — Daily Application + Xếp việc + Employment History

> Nâng cấp 2026-08-16. Đọc file này TRƯỚC khi sửa bất kỳ nghiệp vụ nào liên quan
> đến đăng ký / xếp việc / nghỉ việc.

## 1. SOURCE OF TRUTH

| Bảng | Vai trò | KHÔNG phải |
|---|---|---|
| `daily_applications` | **Lịch sử đăng ký/xin việc.** Mỗi lần một người nộp đơn = 1 dòng. Không overwrite, không xoá (chỉ soft-delete có audit). | ❌ Không phải nguồn sự thật của "đang làm việc". |
| `employment_sessions` | **Lịch sử làm việc thật.** Mỗi lần thực sự được xếp việc = 1 session: ở đâu, nhận việc ngày nào, còn làm hay đã nghỉ, ngày nghỉ, lý do nghỉ, ai xác nhận. | ❌ Không phải nơi lưu "đơn đăng ký". |
| `workforce_movements` | **Sự kiện** nghỉ việc / thuyên chuyển (đề xuất → xác nhận). `employment_session_id`, `confirmed_by/at`, `source` truy vết đầy đủ. | ❌ Movement PENDING chưa kết thúc employment. |
| `start_date_corrections` | Yêu cầu điều chỉnh ngày nhận việc (Recruiter tạo, Admin duyệt). Audit old/new không mất giá trị cũ. | |

**Định nghĩa ACTIVE (duy nhất, không suy đoán chỗ khác):**

```
ACTIVE := employment_sessions.status = 'APPROVED' AND end_date IS NULL
```

**Invariant #1:** 1 worker (1 CCCD qua `worker_profiles`) = **tối đa 1 session ACTIVE**.
Enforce 3 lớp:
1. Guard nghiệp vụ (route xếp việc) — `assertNoOtherActiveSession()`.
2. Kiểm tra lại TRONG transaction (SELECT … FOR UPDATE trên session của worker).
3. Partial unique index cấp DB `employment_session_one_active_uq (worker_id) WHERE status='APPROVED' AND end_date IS NULL` — lưới cuối cho race thật; lỗi 23505 được dịch thành thông báo nghiệp vụ.

## 2. Phân biệt 3 trạng thái (không được nhầm)

- **APPLICATION** — đăng ký xin việc (`daily_applications`).
- **ALLOCATION / PLANNING** — đang được tính vào Recruitment Request nào (`planning_allocations`).
- **EMPLOYMENT** — thực sự đang làm ở đâu (`employment_sessions`).

Hệ quả:
- Planning request hết hạn → Employment Session **vẫn ACTIVE**.
- Allocation bị chuyển → **không phải** Resignation.
- Chỉ **Resignation được xác nhận** mới kết thúc Employment Session vì nghỉ việc
  (`status='ENDED'`, `end_date`, `end_reason='RESIGNATION'`, `ended_by`, `end_movement_id`).

## 3. Business rules chính

### Default start date (rule #10)
`application_date ≠ employment_start_date`. Khi Recruiter bấm XẾP VIỆC, starting date mặc định =
**hôm nay theo Asia/Ho_Chi_Minh** (`todayStr()`), không lấy ngày đăng ký.

### Không backdate tuỳ ý (rule #11-12)
Recruiter không sửa starting date về quá khứ trực tiếp (`validateStartingDateInput`).
Thay vào đó: **Yêu cầu điều chỉnh ngày nhận việc** → `start_date_corrections`
(`PENDING_ADMIN_APPROVAL`) → Admin duyệt tại Task Center / `/admin/employment-reconciliation`.
APPROVE chạy transaction; `old_start_date`/`new_start_date`/`decided_by/at` lưu vĩnh viễn.
Người duyệt ≠ người tạo yêu cầu (kể cả Admin).

### Đăng ký lại khi đang ACTIVE (rule #5-6)
- `/api/registrations/check` trả `active_employment` → portal hiện warning
  “Bạn hiện đang được ghi nhận đang làm việc tại: [Bộ phận]”.
- NLĐ có thể tick self-declaration “Tôi xác nhận đã báo nghỉ tại [Dept] …” + ngày + ghi chú →
  lưu vào `daily_applications.worker_declared_previous_resignation` v.v.
- **Self-declaration KHÔNG BAO GIỜ** tự đóng session / tạo resignation / xoá allocation /
  chuyển bộ phận. Chỉ là thông tin chờ Recruiter xác minh.
- Application mới vẫn được lưu bình thường (lịch sử không bị chặn); employment session sinh ra
  ở trạng thái PENDING (chưa phải employment).

### Không xếp việc âm thầm (rule #7-9)
Khi Recruiter xếp việc cho người còn ACTIVE session ở nơi khác, server reject
(`ACTIVE_EMPLOYMENT_EXISTS`, HTTP 409) và UI hiện modal với các lựa chọn:
- **A. Từ chối xếp việc** — application chuyển REJECTED kèm reason, vẫn giữ trong lịch sử.
- **B. Yêu cầu xác nhận nghỉ** — tạo task `PREVIOUS_EMPLOYMENT_RESIGNATION_CONFIRMATION_REQUIRED`
  (= `workforce_movements` resignation PENDING_HR, `source='RECRUITER_REQUEST'`, idempotent theo session).
- **C. Xác nhận nghỉ & xếp việc mới** — chỉ role có `employment.resignation.confirm`; bắt buộc
  nhập Actual Resignation Date; 1 transaction: đóng A → movement RESIGNATION confirmed → mở B.
- **D. Xem lịch sử làm việc.**

### Bộ phận báo nghỉ (rule #4)
`POST /api/workforce-movements` bám đúng session ACTIVE (`employment_session_id`,
`source='DEPT_REPORT'`); khi HR APPROVE_RESIGNATION: session ACTIVE (không phải "gần nhất theo
regDate") được ENDED với đầy đủ `end_reason/ended_by/ended_at/end_movement_id`.
Daily Application cũ giữ nguyên để audit.

## 4. Permissions (enforce server-side)

| Key | Ai | Ghi chú |
|---|---|---|
| `employment.view` | HR, Manager, Director | Xem trạng thái employment |
| `employment.assign` | HR Recruiter | Xếp việc / tạo yêu cầu xác nhận nghỉ |
| `employment.resignation.report` | Dept Manager | Báo nghỉ trong Data Scope |
| `employment.resignation.confirm` | HR Recruiter | Xác nhận nghỉ & xếp việc mới (Option C) |
| `employment.history.view` | HR, Director | Lịch sử làm việc đầy đủ |
| `employment.start_date_correction.request` | HR Recruiter | Không approve được yêu cầu của chính mình |
| `employment.start_date_correction.approve` | Admin | |
| `employment.reconcile` | Admin | Reconciliation UI |

## 5. Task Center (#16)

Không có bảng tasks riêng (đúng kiến trúc hiện tại — query bảng nghiệp vụ):
- `PREVIOUS_EMPLOYMENT_RESIGNATION_CONFIRMATION_REQUIRED` = resignation PENDING_HR
  `source='RECRUITER_REQUEST'` — idempotent (1 session ACTIVE = 1 yêu cầu PENDING).
- `START_DATE_CORRECTION_REQUEST` = `start_date_corrections` PENDING — idempotent bằng
  partial unique index `start_date_correction_pending_uq`.
- CCCD mask theo `privacy.view_cccd`; deep link về worker/màn xử lý.

## 6. Migration & dữ liệu cũ (#17-18, #20)

1. Chạy `node scripts/audit-employment-data.mjs` (report-only) trước khi apply.
2. Apply `migrations/2026-08-16-employment-lifecycle.sql` — 100% additive, idempotent,
   có rollback plan trong file. Nếu dữ liệu có worker >1 ACTIVE: migration KHÔNG fail,
   KHÔNG auto-fix — chỉ NOTICE + view `v_duplicate_active_employment`.
3. Admin vào `/admin/employment-reconciliation` đối soát từng dòng (đóng session sai với
   ngày nghỉ xác nhận, bổ sung end_date, liên kết application…) — mọi hành động có audit,
   không DELETE lịch sử.
4. Chạy lại migration → unique index được tạo → invariant khoá vĩnh viễn ở DB.

## 7. Test

- `src/lib/employment-lifecycle.test.ts` — 21 test logic thuần (default start date, backdate,
  guard assignment, self-declaration không side-effect, badge, correction state machine,
  planning-expired-không-đóng-employment…).
- `src/lib/employment-transactions.test.ts` — 6 test mô hình transaction (A ENDED + B ACTIVE
  atomic, double-click idempotent, unique index chặn 2 ACTIVE, rollback giữa chừng,
  nghỉ-rồi-quay-lại giữ đủ history).
- Migration đã validate bằng Postgres thật (PGlite): clean run / re-run idempotent /
  reject ACTIVE thứ 2 / dirty data không tạo index + không fail.
