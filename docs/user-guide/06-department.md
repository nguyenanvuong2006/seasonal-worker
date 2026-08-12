[← Mục lục](./README.md)

# 6. Department

Có **2 màn hình khác nhau** tuỳ vai trò — đừng nhầm lẫn:

| Màn hình | Ai dùng | Xem gì |
|---|---|---|
| **Department** (`/admin/departments`) | ADMIN, HR_RECRUITER | Quản lý **toàn bộ** danh sách bộ phận trong hệ thống |
| **Bộ phận của tôi** (`/department`) | DEPT_MANAGER (ADMIN/HR_RECRUITER cũng xem được) | Chỉ xem lao động thuộc (các) bộ phận **được phân công** cho tài khoản đang đăng nhập |

## 6.1 Department (dành cho Admin / HR)

<img src="images/desktop/department-admin.png" width="720" alt="Quản lý Department">

- Cấu trúc **Dept. + Group** (ví dụ *Packing – A*, *Packing – B*) tương ứng với cách tổ chức xưởng thực tế.
- Bấm **"+ Thêm bộ phận"** để tạo bộ phận mới — bộ phận vừa tạo **sẽ tự động xuất hiện trong dropdown xếp việc** ở Daily Application ngay lập tức, không cần cấu hình gì thêm.
- Có thể sửa trực tiếp trên bảng: **Định mức lao động/ngày**, bật/khoá bộ phận (nút **Bật/Khoá** ở cột trạng thái — khoá một bộ phận sẽ ẩn nó khỏi dropdown xếp việc mới nhưng không xoá dữ liệu cũ), và **Xoá** (xoá mềm — đưa vào Thùng rác, xem [chương 9](./09-admin-modules.md#thùng-rác)).
- Các cột "Hôm nay" / "Tổng" cho biết số lao động đã được xếp vào bộ phận đó.

> **Lưu ý:** Cột "Định mức lao động/ngày" (Quota) là cơ chế **cũ**, hiện phần lớn đã được thay bằng [Planning theo giai đoạn](./07-planning.md) — vẫn hiển thị để tương thích ngược, không bắt buộc phải cập nhật nếu bộ phận của bạn đã dùng Planning.

## 6.2 "Bộ phận của tôi" (dành cho Quản đốc bộ phận)

<img src="images/desktop/department-manager.png" width="720" alt="Bộ phận của tôi">

Đây là "cổng nhận lao động" dành cho Quản đốc — chỉ hiện đúng những bộ phận được Admin gán cho tài khoản của bạn.

- Nếu bạn phụ trách **nhiều bộ phận cùng lúc**, chọn bộ phận muốn xem ở dropdown đầu trang.
- Chọn khoảng ngày để xem danh sách lao động được xếp vào bộ phận trong khoảng đó.
- 4 chỉ số nhanh: **Lao động nhận**, **Định mức/ngày**, **Người mới**, **Tỷ lệ lấp đầy**.
- Bấm **"Tải Excel gửi Zalo"** để xuất nhanh danh sách gửi cho tổ trưởng/nhóm Zalo của bộ phận.

> **Quan trọng — Data Scope:** Quản đốc bộ phận **chỉ nhìn thấy lao động thuộc (các) bộ phận được phân công** cho mình tại [Data Scope](./10-permissions-data-scope.md). Nếu bạn không thấy bộ phận cần tìm, hoặc màn hình báo "Tài khoản chưa được gán bộ phận nào", đây **không phải lỗi hệ thống** — liên hệ Admin để được gán đúng bộ phận tại Data Scope. Quản đốc cũng **không thể tự sửa** thông tin bộ phận (tên, định mức, người phụ trách) từ màn hình này — việc đó thuộc quyền Admin/HR ở màn hình Department phía trên.

Tiếp theo: [07 — Planning](./07-planning.md)
