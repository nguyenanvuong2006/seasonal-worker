# Xử lý sự cố — Import dữ liệu

| Lỗi | Nguyên nhân | Cách xử lý |
|---|---|---|
| **Sai encoding** (tên hiển thị lỗi font: "ÄĐịa chỉ", "SÄĐT"...) | File CSV không lưu ở UTF-8 (thường do mở/lưu lại bằng phần mềm không hỗ trợ UTF-8). | Mở lại file gốc trong Google Sheets/Excel hiện đại, xuất lại thành CSV (mặc định đã đúng UTF-8) — không tự sửa chuỗi thủ công. |
| **Sai ngày** ("Ngày đăng ký không đúng định dạng") | Giá trị ngày không khớp bất kỳ định dạng nào hệ thống hỗ trợ (xem [Import Guide](/help/import/IMPORT_GUIDE.md) mục 2) — thường do ô ngày trong Excel bị định dạng thành văn bản tự do. | Sửa lại giá trị theo 1 trong các định dạng được liệt kê, hoặc định dạng lại cột thành kiểu Date trong Excel trước khi xuất CSV. |
| **Sai số điện thoại** (cảnh báo, không chặn) | SĐT không đúng mẫu Việt Nam (10-11 số, bắt đầu bằng 0). | Kiểm tra lại — dòng vẫn được nhập, chỉ là cảnh báo để bạn rà soát sau. |
| **Thiếu cột** (Map Columns hiện ra) | File thiếu cột bắt buộc, hoặc tên cột quá khác biệt để hệ thống tự nhận diện. | Chọn đúng cột tương ứng trong bước Map Columns — không cần sửa file gốc. |
| **Trùng dữ liệu** | CCCD (DW Data), CCCD+Ngày đăng ký (Daily Application), hoặc Bộ phận+Nhóm (Department) đã tồn tại. | Đây là hành vi đúng — hệ thống chủ động chặn trùng, không phải lỗi. |
| **Mapping sai** (dữ liệu vào nhầm cột sau khi import) | Chọn nhầm cột ở bước Map Columns. | Vào Job Queue → xem lại Job → nếu đã merge nhầm, cần sửa thủ công dữ liệu đã nhập hoặc liên hệ Admin. |
| **Job "Failed" nhiều lần liên tiếp dù đã Retry** | Có thể do lỗi hệ thống ngoài dự kiến (mất kết nối database kéo dài...). | Tải Log lỗi (nút Download Log) để xem chi tiết từng dòng; nếu vẫn không rõ nguyên nhân, liên hệ Admin kèm Job ID. |
| **File rất lớn (>100.000 dòng) xử lý lâu** | Khối lượng dữ liệu lớn, hệ thống xử lý theo lô để đảm bảo ổn định thay vì nhanh nhất có thể. | Theo dõi ETA/tốc độ trên màn hình — không cần thao tác gì thêm, Job tự tiếp tục kể cả khi đóng trang. |

Nếu sự cố không nằm trong danh sách trên, liên hệ Admin kèm theo: **Job ID**, **tên file**, và ảnh chụp màn hình lỗi (nếu có).
