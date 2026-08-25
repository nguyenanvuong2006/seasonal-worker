/**
 * AI TEMPLATE FIXTURES (H1) — a safe, non-PII, representative "Đăng ký tập
 * nghề"-style A4 print template used by tests exercising placeholder
 * inventory + layout-risk warnings. Contains ZERO real candidate data —
 * every value is a placeholder token or static legal/label text.
 *
 * Deliberately includes BOTH:
 *   - a genuinely risky pattern (SAMPLE_TEMPLATE_HTML's "Địa chỉ tạm trú" row
 *     has a fixed-height cell around a dynamic placeholder) — proves the
 *     layout scanner actually fires on realistic markup, not just synthetic
 *     one-liners;
 *   - safe fixed-height regions with NO placeholder inside (photo box, blank
 *     signature space) — proves the scanner does NOT false-positive on them.
 */

export const SAMPLE_TEMPLATE_CSS = `
.page + .page { break-before: page; }
table { width: 100%; border-collapse: collapse; }
td, th { border: 1px solid #000; padding: 4px 6px; vertical-align: top; }
.label-col { width: 35mm; font-weight: bold; }
.photo-box { height: 120px; width: 90px; border: 1px solid #000; }
.signature-space { height: 60px; }
/* Deliberate risky pattern (kept for regression coverage — see README-AI.md
   for what an AI revision must fix): fixed height around dynamic address. */
.addr-cell-risky { height: 24px; overflow: hidden; white-space: nowrap; }
.signature-block { break-inside: avoid; }
`;

export const SAMPLE_TEMPLATE_HTML = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body>
<div class="page">
  <h1>CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM</h1>
  <h2>Độc lập - Tự do - Hạnh phúc</h2>
  <h3>ĐĂNG KÝ TẬP NGHỀ</h3>

  <table>
    <tr><td class="label-col">Họ và tên</td><td><<Ho_ten>></td></tr>
    <tr><td class="label-col">Số CCCD</td><td><<So_CCCD>></td></tr>
    <tr><td class="label-col">Ngày sinh</td><td><<Ngay_sinh>></td></tr>
    <tr><td class="label-col">Giới tính</td><td><<Gioi_tinh>></td></tr>
    <tr><td class="label-col">Số điện thoại</td><td><<So_dien_thoai>></td></tr>
    <tr>
      <td class="label-col">Địa chỉ thường trú</td>
      <td><<Dia_chi_thuong_tru>></td>
    </tr>
    <tr>
      <td class="label-col">Địa chỉ tạm trú</td>
      <td class="addr-cell-risky"><<Dia_chi_tam_tru>></td>
    </tr>
    <tr><td class="label-col">Bộ phận đăng ký</td><td><<Bo_phan>></td></tr>
    <tr><td class="label-col">Ngày đăng ký</td><td><<Ngay_dang_ky>></td></tr>
  </table>

  <table style="margin-top: 8mm;">
    <tr>
      <td style="width: 40mm;">Ảnh 3x4</td>
      <td><div class="photo-box"></div></td>
    </tr>
  </table>
</div>

<div class="page">
  <h3>CAM KẾT</h3>
  <p>
    Tôi xin cam kết tuân thủ nội quy, quy định của công ty trong suốt thời
    gian tập nghề, chấp hành đầy đủ các quy định về an toàn lao động và bảo
    mật thông tin.
  </p>

  <table>
    <tr><td class="label-col">Ngày cấp CCCD</td><td><<Ngay_cap_CCCD>></td></tr>
    <tr><td class="label-col">Nơi cấp CCCD</td><td><<Noi_cap_CCCD>></td></tr>
    <tr><td class="label-col">Địa điểm ký</td><td><<Dia_diem_ky>></td></tr>
  </table>

  <table style="margin-top: 12mm;">
    <tr>
      <td style="width: 50%;">
        <p>Người lao động</p>
        <div class="signature-block">
          <div class="signature-space">&nbsp;</div>
          <p><<Ho_ten>></p>
        </div>
      </td>
      <td style="width: 50%;">
        <p>Đại diện công ty</p>
        <div class="signature-block">
          <div class="signature-space">&nbsp;</div>
        </div>
      </td>
    </tr>
  </table>
</div>
</body>
</html>`;

/** Every placeholder key present in SAMPLE_TEMPLATE_HTML (for assertions). */
export const SAMPLE_TEMPLATE_PLACEHOLDERS = [
  "Bo_phan",
  "Dia_chi_tam_tru",
  "Dia_chi_thuong_tru",
  "Dia_diem_ky",
  "Gioi_tinh",
  "Ho_ten",
  "Ngay_cap_CCCD",
  "Ngay_dang_ky",
  "Ngay_sinh",
  "Noi_cap_CCCD",
  "So_CCCD",
  "So_dien_thoai",
] as const;
