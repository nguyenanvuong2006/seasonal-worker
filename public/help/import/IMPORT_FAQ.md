# Câu hỏi thường gặp — Import dữ liệu

**Đóng trình duyệt giữa chừng có sao không?**
Không. Sau khi upload xong (nhận được Job ID), toàn bộ xử lý chạy ở phía server. Bạn có thể đóng trang, quay lại sau và xem tiến trình qua Job Queue.

**File CSV của tôi mở trong Excel bị lỗi font (ví dụ "Ä" thay vì "Đ") — có sao không?**
Không ảnh hưởng tới import. Hệ thống đọc CSV bằng bộ giải mã UTF-8 riêng, độc lập với cách Excel hiển thị file khi mở trực tiếp — chỉ cần file gốc được lưu đúng UTF-8 (mặc định khi xuất từ Google Sheets/Excel hiện đại).

**Vì sao 1 số dòng bị "Trùng lặp"?**
Hệ thống chặn trùng theo CCCD (DW Data), hoặc CCCD + Ngày đăng ký (Daily Application), hoặc Bộ phận + Nhóm (Department) — nếu dữ liệu đã tồn tại, dòng đó được bỏ qua thay vì tạo bản ghi trùng.

**Tôi có thể import lại đúng file đã lỗi 1 phần không?**
Có. Các dòng đã nhập thành công sẽ không bị nhập lại (nhờ cơ chế chặn trùng ở trên) — bạn có thể sửa lại các dòng lỗi trong file gốc (dựa theo Error Report tải về) rồi import lại nguyên file, hệ thống tự bỏ qua phần đã có.

**Import 1 file rất lớn (hàng chục nghìn dòng) mất bao lâu?**
Không có giới hạn cứng về số dòng. Thời gian phụ thuộc vào tải hệ thống tại thời điểm import — theo dõi tốc độ (dòng/giây) và ETA hiển thị trực tiếp trên màn hình.

**Job báo "Failed" — dữ liệu đã nhập có bị mất không?**
Không. Dữ liệu đã merge thành công trước khi lỗi xảy ra vẫn được giữ nguyên. Bấm "Retry" để tiếp tục từ đúng điểm dừng.

**Cột trong file của tôi đặt tên khác với hệ thống — có cần đổi tên cột trong file không?**
Không cần. Hệ thống tự nhận diện nhiều cách viết khác nhau (có dấu/không dấu, viết tắt…). Nếu vẫn không nhận diện được (cột bắt buộc), màn hình sẽ hỏi bạn chọn cột tương ứng (Map Columns) — không cần sửa file gốc.
