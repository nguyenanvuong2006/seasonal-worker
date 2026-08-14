# Hướng dẫn nhập dữ liệu

## 1. Cách nhanh nhất: copy và dán thẳng vào bảng

Trang `/admin/import-data` mở sẵn một bảng template giống spreadsheet. Không cần tải file trung gian.

1. Chọn đúng loại dữ liệu: **Đăng ký tập nghề**, **Hồ sơ lao động (DW Data)** hoặc **Cơ cấu bộ phận**.
2. Trong Excel/Google Sheets, chọn vùng dữ liệu cần nhập rồi bấm **Copy**. Có thể copy cả hàng tiêu đề.
3. Quay lại trang Import, bấm ô bắt đầu rồi nhấn **Ctrl+V**. Có thể dùng nút **Dán từ clipboard** nếu trình duyệt cho phép.
4. Kiểm tra số cột và số dòng có dữ liệu, sau đó bấm **Xử lý ... dòng trong bảng**.

Nếu vùng được dán có hàng tiêu đề, hệ thống tự nhận diện tên cột/alias (không phân biệt dấu, hoa thường hoặc khoảng trắng) và ghép dữ liệu vào đúng cột. Bảng tự thêm dòng và phân trang khi dữ liệu dài; tối đa 10.000 dòng cho mỗi lần dán.

## 2. Thêm, xoá cột và đồng bộ câu hỏi form tập nghề

- Bấm dấu **×** trên header để bỏ một cột khỏi bố cục. Bố cục được lưu bằng `localStorage` riêng cho từng loại dữ liệu, nên reload hoặc quay lại bằng cùng trình duyệt vẫn giữ nguyên. Thao tác này không xoá metadata, dữ liệu hay câu hỏi trong hệ thống.
- Dùng ô **Thêm lại cột đã xoá / cột chưa hiển thị** để đưa cột trở lại; thay đổi này cũng được lưu.
- **Khôi phục cột mặc định** đưa các cột mặc định trở lại và lưu bố cục mới.
- Với bảng **Đăng ký tập nghề**, các cột màu cam là câu hỏi đang hiển thị trên form công khai.
- Bấm **Tạo cột = câu hỏi mới** để tạo một câu hỏi mới trên form đăng ký và thêm ngay cột tương ứng vào bảng.
- Những câu hỏi trùng với trường lõi như Giới tính, Dân tộc, Thời gian đăng ký làm hoặc Kênh giới thiệu được ghép thành một cột, tránh header trùng nhưng vẫn lưu đủ dữ liệu.
- Nếu bỏ một trường lõi bắt buộc (Ngày đăng ký, CCCD, Họ tên, SĐT...), hệ thống sẽ yêu cầu thêm lại trước khi xử lý.

## 3. Công cụ trong bảng

- **Dán từ clipboard**: dán tại ô đang được chọn.
- **Sao chép bảng**: copy hàng tiêu đề và mọi dòng có dữ liệu để dán ngược về Excel/Google Sheets.
- **Thêm 10 dòng**: thêm vùng nhập thủ công.
- **Điền ngày hôm nay**: chỉ có ở bảng Đăng ký tập nghề; điền ngày cho các dòng có dữ liệu nhưng còn trống Ngày đăng ký.
- **Xoá dòng**: biểu tượng thùng rác ở cuối mỗi dòng.
- **Tải template hiện tại**: tải CSV chỉ gồm đúng các cột đang hiển thị trong bố cục đã lưu.
- **Xóa dữ liệu trong bảng**: chỉ xoá nội dung ô/dòng, không đổi bố cục cột.
- **Khôi phục cột mặc định**: phục hồi và lưu lại bố cục cột ban đầu.

Khi paste có hàng tiêu đề, hệ thống nhận diện cả alias của cột đang ẩn để giữ đúng vị trí, nhưng bỏ qua dữ liệu cột ẩn và không tự thêm cột đó trở lại. Nếu không có tiêu đề mà vùng copy nhiều cột hơn phần bảng còn lại, thao tác sẽ bị chặn để tránh lệch dữ liệu.

## 4. Định dạng ngày/giờ được hỗ trợ

| Định dạng | Ví dụ |
|---|---|
| `dd/MM/yyyy` | `13/08/2024` |
| `dd/MM/yyyy HH:mm` | `13/08/2024 07:08` |
| `dd/MM/yyyy HH:mm:ss` | `13/08/2024 07:08:45` |
| `yyyy-MM-dd` | `2024-08-13` |
| `yyyy-MM-dd HH:mm:ss` | `2024-08-13 07:08:45` |
| ISO 8601 | `2024-08-13T07:08:45+07:00` |
| Số serial ngày của Excel | Hệ thống tự nhận diện |

Giá trị ngày sai ở trường bắt buộc khiến riêng dòng đó vào Error Log; ngày không bắt buộc sai định dạng chỉ tạo cảnh báo.

## 5. Xử lý nền bằng Import Engine

Bảng trực tiếp được gửi dưới dạng JSON tới `POST /api/import/paste` (không chuyển thành file CSV/multipart). Endpoint kiểm tra quyền, loại dữ liệu, column ID, cột bắt buộc, tối đa 10.000 dòng/150 cột và độ dài ô trước khi tạo Job. Nếu staging lỗi, Job/staging dở được dọn hoặc khóa để Retry không xử lý dữ liệu thiếu.

Sau khi gửi bảng, dữ liệu vẫn chạy qua pipeline an toàn:

```
Staging → Validate → Matching (Daily Application) → Merge → Hoàn tất
```

- **Staging**: nạp vào khu vực trung gian, chưa ảnh hưởng dữ liệu chính.
- **Validate**: kiểm tra ngày, CCCD, SĐT và trường bắt buộc.
- **Matching**: với Đăng ký tập nghề, đối chiếu CCCD với DW Data và nhận diện Bộ phận.
- **Merge**: ghi vào bảng chính theo lô; dữ liệu trùng được bỏ qua.

Có thể đóng trang sau khi Job được tạo. Dùng **Job Queue** để theo dõi tốc độ, ETA, lỗi/cảnh báo, huỷ, Retry hoặc Resume.

## 6. Khi nào dùng file CSV / Excel?

Nếu dữ liệu rất lớn hoặc trình duyệt chặn clipboard, mở khối **"Dữ liệu rất lớn? Dùng file CSV / Excel"** cuối trang. Hệ thống vẫn nhận `.csv`, `.xlsx`, `.xls`; file CSV nên dùng UTF-8. Để tải file mẫu đúng bố cục cột đã lưu, luôn dùng nút **Tải template hiện tại** trên thanh công cụ của bảng.

Nếu file có trường bắt buộc chưa tự nhận diện, màn hình **Map Columns** sẽ yêu cầu chọn cột tương ứng trước khi tạo Job.

## 7. Xem thêm

- [Câu hỏi thường gặp](/help/import/IMPORT_FAQ.md)
- [Xử lý sự cố](/help/import/IMPORT_TROUBLESHOOTING.md)
