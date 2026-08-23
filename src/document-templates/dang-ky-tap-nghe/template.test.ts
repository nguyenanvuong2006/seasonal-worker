/**
 * Canonical HTML must match the 49 active Production mappings
 * and retain the verbatim 5-part golden source from Google Doc
 * 10D0tG71CbllIZe7DaosYNW3vK7QnP76Yq4UC9FMEiUE.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { extractUniquePlaceholders } from "../../lib/document-merge/placeholder-extractor.ts";
import { dangKyTapNgheTemplate } from "./template.ts";
import {
  CHECKBOX_PLACEHOLDERS,
  CONTRACT_PLACEHOLDERS,
  DANG_KY_TAP_NGHE_FIELD_CONTRACT,
  PLACEHOLDERS,
  REJECTED_ORPHAN_PLACEHOLDERS,
  REQUIRED_PLACEHOLDERS,
  SECTIONS,
} from "./schema.ts";
import { validateTemplateContract } from "../../lib/document-merge/template-contract.ts";

const html = dangKyTapNgheTemplate.html;

function sectionAfter(title: string): string {
  const start = html.indexOf(title);
  assert.ok(start >= 0, `missing section title: ${title}`);
  const nextTitles = SECTIONS.map((s) => s.title).filter((t) => t !== title);
  let end = html.length;
  for (const other of nextTitles) {
    const idx = html.indexOf(other, start + title.length);
    if (idx >= 0 && idx < end) end = idx;
  }
  return html.slice(start, end);
}

test("canonical dang-ky-tap-nghe HTML has exactly 49 unique active placeholders", () => {
  const found = extractUniquePlaceholders(html);
  assert.equal(PLACEHOLDERS.length, 49);
  assert.equal(found.length, 49);
  assert.deepEqual(found, [...PLACEHOLDERS].sort());
});

test("canonical semantic field contract exactly covers the HTML and declares required/checkbox semantics", () => {
  const result = validateTemplateContract(html, DANG_KY_TAP_NGHE_FIELD_CONTRACT);
  assert.equal(result.valid, true, JSON.stringify(result));
  assert.deepEqual(CONTRACT_PLACEHOLDERS, [...PLACEHOLDERS].sort());
  assert.deepEqual(REQUIRED_PLACEHOLDERS, [
    "Dia_chi_tam_tru",
    "Dia_chi_thuong_tru",
    "Ho_ten",
    "Ngay_nhan_viec",
    "Ngay_sinh",
    "So_CCCD",
    "So_dien_thoai",
  ]);
  assert.equal(CHECKBOX_PLACEHOLDERS.length, 22);
  assert.ok(CHECKBOX_PLACEHOLDERS.every((key) => (PLACEHOLDERS as readonly string[]).includes(key)));
});

test("canonical HTML has no extra placeholders beyond the 49 active set", () => {
  const found = extractUniquePlaceholders(html);
  for (const token of found) {
    assert.ok((PLACEHOLDERS as readonly string[]).includes(token), `extra placeholder ${token}`);
  }
});

test("canonical HTML excludes operator-accepted orphan tax-contract placeholders", () => {
  const found = extractUniquePlaceholders(html);
  for (const orphan of REJECTED_ORPHAN_PLACEHOLDERS) {
    assert.equal(found.includes(orphan), false, orphan);
    assert.doesNotMatch(html, new RegExp(`(?:<<\\s*${orphan}\\s*>>|\\{\\{\\s*${orphan}\\s*\\}\\})`));
  }
  assert.equal(REJECTED_ORPHAN_PLACEHOLDERS.length, 2);
  assert.deepEqual([...REJECTED_ORPHAN_PLACEHOLDERS], [
    "So_hop_dong_dich_vu_thue",
    "Ngay_hop_dong_dich_vu_thue",
  ]);
});

test("all 5 main golden-source sections exist in order", () => {
  assert.equal(SECTIONS.length, 5);
  let cursor = 0;
  for (const section of SECTIONS) {
    const idx = html.indexOf(section.title, cursor);
    assert.ok(idx >= 0, `missing section ${section.title}`);
    cursor = idx + section.title.length;
  }
});

test("QUY ĐỊNH VỀ TẬP NGHỀ contains all 10 numbered sections", () => {
  const quyDinh = sectionAfter("QUY ĐỊNH VỀ TẬP NGHỀ");
  const numbered = [
    "1. GIẢI THÍCH TỪ NGỮ",
    "2. CÔNG VIỆC ĐƯỢC HƯỚNG DẪN TẬP LÀM VÀ THỰC HÀNH",
    "3. ĐỊA ĐIỂM TẬP NGHỀ",
    "4. THỜI HẠN TẬP NGHỀ",
    "5. TRỢ CẤP TẬP NGHỀ VÀ THỜI GIAN CHI TRẢ",
    "6. BẢO HIỂM XÃ HỘI, BẢO HIỂM Y TẾ, BẢO HIỂM THẤT NGHIỆP",
    "7. QUY ĐỊNH KHI TẬP NGHỀ TẠI CÔNG TY",
    "8. TRÁCH NHIỆM KHI VI PHẠM",
    "9. CHẤM DỨT VIỆC TẬP NGHỀ",
    "10. CAM KẾT",
  ];
  let cursor = 0;
  for (const heading of numbered) {
    const idx = quyDinh.indexOf(heading, cursor);
    assert.ok(idx >= 0, `missing numbered section ${heading}`);
    cursor = idx + heading.length;
  }
});

test("nội quy a–n is retained in QUY ĐỊNH VỀ TẬP NGHỀ", () => {
  const quyDinh = sectionAfter("QUY ĐỊNH VỀ TẬP NGHỀ");
  const letters = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n"];
  let cursor = 0;
  for (const letter of letters) {
    const marker = `${letter}. `;
    const idx = quyDinh.indexOf(marker, cursor);
    assert.ok(idx >= 0, `missing nội quy item ${letter}`);
    cursor = idx + marker.length;
  }
  assert.match(quyDinh, /bấm vân tay/);
  assert.match(quyDinh, /thẻ ngân hàng ATM/);
  assert.match(quyDinh, /áo đồng phục/);
  assert.match(quyDinh, /bảo hộ lao động/);
});

test("BẢN CAM KẾT contains 186 triệu threshold", () => {
  const camKet = sectionAfter("BẢN CAM KẾT");
  assert.match(camKet, /không quá 186 \(\*\) triệu đồng/);
  assert.match(camKet, /Một trăm tám mươi sáu triệu đồng/);
  assert.match(camKet, /khấu trừ thuế theo tỷ lệ 10%/);
});

test("GIẤY ỦY QUYỀN contains Điều 1–4", () => {
  const uyQuyen = sectionAfter("GIẤY ỦY QUYỀN");
  const articles = [
    "ĐIỀU 1: NỘI DUNG VÀ PHẠM VI ỦY QUYỀN",
    "ĐIỀU 2: THỜI HẠN ỦY QUYỀN",
    "ĐIỀU 3: NGHĨA VỤ CỦA CÁC BÊN",
    "ĐIỀU 4: ĐIỀU KHOẢN CUỐI CÙNG",
  ];
  let cursor = 0;
  for (const article of articles) {
    const idx = uyQuyen.indexOf(article, cursor);
    assert.ok(idx >= 0, `missing ${article}`);
    cursor = idx + article.length;
  }
  assert.match(uyQuyen, /10 ngày kể từ ngày ký/);
});

test("TỜ KHAI contains Mẫu 05-ĐKT and MST 5800000167", () => {
  const toKhai = sectionAfter("TỜ KHAI ĐĂNG KÝ THUẾ");
  assert.match(html, /Mẫu số:05-ĐKT/);
  assert.match(toKhai, /5800000167/);
  assert.match(html, /Mã số thuế: 5800000167/);
});

test("Vietnamese Unicode is intact in titles and legal phrases", () => {
  assert.match(html, /GIẤY ĐĂNG KÝ TẬP NGHỀ/);
  assert.match(html, /QUY ĐỊNH VỀ TẬP NGHỀ/);
  assert.match(html, /BẢN CAM KẾT/);
  assert.match(html, /GIẤY ỦY QUYỀN/);
  assert.match(html, /TỜ KHAI ĐĂNG KÝ THUẾ/);
  assert.match(html, /CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM/);
  assert.match(html, /Độc lập/);
  assert.match(html, /Hạnh phúc/);
  assert.match(html, /Bộ luật Lao động/);
  assert.match(html, /thu nhập cá nhân/);
  assert.match(html, /đăng ký thuế/);
  assert.equal(html.includes("GIAY DANG KY"), false);
  assert.equal(/\p{Script=Latin}/u.test("ĐĂNG"), true);
});

test("tax service contract line exists as static text without orphan tokens", () => {
  assert.match(html, /Hợp đồng dịch vụ làm thủ tục về thuế:\s*Số:/);
  assert.match(html, /Hợp đồng dịch vụ làm thủ tục về thuế: Số: .+ Ngày:/);
  assert.doesNotMatch(html, /(?:<<|\{\{)So_hop_dong_dich_vu_thue/);
  assert.doesNotMatch(html, /(?:<<|\{\{)Ngay_hop_dong_dich_vu_thue/);
});

test("checkbox placeholders stay wrapped for semantic checkbox rendering", () => {
  assert.match(html, /<span class="chk">\{\{Tien_an_tien_su_Khong\}\}<\/span>/);
  assert.match(html, /<span class="chk">\{\{Tien_an_tien_su_Co\}\}<\/span>/);
  assert.match(html, /<span class="chk">\{\{Tap_nghe_Trong_cham_soc_thu_hoach\}\}<\/span>/);
  assert.match(html, /<span class="chk">\{\{Khu_vuc_Da_Lat\}\}<\/span>/);
});
