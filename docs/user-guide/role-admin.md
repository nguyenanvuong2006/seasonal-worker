[← Mục lục](./README.md)

# Cheat sheet — Admin

## Tôi cần kiểm tra gì định kỳ?

1. **Users** — tài khoản nào cần khoá (nhân viên đã nghỉ), tài khoản mới cần tạo. → [Chi tiết](./09-admin-modules.md#users-phân-quyền-rbac)
2. **Phân quyền chi tiết & Data Scope** — có ô cấu hình nào không còn hợp lý theo tình hình nhân sự hiện tại. → [Chi tiết](./10-permissions-data-scope.md)
3. **Control Center** — sức khoẻ hệ thống, dung lượng database, job nền có chạy đúng lịch không. → [Chi tiết](./09-admin-modules.md#control-center-system)
4. **Nhật ký hệ thống** — hoạt động bất thường (đăng nhập thất bại nhiều lần, thao tác ngoài giờ...).
5. **Thùng rác** — dọn định kỳ những bản ghi chắc chắn không cần khôi phục.
6. **Backup** — xuất dữ liệu định kỳ theo chu kỳ công ty quy định. → [Chi tiết](./12-backup.md)

## Việc thường làm khác

- Cấu hình Workflow/Rule Engine/Trường dữ liệu khi nghiệp vụ thay đổi.
- Quản lý danh sách bộ phận (tạo mới, khoá bộ phận ngừng hoạt động).
- Import dữ liệu ban đầu khi triển khai/di chuyển dữ liệu lớn.
- Hỗ trợ HR/Quản đốc khi họ báo "không thấy menu/dữ liệu" — kiểm tra theo mô hình 3 lớp Role → Permission → Data Scope.

## Checklist nhanh (xem đầy đủ ở [chương 22](./22-checklists.md))

- [ ] Không còn tài khoản của nhân viên đã nghỉ việc ở trạng thái Hoạt động
- [ ] Đã backup trong tháng
- [ ] Không có ô Permission bị tắt nhầm gây ảnh hưởng vận hành
- [ ] Thùng rác không tồn quá nhiều bản ghi cũ không cần thiết

## Đọc thêm

[09 — Các module Admin](./09-admin-modules.md) · [10 — Permissions & Data Scope](./10-permissions-data-scope.md) · [11 — Import/Export](./11-import-export.md) · [12 — Backup](./12-backup.md) · [21 — Do/Don't](./21-do-dont.md) · [23 — Phụ lục](./23-appendix.md)
