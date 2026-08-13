[← Mục lục](./README.md)

# 20. Quy trình xử lý tình huống (SOP)

## SOP 1 — Lao động mới đăng ký lần đầu

- **Tình huống:** Một người chưa từng làm việc tại Dalat Hasfarm, đăng ký tập nghề lần đầu.
- **Ai xử lý:** Người lao động (tự đăng ký) → HR duyệt.
- **Các bước:**
  1. Người lao động vào trang đăng ký công khai, khai CCCD/SĐT và trả lời các câu hỏi bắt buộc.
  2. Hệ thống đối chiếu DW Data, không tìm thấy → gắn nhãn **MỚI**.
  3. HR mở Daily Application, thấy hồ sơ ở trạng thái Chờ duyệt, nhãn MỚI.
  4. HR kiểm tra thông tin, xếp Bộ phận + Nhóm, đổi trạng thái sang Đã nhận việc (dùng nút đơn lẻ hoặc "Duyệt Người Mới → DW Data" nếu duyệt hàng loạt).
- **Kết quả mong đợi:** Hồ sơ chuyển Đã nhận việc; người này **tự động được thêm vào DW Data** (nhãn đổi sang CŨ); Worker Profile + Employment Session đầu tiên được tạo.
- **Lỗi thường gặp:** Duyệt nhầm bộ phận; quên kiểm tra dấu cảnh báo ⚠ nếu người này tự khai "đã từng làm" nhưng không khớp DW Data.

## SOP 2 — Lao động cũ quay lại

- **Tình huống:** Một người đã từng làm việc trước đây, nay đăng ký lại.
- **Ai xử lý:** Người lao động → HR xác nhận.
- **Các bước:**
  1. Người lao động nhập CCCD — nếu trùng dữ liệu cũ, hệ thống **tự động điền lại thông tin**, không cần khai lại từ đầu.
  2. Hồ sơ được gắn nhãn **CŨ** ngay từ khi đăng ký.
  3. HR xác nhận nhanh, xếp bộ phận (có thể khác bộ phận lần trước).
- **Kết quả mong đợi:** Một Employment Session **mới** được thêm vào **đúng** Worker Profile cũ của người này — không tạo hồ sơ trùng.
- **Lỗi thường gặp:** Nhầm tưởng hệ thống tạo "người mới" — kiểm tra tại Hồ sơ điện tử để thấy rõ toàn bộ lịch sử làm việc gộp vào 1 hồ sơ.

## SOP 3 — HR duyệt và phân bộ phận

- **Tình huống:** Cuối buổi sáng, còn nhiều hồ sơ Chờ duyệt cần xử lý nhanh.
- **Ai xử lý:** HR Tuyển dụng.
- **Các bước:**
  1. Mở Daily Application, lọc Trạng thái = "Chờ duyệt" nếu cần.
  2. Tick chọn nhiều hồ sơ cùng lúc (thanh hành động xuất hiện khi có hồ sơ được chọn).
  3. Bấm "Duyệt & Nhập DW Data" (nếu duyệt) hoặc "Từ chối".
- **Kết quả mong đợi:** Toàn bộ hồ sơ được chọn chuyển trạng thái cùng lúc; kết quả chi tiết (số thành công/thất bại + lý do) hiện ngay sau khi xử lý.
- **Lỗi thường gặp:** Chọn nhầm cả hồ sơ chưa xếp bộ phận rồi duyệt — kiểm tra cột Bộ phận + Nhóm trước khi duyệt hàng loạt.

## SOP 4 — Người lao động đổi bộ phận

- **Tình huống:** Một lao động đang làm ở bộ phận A cần chuyển sang bộ phận B.
- **Ai xử lý:** Người tạo yêu cầu (HR hoặc Quản đốc, tuỳ quyền) → HR xác nhận.
- **Các bước:** Xem chi tiết đầy đủ ở [chương 8](./08-workforce-movement.md).
- **Kết quả mong đợi:** Yêu cầu Thuyên chuyển đi qua đúng luồng trạng thái tới "Đã chuyển bộ phận".
- **Lỗi thường gặp:** Quên ghi ngày hiệu lực đúng thực tế; tạo nhầm lao động do không kiểm tra kỹ CCCD sau khi tìm kiếm.

## SOP 5 — Người lao động nghỉ việc

- **Tình huống:** Một lao động xin nghỉ hẳn, không quay lại.
- **Ai xử lý:** Người tạo yêu cầu → HR duyệt.
- **Các bước:** Tạo yêu cầu Nghỉ việc với ngày hiệu lực + lý do → HR "Duyệt nghỉ việc" hoặc "Từ chối".
- **Kết quả mong đợi:** Trạng thái chuyển "Đã nghỉ việc"; hồ sơ Worker Profile vẫn giữ nguyên lịch sử (không xoá), chỉ dừng ở đó.
- **Lỗi thường gặp:** Nhầm giữa "Nghỉ việc" và "Thuyên chuyển" khi tạo yêu cầu.

