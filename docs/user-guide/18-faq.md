[← Mục lục](./README.md)

# 18. Câu hỏi thường gặp (FAQ)

**1. Vì sao tôi không thấy menu Admin (Users, Permissions, Data Scope...)?**
Vì tài khoản của bạn không có vai trò `ADMIN`. Các mục này chỉ hiện với vai trò Quản trị viên — đây là thiết kế bảo mật, không phải lỗi hiển thị.

**2. Vì sao tôi chỉ thấy một số bộ phận chứ không phải tất cả?**
Nếu bạn là Quản đốc bộ phận (`DEPT_MANAGER`), bạn chỉ xem được (các) bộ phận được Admin gán riêng cho tài khoản của mình tại Data Scope. `ADMIN` và `HR_RECRUITER` luôn xem toàn bộ. Xem [chương 10](./10-permissions-data-scope.md).

**3. Tôi có thể sửa CCCD của một hồ sơ đã đăng ký không?**
Có, nếu bạn có quyền `registrations.edit`/`workers.edit` — sửa trực tiếp tại Daily Application hoặc DW Data. Hệ thống sẽ tự đồng bộ CCCD mới sang các hồ sơ liên quan.

**4. Xoá dữ liệu trên hệ thống có mất vĩnh viễn ngay không?**
Không. Xoá thông thường (Department, DW Data, Daily Application) là **xoá mềm** — dữ liệu chuyển vào Thùng rác và khôi phục được bất cứ lúc nào. Chỉ khi Admin chủ động bấm **"Xoá vĩnh viễn"** trong Thùng rác thì dữ liệu mới thực sự mất, không thể hoàn tác.

**5. Lao động cũ quay lại làm việc thì hồ sơ của họ ra sao?**
Hệ thống tự nhận diện qua CCCD/tên+năm sinh/tên+SĐT và **gắn vào đúng hồ sơ điện tử (Worker Profile) cũ** — không tạo người mới. Xem [chương 5](./05-dw-data-worker-profile.md).

**6. Planning hết hạn thì dữ liệu có bị xoá không?**
Không. Kế hoạch hết hạn (Expired) vẫn giữ nguyên trong hệ thống, xem lại được ở tab "Đã hết hạn" — chỉ không còn tính là "đang áp dụng" nữa.

**7. Tôi có thể xuất Excel toàn bộ dữ liệu hệ thống không?**
Không qua nút "Xuất Excel" thông thường — nút này chỉ xuất đúng dữ liệu **đang lọc/hiển thị trên màn hình**. Muốn có bản sao lưu toàn bộ dữ liệu nghiệp vụ, dùng chức năng **Backup** (chỉ Admin) — xem [chương 12](./12-backup.md).

**8. Vì sao CCCD/SĐT trong file Excel xuất ra bị ẩn (hiện dấu chấm)?**
Vì vai trò của bạn đang không có quyền `privacy.view_cccd`/`privacy.view_phone` — đây là quy tắc bảo vệ thông tin cá nhân, do Admin cấu hình tại Phân quyền chi tiết.

**9. Tài khoản của tôi bị khoá thì có mất dữ liệu lịch sử không?**
Không. Khoá tài khoản chỉ chặn đăng nhập — mọi hành động đã thực hiện trước đó vẫn được giữ nguyên trong Nhật ký hệ thống.

**10. Tôi có thể dùng chung một tài khoản với đồng nghiệp không?**
Không nên. Mọi thao tác được ghi lại theo đúng tên tài khoản thực hiện — dùng chung làm mất khả năng xác định ai đã làm gì khi cần tra soát.

**11. HR có bắt buộc phải dùng Planning không?**
Không bắt buộc. Planning là công cụ tuỳ chọn để quản lý nhu cầu nhân lực theo giai đoạn — bộ phận nào chưa dùng Planning vẫn hoạt động bình thường với Định mức/ngày cũ trên Department.

**12. Vì sao yêu cầu Thuyên chuyển của tôi không thấy HR xử lý ngay?**
HR xử lý thủ công từng yêu cầu tại Workforce Movement — không có xử lý tự động. Nếu quá lâu chưa được xử lý, có thể liên hệ trực tiếp HR phụ trách.

**13. Người lao động có tự xem được lịch sử làm việc của mình không?**
Không có tính năng đăng nhập cho người lao động. Họ chỉ tra cứu được **kết quả xếp việc hôm nay và tổng số lần đăng ký** qua trang Tra cứu công khai — không xem được toàn bộ hồ sơ nội bộ.

**14. Kênh thông báo Zalo/SMS/Email đã hoạt động chưa?**
Chưa. Hiện chỉ kênh **IN_APP** (thông báo trong hệ thống) hoạt động thật; Zalo/SMS/Email mới dừng ở bước xếp hàng đợi, chưa thực sự gửi ra ngoài.

**15. Tôi có thể khôi phục hệ thống về đúng một ngày trong quá khứ không?**
Chức năng Backup hiện tại chỉ xuất file JSON để tham khảo/khôi phục thủ công qua script — không có nút "Khôi phục về ngày X" tự động trên giao diện. Muốn khôi phục điểm-trong-thời-gian thực sự, dùng Neon Branches (xem [chương 12](./12-backup.md)).

**16. Vì sao hồ sơ tôi vừa duyệt lại đổi từ nhãn "MỚI" sang "CŨ"?**
Vì khi bạn duyệt một người đang gắn nhãn MỚI, hệ thống tự thêm họ vào DW Data — từ thời điểm đó họ chính thức "đã có trong hệ thống", nên nhãn chuyển sang CŨ. Đây là hành vi đúng.

**17. Tôi có thể xem được mật khẩu của tài khoản khác không?**
Không, kể cả Admin. Mật khẩu chỉ lưu dưới dạng đã mã hoá một chiều — không ai xem lại được mật khẩu gốc, kể cả trong file Backup.

Tiếp theo: [19 — Thuật ngữ](./19-glossary.md)
