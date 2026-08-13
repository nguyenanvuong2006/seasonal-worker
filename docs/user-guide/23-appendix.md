[← Mục lục](./README.md)

# 23. Phụ lục tham chiếu nhanh

## Role matrix

Menu hiển thị theo Sidebar, nhóm theo nghiệp vụ. Đánh dấu ✓ = vai trò thấy được mục này (trước khi tính thêm lớp Permission/Data Scope).

| Mục menu | ADMIN | HR_RECRUITER | DEPT_MANAGER |
|---|:---:|:---:|:---:|
| Dashboard | ✓ | ✓ | ✓ |
| Task Center | ✓ | ✓ | ✓ |
| Daily Application | ✓ | ✓ | |
| DW Data | ✓ | ✓ | |
| Department | ✓ | ✓ | |
| Bộ phận của tôi | ✓ | ✓ | ✓ |
| Hồ sơ điện tử | ✓ | ✓ | |
| Nghỉ việc / Thuyên chuyển | ✓ | ✓ | ✓ |
| Planning | ✓ | ✓ | ✓ |
| Câu hỏi động (Form Builder) | ✓ | ✓ | |
| Trường dữ liệu | ✓ | | |
| Workflow | ✓ | | |
| Rule Engine | ✓ | | |
| Thông báo | ✓ | ✓ | |
| Phân quyền RBAC (Users) | ✓ | | |
| Phân quyền chi tiết | ✓ | | |
| Data Scope | ✓ | | |
| Control Center | ✓ | | |
| Nhật ký hệ thống | ✓ | | |
| Nhập dữ liệu ban đầu | ✓ | | |
| Thùng rác | ✓ | | |

## Permission overview

29 quyền chi tiết cấu hình tại **Phân quyền chi tiết** (`/admin/permissions`). Mặc định **cho phép** cho tới khi Admin chủ động tắt.

| Mã quyền | Tên hiển thị |
|---|---|
| `registrations.view` | Xem Daily Application |
| `registrations.edit` | Sửa Daily Application |
| `registrations.approve` | Duyệt/Từ chối hồ sơ |
| `registrations.export` | Xuất Excel |
| `workers.view` | Xem DW Data |
| `workers.edit` | Sửa/Xoá DW Data |
| `departments.manage` | Quản lý Department |
| `questions.manage` | Quản lý Câu hỏi động (Form Builder) |
| `users.manage` | Quản lý tài khoản |
| `field_definitions.manage` | Quản lý Trường dữ liệu (Metadata) |
| `import.run` | Nhập dữ liệu (Import) |
| `recycle_bin.manage` | Quản lý Thùng rác |
| `history.manage` | Xem/Khôi phục Lịch sử |
| `workflow.manage` | Quản lý Workflow |
| `rules.manage` | Quản lý Rule Engine |
| `permissions.manage` | Quản lý Phân quyền chi tiết |
| `notifications.manage` | Quản lý hàng đợi Thông báo |
| `dashboard.manage` | Quản lý Dashboard |
| `backup.manage` | Backup dữ liệu |
| `system.view` | Xem Health Monitor |
| `privacy.view_cccd` | Xem CCCD khi Export |
| `privacy.view_phone` | Xem SĐT khi Export |
| `privacy.view_address` | Xem Địa chỉ khi Export |
| `data_scopes.manage` | Quản lý Data Scope |
| `workforce_movements.view` | Xem yêu cầu Nghỉ việc/Thuyên chuyển |
| `workforce_movements.create` | Tạo yêu cầu Nghỉ việc/Thuyên chuyển |
| `workforce_movements.manage` | HR xử lý yêu cầu Nghỉ việc/Thuyên chuyển |
| `planning.view` | Xem Planning |
| `planning.manage` | Quản lý Planning (tạo/sửa/kích hoạt) |

## Status dictionary

**Daily Application:**

| Trạng thái | Nhãn hiển thị |
|---|---|
| `PENDING` | Chờ duyệt |
| `APPROVED` | Đã nhận việc |
| `WAITLIST` | Dự phòng |
| `REJECTED` | Không nhận |

