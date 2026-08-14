# User Management follow-up

Yêu cầu UX cần triển khai sau khi khôi phục Admin:

- Không đổi Role/Bộ phận/Trạng thái bằng control inline dễ bấm nhầm.
- Có modal **Sửa thành viên** để cập nhật Họ tên, Role, Bộ phận.
- Có nút **Đổi mật khẩu** riêng.
- Có nút **Khóa/Kích hoạt** với hộp xác nhận.
- Có nút **Xóa thành viên** với hộp xác nhận nguy hiểm.
- Không cho tài khoản đang đăng nhập tự khóa hoặc tự xóa chính mình.
- Không cho tài khoản đang đăng nhập tự hạ role khỏi ADMIN.
- Không cho khóa, hạ role hoặc xóa Admin hoạt động cuối cùng.
- Tất cả thay đổi tiếp tục ghi Audit Log và tăng session_version khi Role/Password/Active thay đổi.

Các file liên quan hiện tại:

- `src/app/(internal)/admin/users/page.tsx`
- `src/app/api/users/route.ts`

Connector trong phiên ChatGPT hiện tại không cho phép ghi trực tiếp hai file quản trị quyền truy cập này; đây là giới hạn an toàn của công cụ, không phải lỗi repository.
