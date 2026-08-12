[← Mục lục](./README.md)

# 17. Xử lý sự cố (Troubleshooting)

| Vấn đề | Nguyên nhân có thể | Cách xử lý |
|---|---|---|
| **Không đăng nhập được** | Sai tên tài khoản/mật khẩu; tài khoản bị Admin khoá; nhập sai quá 5 lần nên bị tạm khoá 15 phút | Kiểm tra lại thông tin, thử lại sau vài phút nếu bị báo "Quá nhiều lần đăng nhập sai"; nếu chắc chắn thông tin đúng, liên hệ Admin kiểm tra trạng thái tài khoản tại module Users |
| **Không thấy một menu nào đó** | Vai trò của bạn không có menu này; hoặc quyền tương ứng đang bị tắt | Đọc [chương 10](./10-permissions-data-scope.md); nếu vẫn không rõ, hỏi Admin kiểm tra tại Phân quyền chi tiết |
| **Không tìm thấy một lao động cụ thể** | Người đó chưa từng đăng ký qua hệ thống; CCCD tra cứu không khớp với CCCD đã lưu; hoặc bạn là Quản đốc bộ phận và người đó không thuộc phạm vi Data Scope của bạn | Kiểm tra lại CCCD; thử tìm trên DW Data (ADMIN/HR_RECRUITER); nếu là Quản đốc bộ phận, xác nhận với Admin về Data Scope đã gán cho bạn |
| **Không tạo được yêu cầu Nghỉ việc/Thuyên chuyển** | Chưa tìm và chọn đúng lao động trước; thiếu Bộ phận mới (bắt buộc với Thuyên chuyển) hoặc thiếu Ngày hiệu lực; hoặc quyền `workforce_movements.create` đang bị tắt cho vai trò của bạn | Kiểm tra đã điền đủ các trường bắt buộc (*); nếu vẫn không được, hỏi Admin kiểm tra quyền |
| **Không tạo được Planning mới (báo lỗi chồng lấn)** | Đã có 1 kế hoạch **Đang áp dụng** cùng bộ phận + nhóm với khoảng ngày trùng | Dùng **"Sửa (tạo version mới)"** trên kế hoạch hiện có, hoặc chọn khoảng ngày khác không trùng |
| **File Export thiếu CCCD/SĐT/Địa chỉ (hiện `••••`)** | Vai trò của bạn đang bị tắt quyền `privacy.view_cccd` / `privacy.view_phone` / `privacy.view_address` | Đây là hành vi **đúng theo thiết kế bảo mật**, không phải lỗi — liên hệ Admin nếu công việc của bạn thực sự cần xem đầy đủ các trường này |
| **Đang thao tác thì bị đẩy về trang đăng nhập** | Phiên đăng nhập đã hết hạn, hoặc tài khoản vừa bị đổi mật khẩu/khoá ở nơi khác | Đăng nhập lại; nếu việc này xảy ra thường xuyên bất thường, báo Admin kiểm tra |
| **Task Center báo lỗi hoặc không tải được** | Mất kết nối mạng tạm thời, lỗi máy chủ, hoặc phiên đăng nhập hết hạn | Bấm **Thử lại**; nếu báo hết quyền/hết phiên, làm theo hướng dẫn tương ứng trên màn hình |
| **Trang tra cứu công khai báo "Không tìm thấy hồ sơ"** | CCCD hoặc số điện thoại nhập không khớp với lúc đăng ký; hoặc hồ sơ chưa được xử lý xong | Kiểm tra lại chính xác cả 2 thông tin; nếu chắc chắn đúng, liên hệ HR để kiểm tra hồ sơ |

Không tìm thấy sự cố của bạn ở đây? Xem tiếp [18 — FAQ](./18-faq.md) hoặc liên hệ Admin/bộ phận IT nội bộ.

Tiếp theo: [18 — Câu hỏi thường gặp](./18-faq.md)