## SOP 6 — Planning thiếu người

- **Tình huống:** Một kế hoạch Đang áp dụng có tỷ lệ lấp đầy thấp, ví dụ chỉ đạt 60/120 (50%).
- **Ai xử lý:** HR Tuyển dụng.
- **Các bước:**
  1. Vào Planning, xem cột tỷ lệ lấp đầy để phát hiện kế hoạch thiếu người.
  2. Bấm "Phân bổ lao động" để gán thêm lao động Unplanned (nếu có) vào kế hoạch.
  3. Nếu vẫn thiếu, phối hợp tuyển thêm qua Daily Application/trang đăng ký công khai.
- **Kết quả mong đợi:** Tỷ lệ lấp đầy tăng dần theo số lao động được phân bổ/tuyển thêm.
- **Lỗi thường gặp:** Quên rằng "Nhu cầu" chỉ là con số khai báo — hệ thống không tự tuyển người, chỉ theo dõi tiến độ.

## SOP 7 — Quản lý không tìm thấy lao động cần tìm

- **Tình huống:** Quản đốc bộ phận tìm một lao động nhưng không thấy trên hệ thống.
- **Ai xử lý:** Quản đốc bộ phận, có thể cần Admin hỗ trợ.
- **Các bước:**
  1. Kiểm tra lại chính tả tên/CCCD đang tìm.
  2. Kiểm tra người đó có thực sự thuộc (các) bộ phận đã được gán ở Data Scope không.
  3. Nếu chắc chắn đúng phạm vi mà vẫn không thấy, báo Admin kiểm tra Data Scope hoặc hỏi HR xem hồ sơ đã được duyệt/xếp bộ phận chưa.
- **Kết quả mong đợi:** Xác định được nguyên nhân — sai chính tả, ngoài phạm vi Data Scope, hoặc hồ sơ chưa được xử lý.
- **Lỗi thường gặp:** Cho rằng đây luôn là lỗi hệ thống trong khi phần lớn trường hợp là do Data Scope.

## SOP 8 — HR phát hiện CCCD sai

- **Tình huống:** Một hồ sơ đã lưu với CCCD bị gõ sai.
- **Ai xử lý:** HR Tuyển dụng (cần quyền `workers.edit`/`registrations.edit`).
- **Các bước:** Sửa trực tiếp CCCD tại Daily Application hoặc DW Data — hệ thống tự đồng bộ các hồ sơ liên quan.
- **Kết quả mong đợi:** CCCD đúng trên toàn bộ hồ sơ liên quan tới người này.
- **Lỗi thường gặp:** Chỉ sửa ở 1 chỗ (ví dụ chỉ sửa ở Daily Application) rồi cho rằng DW Data cũng đã đúng — nên kiểm tra lại cả hai nơi nếu nghi ngờ.

## SOP 9 — Người dùng không thấy menu

- **Tình huống:** Một nhân viên báo "tôi không thấy menu X" và nghĩ đây là lỗi.
- **Ai xử lý:** Người dùng tự kiểm tra trước, sau đó Admin nếu cần.
- **Các bước:** Xem [chương 10](./10-permissions-data-scope.md) mục 10.4 — kiểm tra lần lượt Role → Permission → Data Scope.
- **Kết quả mong đợi:** Xác định menu đó có đúng là không dành cho vai trò/quyền của họ hay không.
- **Lỗi thường gặp:** Báo cáo ngay là "lỗi hệ thống" khi thực ra là đúng thiết kế phân quyền.

## SOP 10 — Lookup công khai không tìm thấy kết quả

- **Tình huống:** Người lao động tra cứu nhưng hệ thống báo không tìm thấy.
- **Ai xử lý:** Người lao động, có thể cần HR hỗ trợ.
- **Các bước:** Xem [chương 13](./13-public-lookup.md) mục 13.3 — kiểm tra lại CCCD + SĐT đã nhập đúng lúc đăng ký chưa; nếu chắc chắn đúng, liên hệ HR kiểm tra hồ sơ.
- **Kết quả mong đợi:** Xác định nguyên nhân — sai thông tin nhập, hoặc hồ sơ chưa xử lý xong.
- **Lỗi thường gặp:** Nhầm số điện thoại hiện tại với số điện thoại đã khai lúc đăng ký (nếu đã đổi số).

Tiếp theo: [21 — Nên làm / Không nên làm theo vai trò](./21-do-dont.md)
