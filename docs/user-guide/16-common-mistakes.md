[← Mục lục](./README.md)

# 16. Lỗi thường gặp khi thao tác

| Lỗi | Vì sao xảy ra | Cách xử lý |
|---|---|---|
| **Chọn sai bộ phận khi duyệt** | Hai bộ phận tên gần giống nhau (*Packing – A* / *Packing – B*), hoặc chọn nhanh không nhìn kỹ dropdown | Kiểm tra lại tên đầy đủ Dept. + Group trước khi bấm duyệt; nếu đã lỡ duyệt sai, sửa lại cột "Bộ phận + Nhóm" ngay trên bảng Daily Application (nếu vẫn còn trong ngày) hoặc tạo yêu cầu Thuyên chuyển để chuyển đúng bộ phận |
| **Nhập sai CCCD** | Gõ tay thay vì quét QR, hoặc nhầm giữa CCCD 9 số (CMND cũ) và 12 số | Sửa trực tiếp tại DW Data hoặc Daily Application nếu phát hiện sớm — hệ thống sẽ tự đồng bộ lại các hồ sơ liên quan sang CCCD đúng. Luôn kiểm tra kỹ trước khi duyệt hàng loạt |
| **Tạo Planning bị chồng lấn thời gian** | Cố tạo 2 kế hoạch **Đang áp dụng** cùng bộ phận + nhóm với khoảng ngày trùng nhau | Hệ thống sẽ từ chối tạo — dùng chức năng **"Sửa (tạo version mới)"** trên kế hoạch hiện có thay vì tạo kế hoạch mới chồng lên |
| **Tạo Workforce Movement nhầm người lao động** | Tìm theo tên trùng, không kiểm tra kỹ CCCD trước khi xác nhận | Luôn đọc kỹ tên + CCCD hiển thị sau khi tìm kiếm trước khi bấm "Gửi yêu cầu"; nếu đã lỡ tạo nhầm, dùng nút **"Từ chối"**/**"Huỷ"** tương ứng để đóng yêu cầu sai rồi tạo lại đúng |
| **Dùng chung tài khoản với đồng nghiệp** | Tiện lợi trước mắt (không phải đăng nhập riêng) | Không nên — mọi thao tác ghi lại đúng tên tài khoản thực hiện; dùng chung làm mất khả năng truy vết trách nhiệm và vi phạm nguyên tắc bảo mật cơ bản |
| **Tưởng "không thấy menu" là lỗi hệ thống** | Không hiểu rằng menu hiển thị theo Role + Permission | Đây gần như luôn là **đúng thiết kế**, không phải lỗi — xem [chương 10](./10-permissions-data-scope.md) để tự kiểm tra, hoặc hỏi Admin nếu vẫn không chắc |

Tiếp theo: [17 — Xử lý sự cố](./17-troubleshooting.md)
