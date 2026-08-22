/**
 * Dang_ky_Tap_nghe_Template — HTML print template.
 *
 * Canonical HTML reconstructed VERBATIM from the live Google Doc
 * 10D0tG71CbllIZe7DaosYNW3vK7QnP76Yq4UC9FMEiUE (5 phần pháp lý đầy đủ).
 *
 * Giữ nguyên câu chữ golden source (kể cả cách viết HR/pháp lý của bản gốc).
 * Đúng 49 placeholder active. Hai orphan đã được operator chấp nhận
 * (So_hop_dong_dich_vu_thue, Ngay_hop_dong_dich_vu_thue) KHÔNG được khôi phục;
 * dòng hợp đồng dịch vụ thuế giữ dạng nội dung tĩnh như Google Doc.
 *
 * KHÔNG hardcode mapping dữ liệu ở đây: giá trị được Data Resolver fill qua <<...>>.
 * Token phải là literal `<<...>>` (KHÔNG HTML-escape) để renderer thay thế được;
 * renderer tự escape giá trị trước khi fill (chống XSS).
 */

import type { HtmlTemplate } from "../../lib/document-merge/html-renderer.ts";
import { GOOGLE_DOC_ID } from "./schema.ts";

const html = `
<div class="page">
  <table class="doc-header">
    <tr>
      <td class="brand">DALAT HASFARM</td>
      <td class="doc-title">GIẤY ĐĂNG KÝ TẬP NGHỀ</td>
    </tr>
  </table>

  <p>Kính gửi: <b>CÔNG TY TNHH DALAT HASFARM</b></p>

  <p><b>I/ THÔNG TIN CÁ NHÂN</b></p>
  <p>Họ và Tên: <<Ho_ten>>&nbsp;&nbsp;&nbsp;&nbsp;Sinh ngày: <<Ngay_sinh>></p>
  <p>Địa chỉ thường trú: <<Dia_chi_thuong_tru>></p>
  <p>Địa chỉ tạm trú: <<Dia_chi_tam_tru>></p>
  <p>Điện thoại liên lạc: <<So_dien_thoai>></p>
  <p>Số CCCD: <<So_CCCD>>&nbsp;&nbsp;&nbsp;&nbsp;Ngày cấp: <<Ngay_cap_CCCD>>&nbsp;&nbsp;Nơi cấp: Cục CSQLHC về TTXH <<Noi_cap_CCCD>></p>
  <p>CCCD: Đính kèm bản photo CCCD (không cần công chứng)</p>

  <p>Đã có tiền án, tiền sự trước đây:
    <span class="chk"><<Tien_an_tien_su_Khong>></span> Không&nbsp;&nbsp;&nbsp;&nbsp;
    <span class="chk"><<Tien_an_tien_su_Co>></span> Có
  </p>
  <p>Đã từng tập nghề/ làm việc cho Cty Dalat Hasfarm:
    <span class="chk"><<Da_tung_lam_DHF_Khong>></span> Không&nbsp;&nbsp;&nbsp;&nbsp;
    <span class="chk"><<Da_tung_lam_DHF_Co>></span> Có
  </p>

  <p>Vị trí tập nghề/ làm việc trước đây:</p>
  <p>
    <span class="chk"><<Loai_cong_viec_Nhan_vien>></span> Nhân viên&nbsp;&nbsp;&nbsp;&nbsp;
    <span class="chk"><<Loai_cong_viec_Cong_nhan>></span> Công nhân&nbsp;&nbsp;&nbsp;&nbsp;
    <span class="chk"><<Loai_cong_viec_Lao_dong_tap_nghe>></span> Lao động tập nghề
  </p>

  <p>Khu vực làm việc:
    <span class="chk"><<Khu_vuc_Da_Lat>></span> Đà lạt&nbsp;&nbsp;
    <span class="chk"><<Khu_vuc_Da_Quy>></span> Đa Quý&nbsp;&nbsp;
    <span class="chk"><<Khu_vuc_Da_Ron>></span> Đạ Ròn&nbsp;&nbsp;
    <span class="chk"><<Khu_vuc_Lam_Ha>></span> Lâm Hà&nbsp;&nbsp;
    <span class="chk"><<Khu_vuc_Khac>></span> Khu vực khác
  </p>

  <p>Công việc hiện tại:
    <span class="chk"><<Cong_viec_hien_tai_Sinh_vien>></span> Sinh viên trường <<Ten_truong>>&nbsp;&nbsp;&nbsp;&nbsp;
    <span class="chk"><<Cong_viec_hien_tai_Khac>></span> Khác <<Cong_viec_hien_tai_khac>>
  </p>

  <p>Tài khoản ngân hàng (chính chủ):
    <span class="chk"><<TKNH_Da_co>></span> Đã có&nbsp;&nbsp;&nbsp;&nbsp;
    <span class="chk"><<TKNH_Chua_co>></span> Chưa có
  </p>
  <p>Số tài khoản: <<So_tai_khoan>>&nbsp;&nbsp;&nbsp;&nbsp;Tên ngân hàng: <<Ten_ngan_hang>></p>

  <p>Thu nhập trong năm <<Nam_thue>></p>
  <p><span class="chk"><<Thu_nhap_Chi_DHF>></span> Chỉ phát sinh tại Công ty TNHH Dalat Hasfarm</p>
  <p><span class="chk"><<Thu_nhap_Ngoai_DHF>></span> Phát sinh tại Công ty/ Đơn vị khác ngoài Công ty TNHH Dalat Hasfarm. Cụ thể:</p>
  <p>Tên Công ty/ Đơn vị: <<Cong_ty_thu_nhap_khac>></p>
  <p>Tại: <<Dia_diem_thu_nhap_khac>></p>

  <p><b>II/ THÔNG TIN TẬP NGHỀ:</b> Xin đăng ký được vào tập nghề sau đây tại Công ty:</p>
  <p>
    <span class="chk"><<Tap_nghe_Trong_cham_soc_thu_hoach>></span> Trồng, chăm sóc, thu hoạch&nbsp;&nbsp;&nbsp;&nbsp;
    <span class="chk"><<Tap_nghe_Ban_hang>></span> Bán hàng
  </p>
  <p>
    <span class="chk"><<Tap_nghe_Dong_goi>></span> Đóng gói&nbsp;&nbsp;&nbsp;&nbsp;
    <span class="chk"><<Tap_nghe_Khac>></span> Khác <<Cong_viec_khac>>
  </p>
  <p>Thời gian đăng ký tập nghề: từ ngày <<Ngay_nhan_viec>></p>

  <p><b>III/ CAM KẾT CỦA NGƯỜI LÀM ĐƠN</b></p>
  <p>Tôi xin cam kết sẽ chấp hành tốt mọi nội quy, chính sách và quy định Tập Nghề cụ thể của Công ty trong suốt thời gian tập nghề. Nếu tôi có bất cứ hành vi sai phạm nào làm ảnh hưởng đến tài sản, uy tín, hoặc trật tự kỷ luật chung của Công ty, Công ty có quyền chấm dứt ngay thời gian tập nghề với tôi và xử lý sai phạm, yêu cầu tôi bồi thường thiệt hại (nếu có).</p>
  <p>Mọi thông tin tôi cung cấp bên trên là đúng sự thật, nếu có sai sót tôi xin hoàn toàn chịu trách nhiệm theo quy định của pháp luật hiện hành.</p>
  <p>Giấy đăng ký này thay cho thỏa thuận tập nghề giữa tôi và Công ty.</p>

  <table class="no-border sig-block">
    <tr>
      <td>Người làm đơn ký:</td>
      <td>Họ tên: <<Ho_ten>></td>
    </tr>
    <tr>
      <td>Ngày đăng ký: <<Ngay_nhan_viec>></td>
      <td></td>
    </tr>
  </table>

  <p><b>GHI NHẬN CỦA PHÒNG NHÂN SỰ:</b></p>
  <p>Đồng ý tiếp nhận anh/chị theo giấy đăng ký vào tập nghề tại Công ty</p>
  <p>Người tiếp nhận: <<Nguoi_tiep_nhan>>&nbsp;&nbsp;&nbsp;&nbsp;Ngày: <<Ngay_tiep_nhan>></p>
</div>

<div class="page">
  <table class="doc-header">
    <tr>
      <td class="brand">DALAT HASFARM</td>
      <td class="doc-title">QUY ĐỊNH VỀ TẬP NGHỀ</td>
    </tr>
  </table>

  <p>- Căn cứ Điều 61 của Bộ luật Lao động 2019 về Tập nghề;</p>
  <p>- Căn cứ nhu cầu tuyển dụng của Công ty;</p>
  <p>- Căn cứ nhu cầu tập nghề và xin việc của người tập nghề.</p>
  <p>Nay, Công ty quy định các điều khoản liên quan đến Tập nghề cụ thể như sau:</p>

  <p><b>1. GIẢI THÍCH TỪ NGỮ:</b></p>
  <p>Tập nghề nghĩa là được hướng dẫn thực hành công việc, tập làm nghề theo vị trí việc làm tại công ty.</p>

  <p><b>2. CÔNG VIỆC ĐƯỢC HƯỚNG DẪN TẬP LÀM VÀ THỰC HÀNH:</b></p>
  <p>Trồng, chăm sóc, thu hoạch, đóng gói, bán hoa/ ngọn giống/ rau</p>

  <p><b>3. ĐỊA ĐIỂM TẬP NGHỀ:</b></p>
  <p>Các khu vực sản xuất, kinh doanh của Công ty: do Quản lý bộ phận &amp; Phòng Nhân sự sắp xếp cụ thể</p>

  <p><b>4. THỜI HẠN TẬP NGHỀ:</b></p>
  <p>Thời hạn tập nghề là 03 tháng kể từ ngày nhận đơn đăng ký tập nghề. Thời gian tập nghề có thể kết thúc sớm hơn, hoặc kéo dài hơn tùy vào nhu cầu và khả năng đáp ứng của 2 bên. Trong hoặc sau thời gian tập nghề, người tập nghề có thể xin ứng tuyển vào những vị trí tuyển dụng phù hợp tại Công ty (nếu có).</p>

  <p><b>5. TRỢ CẤP TẬP NGHỀ VÀ THỜI GIAN CHI TRẢ:</b></p>
  <p>Trợ cấp tập nghề:</p>
  <p>Mức trợ cấp tập nghề sẽ được thông báo cụ thể cho người tập nghề ngay ngày đầu tiên tiếp nhận vào tập nghề.</p>
  <p>Trợ cấp tập nghề có thể thay đổi tùy thời điểm, khu vực và nhóm công việc tham gia tập nghề. Mọi thay đổi liên quan đến phần trợ cấp này sẽ được thông báo rộng rãi, kịp thời đến người tập nghề.</p>
  <p>Tiền trợ cấp hàng ngày này được tính theo thời gian tập nghề và thực hành thực tế của người tập nghề</p>
  <p>Thời gian chi trả:</p>
  <p>Đối với tập nghề tại các bộ phận thuộc các khu vực sản xuất của Công ty: Thời gian làm việc được chốt và chi trả 02 lần/ 01 tháng, cụ thể:</p>
  <p>Đợt 1: công từ ngày 01 đến ngày 15 được tính gộp và chi trả trong khoản thời gian từ ngày 25 đến ngày 28 của tháng.</p>
  <p>Đợt 2: công từ ngày 16 đến ngày cuối tháng được tính gộp và chi trả trong khoản thời gian từ ngày 12 đến ngày 15 của tháng tiếp theo.</p>
  <p>Đối với tập nghề tại Khu vực Kinh doanh: công được tính theo kỳ từ 21 tháng trước đến 20 tháng sau và chi vào ngày cuối cùng của tháng.</p>
  <p>Nếu thời gian chi trả thay đổi do thực tế hoạt động, Công ty sẽ thông báo cụ thể đến người tập nghề.</p>

  <p><b>6. BẢO HIỂM XÃ HỘI, BẢO HIỂM Y TẾ, BẢO HIỂM THẤT NGHIỆP:</b></p>
  <p>Bảo hiểm Xã hội, Bảo hiểm Y tế, Bảo hiểm Thất nghiệp sẽ không áp dụng đối với người tập nghề theo qui định của pháp luật Việt Nam hiện hành.</p>

  <p><b>7. QUY ĐỊNH KHI TẬP NGHỀ TẠI CÔNG TY:</b></p>
  <p class="rule-item">a. Thời gian làm việc và nghỉ ngơi: Theo quy định chung của bộ phận/ khu vực, và theo yêu cầu/ nhu cầu thực tế; được quản lý bộ phận &amp; phòng nhân sự thông báo cụ thể vào ngày đầu tiên tham gia tập nghề.</p>
  <p class="rule-item">b. Phải đăng ký tập nghề và được phòng Nhân sự đồng ý tiếp nhận, sắp xếp. Không tự ý vào tập nghề tại các bộ phận của Công ty.</p>
  <p class="rule-item">c. Phải bấm vân tay đầy đủ theo quy định của Công ty. Vân tay và xác nhận của quản lý trực tiếp là căn cứ để tính trợ cấp cho người tập nghề.</p>
  <p class="rule-item">d. Phải có thẻ ngân hàng ATM hoặc làm hồ sơ đăng ký làm thẻ ATM ngay khi vào đăng ký tập nghề.</p>
  <p class="rule-item">e. Phải đăng ký đầy đủ danh sách và thông tin cá nhân cơ bản theo biểu mẫu quy định trước khi vào tập nghề tại Công ty. Bổ sung đầy đủ 02 hình 3x4cm và 02 bản sao CCCD (không công chứng) theo quy định. Hiểu rõ các yêu cầu cũng như trách nhiệm khi vào Công ty tập nghề. Trong thời gian tập nghề, người tập nghề phải tuân thủ sự sắp xếp, điều phối của tổ trưởng và quản đốc bộ phận.</p>
  <p class="rule-item">f. Trang phục (theo yêu cầu cụ thể của công việc tại từng bộ phận, khu vực):</p>
  <p class="rule-item">Quần áo: quần áo phù hợp, phải mặc áo đồng phục do Công ty cấp.</p>
  <p class="rule-item">Giày: phải mang giày bata, giày thể thao hoặc ủng.</p>
  <p class="rule-item">g. Không được tự ý rời khỏi khu vực đã đăng ký tập nghề ban đầu, ngoại trừ có thông báo khác.</p>
  <p class="rule-item">h. Đậu đỗ xe đúng nơi quy định.</p>
  <p class="rule-item">i. Không được gây lộn, đánh nhau hoặc không được có bất cứ hành vi, cử chỉ khiếm nhã, thiếu văn hóa khi đang ở trong khu vực Công ty.</p>
  <p class="rule-item">j. Không được uống hoặc có mùi rượu bia khi làm việc.</p>
  <p class="rule-item">k. Hút thuốc và bỏ rác đúng nơi quy định. Hành vi hút thuốc và bỏ rác sai nơi quy định sẽ bị phạt theo chính sách chung của Công ty.</p>
  <p class="rule-item">l. Không được đem hoặc sử dụng các chất kích thích trong khu vực Công ty.</p>
  <p class="rule-item">m. Có trách nhiệm bảo quản các công cụ, tài sản của Công ty. Không được mang các vật dụng, tài sản của Công ty ra khỏi khu vực làm việc.</p>
  <p class="rule-item">n. Phải tự trang bị đầy đủ bảo hộ lao động khi vào làm việc tại Công ty theo đúng công việc đảm nhiệm, đảm bảo tuân thủ các quy định về an toàn khi làm việc.</p>

  <p><b>8. TRÁCH NHIỆM KHI VI PHẠM:</b></p>
  <p>Nếu hành vi vi phạm ở mức làm ảnh hưởng đến trật tự, an toàn tại nơi làm việc thì người vi phạm sẽ không được tiếp tục vào Công ty tập nghề, trường hợp đặc biệt sẽ được xem xét cụ thể.</p>
  <p>Nếu hành vi vi phạm ở mức làm hư hỏng, mất mát hoặc có bất cứ hành vi nào làm thiệt hại đến tài sản, uy tín của Công ty thì người vi phạm không được phép tiếp tục vào Công ty làm việc, và phải bồi thường toàn bộ thiệt hại đã gây ra.</p>

  <p><b>9. CHẤM DỨT VIỆC TẬP NGHỀ:</b></p>
  <p>Trong quá trình tập nghề, nếu xét thấy việc tập nghề không đạt kết quả mong đợi, Công ty và người tập nghề có quyền đơn phương chấp dứt thỏa thuận tập nghề, và thông báo (bằng lời nói, hoặc bằng văn bản) cho nhau biết trước 01 ngày.</p>

  <p><b>10. CAM KẾT:</b></p>
  <p>Đối tượng đăng ký tham gia tập nghề tại Công ty đều được giới thiệu rõ về những điều khoản trong quy định tập nghề để đảm bảo hiểu rõ và tiến hành áp dụng cho phù hợp.</p>

  <div class="right sig-block">
    <p>Người đăng ký tham gia tập nghề</p>
    <p>ký tên xác nhận hiểu rõ các khoản nêu trên</p>
    <p>và cam kết tuân thủ nghiêm túc</p>
    <p style="margin-top:24pt"><<Ho_ten>></p>
  </div>
</div>

<div class="page">
  <div class="center">
    <p><b>CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM</b></p>
    <p class="underline">Độc lập - Tự do - Hạnh phúc</p>
  </div>

  <h1 class="center">BẢN CAM KẾT</h1>
  <p class="center italic">(Áp dụng khi cá nhân nhận thu nhập và ước tính tổng thu nhập trong năm dương lịch chưa đến mức chịu thuế TNCN)</p>

  <p>Kính gửi: (Tên tổ chức, cá nhân trả thu thập)………………………………………..</p>
  <p>1. Tên tôi là: <<Ho_ten>></p>

  <table class="mst-grid no-outer">
    <tr>
      <td class="mst-label">2.Mã số thuế:</td>
      <td class="mst-cell"></td>
      <td class="mst-cell"></td>
      <td class="mst-cell"></td>
      <td class="mst-cell"></td>
      <td class="mst-cell"></td>
      <td class="mst-cell"></td>
      <td class="mst-cell"></td>
      <td class="mst-cell"></td>
      <td class="mst-cell"></td>
      <td class="mst-cell"></td>
      <td class="mst-cell"></td>
      <td class="mst-cell"></td>
      <td class="mst-cell"></td>
    </tr>
  </table>

  <p>3. Địa chỉ cư trú:<<dia_chi_cu_tru>></p>
  <p>Tôi cam kết rằng, năm <<Nam_thue>> tôi có tổng thu nhập từ tiền lương, tiền công thuộc diện phải khấu trừ thuế theo tỷ lệ 10%, nhưng theo ước tính tổng thu nhập trong năm của tôi không quá 186 (*) triệu đồng (ghi bằng chữ: Một trăm tám mươi sáu triệu đồng) chưa đến mức phải nộp thuế TNCN. Vì vậy, tôi đề nghị Công ty TNHH Dalat Hasfarm căn cứ vào bản cam kết này để không khấu trừ thuế TNCN khi trả thu nhập cho tôi.</p>
  <p>Tôi chịu trách nhiệm trước pháp luật về những số liệu đã khai./.</p>

  <div class="right sig-block">
    <p><<Dia_diem_ky>>, ngày <<Ngay_ky_day>> tháng <<Ngay_ky_month>> năm <<Ngay_ky_year>></p>
    <p><b>CÁ NHÂN CAM KẾT</b></p>
    <p class="italic">(Ký, ghi rõ họ tên)</p>
    <p style="margin-top:24pt"><<Ho_ten>></p>
  </div>
</div>

<div class="page">
  <div class="center">
    <p><b>CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM</b></p>
    <p class="underline">Độc lập – Tự do – Hạnh phúc</p>
    <p>-----ooo0ooo-----</p>
  </div>

  <h1 class="center">GIẤY ỦY QUYỀN</h1>
  <p class="center italic">(Đăng ký mã số thuế thu nhập cá nhân)</p>

  <p><b>BÊN UỶ QUYỀN (BÊN A):</b></p>
  <p>Tên người ủy quyền: <<Ho_ten>>&nbsp;&nbsp;Code: <<Code>></p>
  <p>Ngày sinh:<<Ngay_sinh>>&nbsp;&nbsp;Chứng minh nhân dân/ CCCD số: <<So_CCCD>></p>
  <p>Do Công an: Cục CSQLHC về TTXH&nbsp;&nbsp;&nbsp;&nbsp;Cấp ngày: <<Ngay_cap_CCCD>></p>
  <p>Địa chỉ đăng ký theo hộ khẩu: <<Dia_chi_thuong_tru>></p>
  <p>Địa chỉ cư trú: <<Dia_chi_tam_tru>></p>
  <p>Nơi làm việc hiện nay: Công ty TNHH Dalat Hasfarm</p>

  <p><b>BÊN NHẬN UỶ QUYỀN (BÊN B):</b></p>
  <p>Tên đơn vị: Công ty TNHH Dalat Hasfarm</p>
  <p>Mã số thuế: 5800000167</p>
  <p>Địa chỉ trụ sở chính:</p>
  <p>450 Nguyên Tử Lực, Phường 08, Tp Đà Lạt, Tỉnh Lâm Đồng</p>
  <p>Đại diện pháp luật:&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;Chức vụ:</p>

  <p><b>ĐIỀU 1: NỘI DUNG VÀ PHẠM VI ỦY QUYỀN</b></p>
  <p>Bên A ủy quyền cho bên B thực hiện các công việc sau đây:</p>
  <p>Làm việc với Cục Thuế tỉnh Lâm Đồng để làm thủ tục đăng ký mã số thuế thu nhập cá nhân cho (Tên người ủy quyền) <<Ho_ten>>theo quy định về đăng ký thuế.</p>

  <p><b>ĐIỀU 2: THỜI HẠN ỦY QUYỀN</b></p>
  <p>10 ngày kể từ ngày ký.</p>

  <p><b>ĐIỀU 3: NGHĨA VỤ CỦA CÁC BÊN</b></p>
  <p>Bên A và bên B chịu trách nhiệm trước pháp luật về những lời cam đoan sau đây:</p>
  <p>1. Bên A chịu trách nhiệm cho Bên B thực hiện trong phạm vi được ủy quyền.</p>
  <p>2. Bên B thực hiện công việc được ủy quyền phải báo cho Bên A về việc thực hiện công việc nêu trên.</p>
  <p>3. Việc giao kết Giấy uỷ quyền này hoàn toàn tự nguyện, không bị lừa dối hoặc ép buộc</p>
  <p>4. Thực hiện đúng và đầy đủ tất cả các thỏa thuận đã ghi trong Giấy ủy quyền này.</p>

  <p><b>ĐIỀU 4: ĐIỀU KHOẢN CUỐI CÙNG</b></p>
  <p>1. Hai bên công nhận đã hiểu rõ quyền, nghĩa vụ và lợi ích hợp pháp của mình, ý nghĩa và hậu quả pháp lý của việc giao kết Giấy ủy quyền này.</p>
  <p>2. Hai bên đã tự đọc Giấy ủy quyền, đã hiểu và đồng ý tất cả các điều khoản ghi trong Giấy và ký vào Giấy ủy quyền này.</p>
  <p>3. Giấy uỷ quyền này có hiệu lực từ ngày hai bên ký.</p>

  <p class="right">Đà Lạt, ngày <<Ngay_ky_day>> tháng <<Ngay_ky_month>> năm <<Ngay_ky_year>></p>
  <table class="sig-3col">
    <tr>
      <td>BÊN UỶ QUYỀN<br/>(ký, ghi rõ họ tên)</td>
      <td>PHÒNG NHÂN SỰ<br/>(ký, ghi rõ họ tên)</td>
      <td>ĐẠI DIỆN HỢP PHÁP<br/>(ký, đóng dấu, ghi rõ họ tên)</td>
    </tr>
    <tr>
      <td class="sig-name"><<Ho_ten>></td>
      <td></td>
      <td></td>
    </tr>
  </table>
</div>

<div class="page">
  <table class="no-border">
    <tr>
      <td></td>
      <td class="mau-so">
        Mẫu số:05-ĐKT<br/>
        (Kèm theo Thông tư số 90/2026/TT-BTC<br/>
        ngày 30 tháng 6 năm 2026<br/>
        của Bộ trưởng Bộ Tài chính)
      </td>
    </tr>
  </table>

  <div class="center">
    <p><b>CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM</b></p>
    <p class="underline">Độc lập - Tự do - Hạnh phúc</p>
  </div>

  <h1 class="center">TỜ KHAI ĐĂNG KÝ THUẾ</h1>
  <p class="center italic">(Dùng cho người nộp thuế là cá nhân không kinh doanh trực tiếp đăng ký thuế)</p>

  <p>1. Họ và tên người đăng ký thuế: <<Ho_ten>>&nbsp;&nbsp;&nbsp;&nbsp;Code: <<Code>></p>
  <p>2. Thông tin tổ chức, cá nhân cung cấp dịch vụ làm thủ tục về thuế (nếu có):</p>
  <p>2a. Tên: Công ty TNHH DALAT HASFARM</p>
  <p>2b. Mã số thuế: 5800000167</p>
  <p>2c. Hợp đồng dịch vụ làm thủ tục về thuế: Số: ………….. Ngày: …………………………….</p>

  <p>3. Thông tin đăng ký thuế của cá nhân:</p>
  <p>Trường hợp cá nhân đăng ký thuế là người có quốc tịch Việt Nam có thông tin trong Cơ sở dữ liệu quốc gia về dân cư:</p>
  <p>3.1. Ngày, tháng, năm sinh: <<Ngay_sinh>></p>
  <p>3.2. Số định danh cá nhân:<<So_CCCD>></p>
  <p>3.3. Điện thoại liên hệ: <<So_dien_thoai>></p>
  <p>3.4. Email: <<Email>></p>
  <p>3.5. Số định danh cá nhân đã cấp trước đó (trong trường hợp cá nhân được xác lập lại số định danh cá nhân): <<So_dinh_danh_cu>></p>

  <p>Trường hợp cá nhân là người có quốc tịch nước ngoài hoặc là người có quốc tịch Việt Nam đang sống tại nước ngoài không có số định danh cá nhân:</p>
  <p>3.1. Ngày, tháng, năm sinh: …./….. / …………………………………………………..</p>
  <p>3.2. Giới tính: □ Nam&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;□ Nữ</p>
  <p>3.3. Quốc tịch: …………………………………………………………………………….</p>
  <p>3.4. Số hộ chiếu:…………… Ngày cấp:.../.../…. Nơi cấp ……………………………</p>
  <p>3.5. Địa chỉ thường trú:</p>
  <p>Số nhà, ngách, hẻm, ngõ, đường/phố, tổ/xóm/ấp/thôn: ……………………………..</p>
  <p>Xã/Phường/Đặc khu: …………………………………………………………………….</p>
  <p>Tỉnh/Thành phố trực thuộc trung ương: ……………………………………………….</p>
  <p>3.6. Địa chỉ hiện tại:</p>
  <p>Số nhà, ngách, hẻm, ngõ, đường/phố, tổ/xóm/ấp/thôn: ……………………………..</p>
  <p>Tỉnh/Thành phố trực thuộc trung ương: ……………………………………………….</p>
  <p>3.7. Điện thoại liên hệ: …………………………………………………………………..</p>
  <p>3.8. Email: …………………………………………………………………………………</p>

  <p>Tôi cam kết những nội dung kê khai là đúng và chịu trách nhiệm trước pháp luật về những nội dung đã khai./.</p>

  <div class="right sig-block">
    <p><<Dia_diem_ky>>, ngày <<Ngay_ky_day>> tháng <<Ngay_ky_month>> năm <<Ngay_ky_year>></p>
    <p><b>NGƯỜI ĐĂNG KÝ THUẾ</b></p>
    <p class="italic">(Ký, ghi rõ họ tên, xác nhận điện tử)</p>
    <p style="margin-top:24pt"><<Ho_ten>></p>
  </div>
</div>
`;

