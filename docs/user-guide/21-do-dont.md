[← Mục lục](./README.md)

# 21. Nên làm / Không nên làm theo vai trò

## ADMIN

**Nên làm:**
- Backup dữ liệu trước khi thực hiện thay đổi cấu hình lớn (Workflow, xoá hàng loạt ở Thùng rác...).
- Dùng "Xoá vĩnh viễn" ở Thùng rác thật thận trọng — hành động này không thể hoàn tác.
- Kiểm tra Nhật ký hệ thống định kỳ, đặc biệt sau khi có thay đổi phân quyền.
- Khoá tài khoản (thay vì xoá) khi nhân viên nghỉ việc, để giữ lịch sử thao tác của họ.

**Không nên làm:**
- Tắt hàng loạt permission mà không hiểu rõ tác động — có thể khiến cả một vai trò không thao tác được gì.
- Chia sẻ tài khoản Admin cho người khác dùng tạm.
- Xoá vĩnh viễn dữ liệu khi chưa chắc chắn 100%.

## HR_RECRUITER (Nhân sự tuyển dụng)

**Nên làm:**
- Kiểm tra Task Center đầu mỗi ngày làm việc.
- Kiểm tra kỹ cột DW Data (CŨ/MỚI) và dấu cảnh báo ⚠ trước khi duyệt.
- Chọn đúng bộ phận trước khi duyệt, đặc biệt với các bộ phận tên gần giống nhau.
- Ghi lý do rõ ràng khi tạo/xử lý yêu cầu Nghỉ việc, Thuyên chuyển.

**Không nên làm:**
- Duyệt hàng loạt mà không xem qua danh sách trước.
- Sửa CCCD/thông tin cá nhân mà không kiểm tra lại với chính người lao động khi có nghi ngờ.
- Bỏ qua dấu cảnh báo "tự khai đã từng làm nhưng không khớp DW Data" mà không kiểm tra kỹ.

## DEPT_MANAGER (Quản đốc bộ phận)

**Nên làm:**
- Kiểm tra "Bộ phận của tôi" thường xuyên để nắm số lao động thực tế được xếp.
- Tạo yêu cầu Nghỉ việc/Thuyên chuyển sớm khi có phát sinh, ghi rõ lý do để HR xử lý nhanh.
- Liên hệ Admin nếu phát hiện Data Scope của mình chưa đúng (thiếu/thừa bộ phận).

**Không nên làm:**
- Cho rằng mình có thể tự xác nhận thuyên chuyển — việc này luôn thuộc về HR.
- Dùng tài khoản của quản đốc khác để xem dữ liệu bộ phận không thuộc phạm vi của mình.
- Coi việc "không thấy bộ phận X" là lỗi hệ thống mà không kiểm tra Data Scope trước.

Tiếp theo: [22 — Checklist vận hành](./22-checklists.md)
