# Hướng dẫn Import dữ liệu

## 1. Chuẩn bị file

- Định dạng chấp nhận: **CSV**, **XLSX**, **XLS**.
- Encoding: file CSV nên lưu ở **UTF-8** (Excel/Google Sheets xuất CSV mặc định đã đúng UTF-8, có thể kèm BOM — hệ thống tự nhận diện và loại bỏ BOM, không cần bạn xử lý gì thêm).
- Dòng đầu tiên phải là **tên cột** (header) — hệ thống tự nhận diện tên cột theo nhiều cách viết khác nhau (có dấu/không dấu, hoa/thường, có khoảng trắng thừa). Ví dụ các cách viết sau đều được nhận diện là cùng 1 cột "Họ và tên": `Họ và tên`, `Ho va ten`, `HO VA TEN`, `Tên`, `Full Name`, `Worker Name` (miễn là đã được khai báo làm alias ở `/admin/field-definitions`).
- Tải file mẫu đúng chuẩn tại nút **"Tải file mẫu"** trên trang Import — file mẫu luôn khớp với cấu hình cột hiện tại của hệ thống.

## 2. Định dạng ngày/giờ được hỗ trợ

Hệ thống tự nhận diện các định dạng sau (không cần chỉnh sửa file trước khi import):

| Định dạng | Ví dụ |
|---|---|
| `dd/MM/yyyy` | `13/08/2024` |
| `dd/MM/yyyy HH:mm` | `13/08/2024 07:08` |
| `dd/MM/yyyy HH:mm:ss` | `13/08/2024 07:08:45` |
| `yyyy-MM-dd` | `2024-08-13` |
| `yyyy-MM-dd HH:mm:ss` | `2024-08-13 07:08:45` |
| ISO 8601 | `2024-08-13T07:08:45+07:00` |
| Số serial ngày của Excel | (tự động, khi cột được định dạng Date trong Excel) |

Nếu 1 giá trị ngày không khớp bất kỳ định dạng nào ở trên, dòng đó sẽ được đánh dấu lỗi (nếu là trường bắt buộc) hoặc cảnh báo (nếu không bắt buộc) — xem mục Error Report bên dưới, không làm hỏng toàn bộ file.

## 3. Quy trình Import (5 bước, chạy nền)

```
Upload → Validate → Staging → Matching (Daily Application) → Merge → Hoàn tất
```

1. **Upload** — chọn loại dữ liệu (Department / DW Data / Daily Application), chọn file, bấm "Tải lên & Tạo Job". Bạn có thể đóng trang ngay sau bước này — hệ thống tiếp tục xử lý ở phía server.
2. **Staging** — dữ liệu được nạp vào khu vực trung gian, chưa ảnh hưởng tới dữ liệu chính.
3. **Validate** — kiểm tra định dạng (ngày, CCCD, SĐT, số, các trường bắt buộc) trước khi ghi vào bảng chính. Dòng lỗi bị loại, dòng cảnh báo vẫn được nhập kèm ghi chú.
4. **Matching** (chỉ với Daily Application) — đối chiếu CCCD với DW Data và tên Bộ phận để tự động xác định lao động cũ/mới và xếp bộ phận.
5. **Merge** — ghi chính thức vào bảng dữ liệu, theo từng lô nhỏ để không giới hạn số dòng.

Bạn có thể theo dõi tiến trình theo thời gian thực (tốc độ, ETA, số dòng đã xử lý) ngay trên trang Import, hoặc đóng trang và quay lại xem sau qua **Job Queue**.

## 4. Map Columns (khi cần)

Nếu file có cột **bắt buộc** mà hệ thống chưa tự nhận diện được (tên cột quá khác biệt), màn hình sẽ hiện bước "Map Columns" — bạn chỉ cần chọn đúng cột trong file tương ứng với từng trường bắt buộc, rồi tiếp tục. Việc này chỉ xảy ra 1 lần cho mỗi file có cấu trúc cột lạ.

## 5. Retry / Resume

- **Resume**: nếu 1 Job đang xử lý bị gián đoạn (mất mạng, deploy mới…), bấm "Resume" trong Job Queue — hệ thống tiếp tục đúng từ điểm dừng, không xử lý lại từ đầu.
- **Retry**: áp dụng cho Job bị lỗi (Failed) — tiếp tục từ giai đoạn bị lỗi, không chạy lại toàn bộ.

## 6. Xem thêm

- [Câu hỏi thường gặp](/help/import/IMPORT_FAQ.md)
- [Xử lý sự cố](/help/import/IMPORT_TROUBLESHOOTING.md)