const css = `
.page p { text-align: justify; }
table.no-border td { border: none; padding: 1pt 0; }
table.doc-header { margin: 0 0 10pt; }
table.doc-header td { vertical-align: middle; padding: 8pt 10pt; }
table.doc-header .brand {
  width: 32%;
  font-weight: 700;
  letter-spacing: 0.04em;
  font-size: 11pt;
}
table.doc-header .doc-title {
  font-weight: 700;
  text-align: center;
  font-size: 14pt;
}
.rule-item { margin-left: 12pt; }
table.mst-grid { width: auto; border-collapse: collapse; margin: 4pt 0 8pt; }
table.mst-grid .mst-label { border: none; padding: 2pt 6pt 2pt 0; white-space: nowrap; }
table.mst-grid .mst-cell {
  width: 14pt;
  height: 16pt;
  border: 1px solid #000;
  padding: 0;
}
table.sig-3col { margin-top: 8pt; }
table.sig-3col td {
  border: none;
  text-align: center;
  width: 33%;
  vertical-align: top;
}
table.sig-3col td.sig-name { padding-top: 28pt; }
.mau-so { text-align: right; font-size: 10pt; width: 55%; }
`;

export const dangKyTapNgheTemplate: HtmlTemplate = {
  key: "dang-ky-tap-nghe",
  name: "Giấy đăng ký tập nghề + Quy định + Hồ sơ thuế",
  googleDocIds: [GOOGLE_DOC_ID],
  html,
  css,
};
