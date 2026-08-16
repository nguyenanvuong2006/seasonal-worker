/**
 * Dang_ky_Tap_nghe_Template — HTML print template.
 *
 * ⚠️ ĐÂY LÀ BẢN TÁI DỰNG LAYOUT (reconstruction) dùng đúng 51 canonical placeholder
 * của template gốc. Các đoạn văn bản pháp lý dài (Quy định tập nghề, Tờ khai thuế…)
 * là boilerplate chuẩn — CẦN ĐỐI CHIẾU VERBATIM với Google Doc gốc trong bước
 * Visual Verification (Phase 9 / mục 19) trước khi chuyển production batch sang
 * HTML_PDF. Layout/placeholder/checkbox đã đặt đúng vị trí để visual diff.
 *
 * KHÔNG hardcode mapping dữ liệu ở đây: giá trị được Data Resolver fill qua <<...>>.
 * Token phải là literal `<<...>>` (KHÔNG HTML-escape) để renderer thay thế được;
 * renderer tự escape giá trị trước khi fill (chống XSS).
 */

import type { HtmlTemplate } from "@/lib/document-merge/html-renderer.ts";
import { GOOGLE_DOC_ID } from "./schema.ts";

const html = `
<div class="page">
  <div class="center">
    <p>CÔNG TY TNHH DALAT HASFARM</p>
    <p><b>CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM</b></p>
    <p class="underline">Độc lập – Tự do – Hạnh phúc</p>
  </div>

  <h1 class="center">GIẤY ĐĂNG KÝ TẬP NGHỀ</h1>
  <p class="center italic">(Kèm theo Hợp đồng đào tạo nghề)</p>

  <p>Kính gửi: <b>Công ty TNHH Dalat Hasfarm</b></p>
  <p>Tôi tên là: <b><<Ho_ten>></b></p>

  <table class="no-border">
    <tr>
      <td style="width:50%">Ngày sinh: <<Ngay_sinh>></td>
      <td style="width:50%">Số CCCD: <<So_CCCD>></td>
    </tr>
    <tr>
      <td>Ngày cấp: <<Ngay_cap_CCCD>></td>
      <td>Nơi cấp: <<Noi_cap_CCCD>></td>
    </tr>
    <tr>
      <td>Số điện thoại: <<So_dien_thoai>></td>
      <td>Email: <<Email>></td>
    </tr>
  </table>

  <p>Địa chỉ thường trú: <<Dia_chi_thuong_tru>></p>
  <p>Địa chỉ tạm trú (chỗ ở hiện tại): <<Dia_chi_tam_tru>></p>
  <p>Địa chỉ cư trú: <<dia_chi_cu_tru>></p>
  <p>Số định danh cá nhân đã cấp trước đó (nếu có): <<So_dinh_danh_cu>></p>

  <p>1. Tiền án, tiền sự:
    <span class="chk"><<Tien_an_tien_su_Co>></span> Có&nbsp;&nbsp;
    <span class="chk"><<Tien_an_tien_su_Khong>></span> Không
  </p>
  <p>2. Đã từng làm tại Dalat Hasfarm:
    <span class="chk"><<Da_tung_lam_DHF_Co>></span> Có&nbsp;&nbsp;
    <span class="chk"><<Da_tung_lam_DHF_Khong>></span> Không
  </p>

  <p>3. Loại công việc trước đây tại Dalat Hasfarm (nếu có):</p>
  <p>
    <span class="chk"><<Loai_cong_viec_Nhan_vien>></span> Nhân viên&nbsp;&nbsp;
    <span class="chk"><<Loai_cong_viec_Cong_nhan>></span> Công nhân&nbsp;&nbsp;
    <span class="chk"><<Loai_cong_viec_Lao_dong_tap_nghe>></span> Lao động tập nghề
  </p>

  <p>4. Khu vực làm việc trước đây (nếu có):</p>
  <p>
    <span class="chk"><<Khu_vuc_Da_Lat>></span> Đà Lạt&nbsp;&nbsp;
    <span class="chk"><<Khu_vuc_Da_Quy>></span> Đa Quý&nbsp;&nbsp;
    <span class="chk"><<Khu_vuc_Da_Ron>></span> Đạ Ròn&nbsp;&nbsp;
    <span class="chk"><<Khu_vuc_Lam_Ha>></span> Lâm Hà&nbsp;&nbsp;
    <span class="chk"><<Khu_vuc_Khac>></span> Khác
  </p>

  <p>5. Công việc hiện tại:
    <span class="chk"><<Cong_viec_hien_tai_Sinh_vien>></span> Sinh viên&nbsp;&nbsp;
    <span class="chk"><<Cong_viec_hien_tai_Khac>></span> Khác&nbsp;&nbsp;
    (Khác: <<Cong_viec_hien_tai_khac>>)
  </p>
  <p>Tên trường (nếu là sinh viên): <<Ten_truong>></p>

  <p>6. Tài khoản ngân hàng chính chủ:
    <span class="chk"><<TKNH_Da_co>></span> Đã có&nbsp;&nbsp;
    <span class="chk"><<TKNH_Chua_co>></span> Chưa có
  </p>
  <p>Số tài khoản: <<So_tai_khoan>> — Tên ngân hàng: <<Ten_ngan_hang>></p>

  <p>7. Nguồn thu nhập trong năm:
    <span class="chk"><<Thu_nhap_Chi_DHF>></span> Chỉ phát sinh tại Dalat Hasfarm&nbsp;&nbsp;
    <span class="chk"><<Thu_nhap_Ngoai_DHF>></span> Phát sinh ngoài Dalat Hasfarm
  </p>
  <p>Đơn vị có thu nhập khác: <<Cong_ty_thu_nhap_khac>> — Địa điểm: <<Dia_diem_thu_nhap_khac>></p>

  <p>8. Công việc đăng ký tập nghề:</p>
  <p>
    <span class="chk"><<Tap_nghe_Trong_cham_soc_thu_hoach>></span> Trồng, chăm sóc, thu hoạch&nbsp;&nbsp;
    <span class="chk"><<Tap_nghe_Ban_hang>></span> Bán hàng&nbsp;&nbsp;
    <span class="chk"><<Tap_nghe_Dong_goi>></span> Đóng gói&nbsp;&nbsp;
    <span class="chk"><<Tap_nghe_Khac>></span> Khác&nbsp;&nbsp;
    (Khác: <<Cong_viec_khac>>)
  </p>

  <p>Ngày nhận việc dự kiến: <<Ngay_nhan_viec>></p>
  <p>Mã hồ sơ (Code): <<Code>></p>

  <div class="right" style="margin-top:16pt">
    <p>Đà Lạt, ngày <<Ngay_ky_day>> tháng <<Ngay_ky_month>> năm <<Ngay_ky_year>></p>
    <p style="margin-top:24pt"><b>NGƯỜI ĐĂNG KÝ</b><br/><span class="italic">(Ký, ghi rõ họ tên)</span></p>
    <p style="margin-top:24pt"><<Ho_ten>></p>
  </div>
</div>

<div class="page">
  <h1 class="center">QUY ĐỊNH TẬP NGHỀ</h1>
  <p><b>Điều 1.</b> Người tập nghề tuân thủ nội quy lao động, quy định an toàn và
  thời gian làm việc của Công ty TNHH Dalat Hasfarm trong suốt thời gian tập nghề.</p>
  <p><b>Điều 2.</b> Thời gian tập nghề theo thỏa thuận tại Hợp đồng đào tạo nghề;
  bắt đầu từ ngày <<Ngay_nhan_viec>>.</p>
  <p><b>Điều 3.</b> Người tập nghề có trách nhiệm bảo quản tài sản, máy móc, dụng cụ
  được giao và bồi thường theo quy định nếu gây hư hỏng, mất mát do lỗi cá nhân.</p>
  <p><b>Điều 4.</b> Người tập nghề cam kết khai báo trung thực các thông tin cá nhân
  trong Giấy đăng ký tập nghề và chịu trách nhiệm trước pháp luật về tính chính xác.</p>
  <p><b>Điều 5.</b> Trong thời gian tập nghề, nếu có nhu cầu chấm dứt, người tập nghề
  phải báo trước cho người phụ trách theo quy định của Công ty.</p>

  <div class="right" style="margin-top:24pt">
    <p>Người tiếp nhận: <<Nguoi_tiep_nhan>></p>
    <p>Ngày tiếp nhận: <<Ngay_tiep_nhan>></p>
    <p style="margin-top:24pt"><b>XÁC NHẬN CỦA CÔNG TY</b><br/><span class="italic">(Ký, ghi rõ họ tên)</span></p>
  </div>
</div>

<div class="page">
  <h1 class="center">BẢN CAM KẾT THUẾ</h1>
  <p>Tôi tên là: <b><<Ho_ten>></b> — Số CCCD: <<So_CCCD>></p>
  <p>Cam kết: Trong năm tính thuế <<Nam_thue>>, tổng thu nhập chịu thuế của
  tôi thuộc diện chịu thuế thu nhập cá nhân. Tôi chịu trách nhiệm kê khai và nộp thuế
  theo đúng quy định của pháp luật.</p>
  <p>Tôi cam kết chịu trách nhiệm trước pháp luật về nội dung kê khai trên.</p>
  <div class="right" style="margin-top:24pt">
    <p>Đà Lạt, ngày <<Ngay_ky_day>> tháng <<Ngay_ky_month>> năm <<Ngay_ky_year>></p>
    <p style="margin-top:24pt"><b>NGƯỜI CAM KẾT</b><br/><span class="italic">(Ký, ghi rõ họ tên)</span></p>
    <p style="margin-top:24pt"><<Ho_ten>></p>
  </div>
</div>

<div class="page">
  <h1 class="center">GIẤY ỦY QUYỀN</h1>
  <p>Tôi tên là: <b><<Ho_ten>></b> — Số CCCD: <<So_CCCD>></p>
  <p>Địa chỉ thường trú: <<Dia_chi_thuong_tru>></p>
  <p>Ủy quyền cho Công ty TNHH Dalat Hasfarm thực hiện thủ tục đăng ký thuế, kê khai
  và nộp thuế thu nhập cá nhân theo quy định trong phạm vi công việc tại Công ty.</p>
  <p>Thời hạn ủy quyền: từ ngày <<Ngay_nhan_viec>> cho đến khi chấm dứt quan hệ
  lao động/tập nghề với Công ty.</p>
  <div class="right" style="margin-top:24pt">
    <p><<Dia_diem_ky>>, ngày <<Ngay_ky_day>> tháng <<Ngay_ky_month>> năm <<Ngay_ky_year>></p>
    <p style="margin-top:24pt"><b>NGƯỜI ỦY QUYỀN</b><br/><span class="italic">(Ký, ghi rõ họ tên)</span></p>
    <p style="margin-top:24pt"><<Ho_ten>></p>
  </div>
</div>

<div class="page">
  <h1 class="center">TỜ KHAI ĐĂNG KÝ THUẾ</h1>
  <table>
    <tr><th colspan="2">THÔNG TIN NGƯỜI NỘP THUẾ</th></tr>
    <tr><td style="width:35%">Họ và tên</td><td><<Ho_ten>></td></tr>
    <tr><td>Ngày sinh</td><td><<Ngay_sinh>></td></tr>
    <tr><td>Số CCCD</td><td><<So_CCCD>></td></tr>
    <tr><td>Ngày cấp / Nơi cấp</td><td><<Ngay_cap_CCCD>> — <<Noi_cap_CCCD>></td></tr>
    <tr><td>Địa chỉ thường trú</td><td><<Dia_chi_thuong_tru>></td></tr>
    <tr><td>Địa chỉ tạm trú</td><td><<Dia_chi_tam_tru>></td></tr>
    <tr><td>Số điện thoại</td><td><<So_dien_thoai>></td></tr>
    <tr><td>Email</td><td><<Email>></td></tr>
    <tr><td>Số định danh cá nhân cũ</td><td><<So_dinh_danh_cu>></td></tr>
  </table>

  <h3>Thông tin thuế</h3>
  <table>
    <tr><td style="width:35%">Năm tính thuế</td><td><<Nam_thue>></td></tr>
    <tr><td>Nguồn thu nhập</td><td><<Thu_nhap_Chi_DHF>> Chỉ tại DHF / <<Thu_nhap_Ngoai_DHF>> Ngoài DHF</td></tr>
    <tr><td>Đơn vị thu nhập khác</td><td><<Cong_ty_thu_nhap_khac>> — <<Dia_diem_thu_nhap_khac>></td></tr>
    <tr><td>Số hợp đồng dịch vụ thuế</td><td><<So_hop_dong_dich_vu_thue>></td></tr>
    <tr><td>Ngày hợp đồng dịch vụ thuế</td><td><<Ngay_hop_dong_dich_vu_thue>></td></tr>
  </table>

  <div class="right" style="margin-top:24pt">
    <p>Đà Lạt, ngày <<Ngay_ky_day>> tháng <<Ngay_ky_month>> năm <<Ngay_ky_year>></p>
    <p style="margin-top:24pt"><b>NGƯỜI NỘP THUẾ</b><br/><span class="italic">(Ký, ghi rõ họ tên)</span></p>
    <p style="margin-top:24pt"><<Ho_ten>></p>
  </div>
</div>
`;

const css = `
.page p { text-align: justify; }
table.no-border td { border: none; padding: 1pt 0; }
`;

export const dangKyTapNgheTemplate: HtmlTemplate = {
  key: "dang-ky-tap-nghe",
  name: "Giấy đăng ký tập nghề + Quy định + Hồ sơ thuế",
  googleDocIds: [GOOGLE_DOC_ID],
  html,
  css,
};
