[← Mục lục](./README.md)

# 5. DW Data / Worker Profile / Employment Session

Đây là 3 khái niệm dễ nhầm lẫn nhất trong hệ thống. Hiểu đúng 3 khái niệm này giúp bạn đọc đúng ý nghĩa của cột "DW Data" trên Daily Application và không thắc mắc "sao người này lại có 2 tên gần giống nhau trong hệ thống".

## 5.1 Ba khái niệm, ba vai trò khác nhau

| Khái niệm | Nó là gì | Khi nào được tạo |
|---|---|---|
| **DW Data** | Kho dữ liệu lao động **dùng để đối chiếu** — trả lời câu hỏi "người này đã từng có trong hệ thống chưa?" | Được nạp sẵn từ dữ liệu cũ, hoặc tự động thêm mới khi HR duyệt một người đang gắn nhãn MỚI |
| **Worker Profile** (Hồ sơ điện tử) | **Hồ sơ duy nhất của một người**, gộp toàn bộ lịch sử các lần đăng ký/làm việc | Tự động tạo ngay khi người đó **đăng ký lần đầu** (kể cả trước khi HR duyệt) |
| **Employment Session** (Đợt làm việc) | Một **lần** đăng ký/một đợt làm việc cụ thể, gắn vào đúng 1 Worker Profile | Tự động tạo mỗi lần có một lượt đăng ký mới |

**Ví dụ dễ hiểu:** Chị A đăng ký làm việc lần đầu vào tháng 3 — hệ thống tạo 1 Worker Profile cho chị A và 1 Employment Session cho đợt làm tháng 3 đó. Tháng 8, chị A quay lại đăng ký lần nữa. Hệ thống **nhận ra chị A đã có hồ sơ** (qua đối chiếu DW Data / CCCD), nên **không tạo người mới** — chỉ thêm 1 Employment Session thứ hai vào đúng Worker Profile cũ của chị A. Kết quả: chị A luôn chỉ có **1** hồ sơ điện tử duy nhất, có thể xem lại toàn bộ 2 đợt làm việc của mình ở cùng một nơi.

## 5.2 DW Data

Vào Sidebar → **DW Data** (chỉ ADMIN, HR_RECRUITER).

<img src="images/desktop/dw-data.png" width="720" alt="Màn hình DW Data">

Đây là "nguồn sự thật" để trả lời câu hỏi cũ/mới. **Ai không có trong bảng này là lao động MỚI.** Nếu người mới khai sai CCCD, sửa lại CCCD ngay tại đây — hệ thống sẽ tự đồng bộ lại toàn bộ đơn đăng ký liên quan sang CCCD đúng.

Tìm kiếm theo CCCD / Họ tên / SĐT / Mã CODE (ví dụ định dạng mã: `DR0001-D`).

## 5.3 Hồ sơ điện tử (Worker Profile)

Vào Sidebar → nhóm **Quản lý lao động** → **Hồ sơ điện tử**.

<img src="images/desktop/worker-profile.png" width="720" alt="Tra cứu hồ sơ điện tử">

1. Nhập CCCD, bấm **Tra cứu**.
2. Xem thông tin cá nhân, mục **Biometric — Mã vân tay** (trạng thái Đã cấp/Chưa cấp — HR có thể nhập/sửa mã và thiết bị vân tay tại đây), và **Lịch sử làm việc** — toàn bộ các Employment Session của người này, mới nhất trước.

> **Mẹo:** Nếu hệ thống báo "Không tìm thấy hồ sơ", rất có thể người này chưa từng đăng ký lần nào qua hệ thống này (kể cả đăng ký hôm nay chưa lưu xong) — kiểm tra lại số CCCD.

Nút **"Đồng bộ dữ liệu cũ"** ở góc trên bên phải dùng để quét lại dữ liệu Daily Application cũ và tự tạo/liên kết Worker Profile + Employment Session còn thiếu — dùng khi nâng cấp hệ thống hoặc phát hiện dữ liệu cũ chưa được liên kết đầy đủ, không cần dùng hàng ngày.

Tiếp theo: [06 — Department](./06-department.md)
