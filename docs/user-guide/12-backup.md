[← Mục lục](./README.md)

# 12. Backup

**Ai dùng:** chỉ `ADMIN`. Vào **Control Center** (`/admin/system`) → mục **Backup**.

## 12.1 Backup dùng để làm gì?

Nút **"Export Database (JSON)"** tải về **toàn bộ dữ liệu nghiệp vụ** của hệ thống dưới dạng 1 file JSON — dùng làm bản sao lưu thủ công, hoặc để đưa cho lập trình viên/AI viết script khôi phục khi cần.

## 12.2 Phạm vi dữ liệu

Bao gồm: Department, DW Data, Daily Application, Worker Profile, Employment Session, Planning (kế hoạch + phân bổ), Workforce Movement, Data Scope, Phân quyền chi tiết, Form Builder, Trường dữ liệu, Workflow, Rule Engine, Thông báo, Nhật ký hệ thống.

> **Quan trọng:** File backup **KHÔNG bao gồm bảng tài khoản (`users`)** — vì bảng này chứa mật khẩu đã mã hoá (password hash). Đây là quyết định bảo mật có chủ đích, không phải thiếu sót. Nếu cần sao lưu danh sách tài khoản, ghi chú lại thủ công tại module Users.

## 12.3 Đây KHÔNG phải tính năng Restore tự động

> **Quan trọng:** Hệ thống hiện **chưa có nút "Khôi phục" tự động** từ file backup này. Muốn khôi phục dữ liệu từ file JSON đã tải, cần đưa file cho lập trình viên/AI viết script import thủ công **một lần**.

Với nhu cầu sao lưu định kỳ thật sự / khôi phục về đúng một thời điểm trong quá khứ (point-in-time recovery), tài liệu chính thức khuyến nghị dùng **Neon Branches** (chức năng chụp nhanh cấp cơ sở dữ liệu của nhà cung cấp Neon, có link tắt ngay tại Control Center) — vì cách này chụp lại đầy đủ cả index/ràng buộc dữ liệu mà file JSON xuất từ đây không thay thế được.

## 12.4 Khi nào nên backup?

- Trước khi thực hiện một đợt Import dữ liệu lớn.
- Trước khi Admin thực hiện các thay đổi cấu hình lớn (đổi Workflow, xoá hàng loạt ở Recycle Bin...).
- Định kỳ theo chu kỳ công ty quy định (ví dụ hàng tuần/hàng tháng) — xem gợi ý ở [Checklist vận hành](./22-checklists.md).

Tiếp theo: [13 — Tra cứu công khai](./13-public-lookup.md)