**Nghỉ việc (Resignation):**

| Trạng thái | Nhãn hiển thị |
|---|---|
| `PENDING_HR` | Chờ HR duyệt |
| `INACTIVE` | Đã nghỉ việc |
| `REJECTED` | HR từ chối |

**Thuyên chuyển (Transfer):**

| Trạng thái | Nhãn hiển thị |
|---|---|
| `PENDING_HR` | Chờ HR xác nhận |
| `TRANSFER_COMPLETED` | Đã chuyển bộ phận |
| `TRANSFER_RESCHEDULED` | Đã hoãn (chờ ngày mới) |
| `WAITING_DECISION` | Không đến — chờ HR quyết định |
| `CANCELLED` | Đã huỷ thuyên chuyển |
| `REJECTED` | HR từ chối |

**Planning:** `DRAFT` (Nháp) · `ACTIVE` (Đang áp dụng) · `EXPIRED` (Đã hết hạn)

**DW Match (đối chiếu):** `MATCHED` (Lao động CŨ) · `NEW` (Lao động MỚI) · `MISMATCH` (tự khai CŨ nhưng không khớp DW Data)

**Import Job:** `QUEUED` (Trong hàng đợi) · `RUNNING` (Đang xử lý) · `PAUSED` (Tạm dừng) · `DONE` (Hoàn tất) · `FAILED` (Thất bại) · `CANCELLED` (Đã huỷ)

> **Lưu ý:** Admin có thể đổi tên/màu hiển thị các trạng thái Daily Application, Nghỉ việc, Thuyên chuyển tại module **Workflow** — bảng trên là cấu hình mặc định ban đầu, tên hiển thị thực tế trên hệ thống của bạn có thể đã được đổi khác.

## Workflow overview

3 luồng dùng chung một Workflow Engine, không viết state machine riêng cho từng module: **Daily Application**, **Nghỉ việc** (`resignation`), **Thuyên chuyển** (`transfer`). Cấu hình tại `/admin/workflow`.

## Error messages thường gặp

| Thông báo | Ý nghĩa |
|---|---|
| "Sai tên đăng nhập hoặc mật khẩu." | Sai thông tin đăng nhập, hoặc tài khoản bị khoá (không phân biệt để tránh lộ thông tin) |
| "Quá nhiều lần đăng nhập sai. Vui lòng thử lại sau ít phút." | Bị tạm khoá đăng nhập sau 5 lần sai trong 15 phút |
| "Từ chối truy cập! Quyền hạn không hợp lệ." | Vai trò của bạn không được phép thực hiện thao tác này |
| "Tài khoản của bạn không có quyền thực hiện thao tác này." | Permission chi tiết đang bị tắt cho vai trò của bạn |
| "Đã xác nhận đăng ký hôm nay." | CCCD này đã đăng ký 1 lần trong ngày hôm nay |
| "Không tìm thấy hồ sơ khớp với CCCD và số điện thoại đã nhập." | Lookup công khai không khớp dữ liệu |

## Contact / escalation guide

| Vấn đề | Liên hệ |
|---|---|
| Quên mật khẩu, tài khoản bị khoá nhầm | Admin hệ thống |
| Cần thêm/sửa quyền, Data Scope | Admin hệ thống |
| Sai dữ liệu hồ sơ cá nhân (CCCD/tên/SĐT) | HR Tuyển dụng phụ trách |
| Yêu cầu Nghỉ việc/Thuyên chuyển chưa được xử lý | HR Tuyển dụng |
| Lỗi kỹ thuật (trang trắng, không tải được) lặp lại | Bộ phận IT/kỹ thuật nội bộ |

## Release / version notes

Xem [CHANGELOG.md](./CHANGELOG.md).

Tiếp theo: [role-hr.md](./role-hr.md) · [role-manager.md](./role-manager.md) · [role-admin.md](./role-admin.md)
