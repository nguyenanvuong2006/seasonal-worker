# Khôi phục tài khoản Admin bị vô hiệu hóa

Migration một lần:

`migrations/2026-08-14-reactivate-admin-anvuong.sql`

Migration chỉ đặt `is_active = true` cho username `anvuong` khi tài khoản đó đã có role `ADMIN`, đồng thời tăng `session_version` để các phiên cũ bị vô hiệu hóa sạch sẽ.

## Cách chạy trên Neon

1. Mở Neon Console của database production.
2. Vào SQL Editor.
3. Mở file migration nói trên trong repo và copy toàn bộ nội dung.
4. Chạy một lần.
5. Câu `SELECT` cuối file phải trả về `username = anvuong`, `role = ADMIN`, `is_active = true`.
6. Đăng nhập lại hệ thống bằng tài khoản Admin.

Không cần chạy lại `schema.sql`.

## Lưu ý quản trị thành viên

API hiện đã hỗ trợ cập nhật user và xóa user, nhưng UI hiện tại đặt thao tác trạng thái trực tiếp trên badge nên rất dễ bấm nhầm. Cần thay UI bằng các nút Sửa / Đổi mật khẩu / Khóa-Kích hoạt / Xóa và hộp xác nhận trước thao tác nguy hiểm. Đồng thời backend nên chặn tự khóa, tự hạ role Admin và xóa/khóa Admin hoạt động cuối cùng.
