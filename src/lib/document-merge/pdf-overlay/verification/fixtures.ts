/**
 * PDF Overlay Verification — deterministic fixtures (PR4).
 *
 * Tạo các bộ dữ liệu kiểm thử XÁC ĐỊNH (deterministic) cho visual verification
 * và benchmark. KHÔNG dùng dữ liệu Production/PII thật.
 *
 * Coverage (15 cases):
 *   1. Vietnamese full name with diacritics
 *   2. Long Vietnamese address
 *   3. DD/MM/YYYY dates
 *   4. Vietnamese currency/number formatting
 *   5. Multi-line text
 *   6. Shrink-to-fit
 *   7. left / center / right alignment
 *   8. top / middle / bottom vertical alignment
 *   9. checkbox checked
 *  10. checkbox unchecked
 *  11. multi-position placeholder
 *  12. multi-page PDF
 *  13. required-field failure
 *  14. FIELD_OVERFLOW failure
 *  15. text near page boundaries
 */

import { PDFDocument } from "pdf-lib";

import { A4_HEIGHT_PT, A4_WIDTH_PT } from "../geometry.ts";
import type { PdfPositionSpec } from "../types.ts";
import type { VerificationFixture } from "./types.ts";

/** Tạo template PDF trắng với pageCount trang A4. */
export async function makeBlankTemplate(pageCount = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) {
    doc.addPage([A4_WIDTH_PT, A4_HEIGHT_PT]);
  }
  return doc.save({ useObjectStreams: true });
}

/** Fixture 1: Vietnamese full name with diacritics. */
export async function fixtureVietnameseName(): Promise<VerificationFixture> {
  const templatePdf = await makeBlankTemplate(1);
  const positions: PdfPositionSpec[] = [
    {
      placeholder: "Ho_ten",
      pageNumber: 1,
      x: 50,
      y: 750,
      width: 250,
      height: 20,
      type: "TEXT",
      fontSize: 12,
      align: "left",
      valign: "top",
    },
  ];
  const fieldValues = { Ho_ten: "Bùi Nguyễn Phương Vy" };
  return {
    id: "vietnamese-name",
    name: "Vietnamese full name with diacritics",
    description: "Kiểm tra glyph tiếng Việt đầy đủ (precomposed + combining).",
    templatePdf,
    positions,
    fieldValues,
    expectedPageCount: 1,
    tags: ["unicode", "vietnamese", "basic"],
  };
}

/** Fixture 2: Long Vietnamese address. */
export async function fixtureLongAddress(): Promise<VerificationFixture> {
  const templatePdf = await makeBlankTemplate(1);
  const positions: PdfPositionSpec[] = [
    {
      placeholder: "Dia_chi",
      pageNumber: 1,
      x: 50,
      y: 700,
      width: 300,
      height: 60,
      type: "MULTILINE_TEXT",
      fontSize: 10,
      multiline: true,
      align: "left",
      valign: "top",
    },
  ];
  const fieldValues = {
    Dia_chi: "Số 12, đường Trần Phú, phường 3, thành phố Đà Lạt, tỉnh Lâm Đồng, Việt Nam",
  };
  return {
    id: "long-address",
    name: "Long Vietnamese address",
    description: "Kiểm tra wrap text dài với địa chỉ nhiều dấu.",
    templatePdf,
    positions,
    fieldValues,
    expectedPageCount: 1,
    tags: ["multiline", "vietnamese", "wrap"],
  };
}

/** Fixture 3: DD/MM/YYYY dates. */
export async function fixtureDates(): Promise<VerificationFixture> {
  const templatePdf = await makeBlankTemplate(1);
  const positions: PdfPositionSpec[] = [
    {
      placeholder: "Ngay_sinh",
      pageNumber: 1,
      x: 50,
      y: 750,
      width: 120,
      height: 20,
      type: "DATE",
      fontSize: 10,
      align: "left",
    },
    {
      placeholder: "Ngay_cap",
      pageNumber: 1,
      x: 200,
      y: 750,
      width: 120,
      height: 20,
      type: "DATE",
      fontSize: 10,
      align: "left",
    },
  ];
  const fieldValues = { Ngay_sinh: "15/03/2001", Ngay_cap: "10/01/2022" };
  return {
    id: "dates",
    name: "DD/MM/YYYY dates",
    description: "Kiểm tra định dạng ngày tháng Việt Nam.",
    templatePdf,
    positions,
    fieldValues,
    expectedPageCount: 1,
    tags: ["date", "format"],
  };
}

/** Fixture 4: Vietnamese currency/number formatting. */
export async function fixtureCurrency(): Promise<VerificationFixture> {
  const templatePdf = await makeBlankTemplate(1);
  const positions: PdfPositionSpec[] = [
    {
      placeholder: "So_tien",
      pageNumber: 1,
      x: 50,
      y: 750,
      width: 200,
      height: 20,
      type: "NUMBER",
      fontSize: 10,
      align: "right",
    },
  ];
  const fieldValues = { So_tien: "1.234.567" };
  return {
    id: "currency",
    name: "Vietnamese currency/number formatting",
    description: "Kiểm tra định dạng số với dấu chấm phân cách hàng nghìn.",
    templatePdf,
    positions,
    fieldValues,
    expectedPageCount: 1,
    tags: ["number", "format"],
  };
}

/** Fixture 5: Multi-line text. */
export async function fixtureMultiline(): Promise<VerificationFixture> {
  const templatePdf = await makeBlankTemplate(1);
  const positions: PdfPositionSpec[] = [
    {
      placeholder: "Noi_dung",
      pageNumber: 1,
      x: 50,
      y: 650,
      width: 400,
      height: 100,
      type: "MULTILINE_TEXT",
      fontSize: 10,
      multiline: true,
      maxLines: 5,
      align: "left",
      valign: "top",
    },
  ];
  const fieldValues = {
    Noi_dung: "Dòng thứ nhất.\nDòng thứ hai dài hơn để kiểm tra wrap.\nDòng thứ ba.",
  };
  return {
    id: "multiline",
    name: "Multi-line text",
    description: "Kiểm tra xuống dòng và wrap trong multiline field.",
    templatePdf,
    positions,
    fieldValues,
    expectedPageCount: 1,
    tags: ["multiline", "wrap"],
  };
}

/** Fixture 6: Shrink-to-fit. */
export async function fixtureShrinkToFit(): Promise<VerificationFixture> {
  const templatePdf = await makeBlankTemplate(1);
  const positions: PdfPositionSpec[] = [
    {
      placeholder: "Ho_ten",
      pageNumber: 1,
      x: 50,
      y: 750,
      width: 120,
      height: 20,
      type: "TEXT",
      fontSize: 14,
      minFontSize: 8,
      align: "left",
    },
  ];
  const fieldValues = { Ho_ten: "Nguyễn Văn Trường Sơn" };
  return {
    id: "shrink-to-fit",
    name: "Shrink-to-fit",
    description: "Kiểm tra font tự thu nhỏ để vừa box.",
    templatePdf,
    positions,
    fieldValues,
    expectedPageCount: 1,
    tags: ["shrink", "fit"],
  };
}

/** Fixture 7: left / center / right alignment. */
export async function fixtureAlignment(): Promise<VerificationFixture> {
  const templatePdf = await makeBlankTemplate(1);
  const positions: PdfPositionSpec[] = [
    {
      placeholder: "Left",
      pageNumber: 1,
      x: 50,
      y: 750,
      width: 200,
      height: 20,
      type: "TEXT",
      fontSize: 10,
      align: "left",
    },
    {
      placeholder: "Center",
      pageNumber: 1,
      x: 50,
      y: 720,
      width: 200,
      height: 20,
      type: "TEXT",
      fontSize: 10,
      align: "center",
    },
    {
      placeholder: "Right",
      pageNumber: 1,
      x: 50,
      y: 690,
      width: 200,
      height: 20,
      type: "TEXT",
      fontSize: 10,
      align: "right",
    },
  ];
  const fieldValues = { Left: "Căn trái", Center: "Căn giữa", Right: "Căn phải" };
  return {
    id: "alignment",
    name: "left / center / right alignment",
    description: "Kiểm tra 3 chế độ căn ngang.",
    templatePdf,
    positions,
    fieldValues,
    expectedPageCount: 1,
    tags: ["alignment", "horizontal"],
  };
}

/** Fixture 8: top / middle / bottom vertical alignment. */
export async function fixtureVerticalAlignment(): Promise<VerificationFixture> {
  const templatePdf = await makeBlankTemplate(1);
  const positions: PdfPositionSpec[] = [
    {
      placeholder: "Top",
      pageNumber: 1,
      x: 50,
      y: 700,
      width: 150,
      height: 60,
      type: "TEXT",
      fontSize: 10,
      valign: "top",
    },
    {
      placeholder: "Middle",
      pageNumber: 1,
      x: 220,
      y: 700,
      width: 150,
      height: 60,
      type: "TEXT",
      fontSize: 10,
      valign: "middle",
    },
    {
      placeholder: "Bottom",
      pageNumber: 1,
      x: 390,
      y: 700,
      width: 150,
      height: 60,
      type: "TEXT",
      fontSize: 10,
      valign: "bottom",
    },
  ];
  const fieldValues = { Top: "Trên", Middle: "Giữa", Bottom: "Dưới" };
  return {
    id: "vertical-alignment",
    name: "top / middle / bottom vertical alignment",
    description: "Kiểm tra 3 chế độ căn dọc.",
    templatePdf,
    positions,
    fieldValues,
    expectedPageCount: 1,
    tags: ["alignment", "vertical"],
  };
}

/** Fixture 9: checkbox checked. */
export async function fixtureCheckboxChecked(): Promise<VerificationFixture> {
  const templatePdf = await makeBlankTemplate(1);
  const positions: PdfPositionSpec[] = [
    {
      placeholder: "Co",
      pageNumber: 1,
      x: 50,
      y: 750,
      width: 15,
      height: 15,
      type: "CHECKBOX",
      checkboxStyle: "SQUARE_X",
    },
  ];
  const fieldValues = { Co: "☒" };
  return {
    id: "checkbox-checked",
    name: "checkbox checked",
    description: "Kiểm tra checkbox được đánh dấu (vector mark).",
    templatePdf,
    positions,
    fieldValues,
    expectedPageCount: 1,
    tags: ["checkbox", "checked"],
  };
}

/** Fixture 10: checkbox unchecked. */
export async function fixtureCheckboxUnchecked(): Promise<VerificationFixture> {
  const templatePdf = await makeBlankTemplate(1);
  const positions: PdfPositionSpec[] = [
    {
      placeholder: "Khong",
      pageNumber: 1,
      x: 50,
      y: 750,
      width: 15,
      height: 15,
      type: "CHECKBOX",
      checkboxStyle: "SQUARE_X",
    },
  ];
  const fieldValues = { Khong: "" };
  return {
    id: "checkbox-unchecked",
    name: "checkbox unchecked",
    description: "Kiểm tra checkbox không đánh dấu (ô trống).",
    templatePdf,
    positions,
    fieldValues,
    expectedPageCount: 1,
    tags: ["checkbox", "unchecked"],
  };
}

/** Fixture 11: multi-position placeholder. */
export async function fixtureMultiPosition(): Promise<VerificationFixture> {
  const templatePdf = await makeBlankTemplate(1);
  const positions: PdfPositionSpec[] = [
    {
      placeholder: "Ho_ten",
      pageNumber: 1,
      x: 50,
      y: 750,
      width: 200,
      height: 20,
      type: "TEXT",
      fontSize: 10,
    },
    {
      placeholder: "Ho_ten",
      pageNumber: 1,
      x: 50,
      y: 700,
      width: 200,
      height: 20,
      type: "TEXT",
      fontSize: 10,
    },
  ];
  const fieldValues = { Ho_ten: "Nguyễn Văn An" };
  return {
    id: "multi-position",
    name: "multi-position placeholder",
    description: "Kiểm tra cùng 1 placeholder vẽ ở nhiều vị trí.",
    templatePdf,
    positions,
    fieldValues,
    expectedPageCount: 1,
    tags: ["multi-position"],
  };
}

/** Fixture 12: multi-page PDF. */
export async function fixtureMultiPage(): Promise<VerificationFixture> {
  const templatePdf = await makeBlankTemplate(3);
  const positions: PdfPositionSpec[] = [
    {
      placeholder: "Page1",
      pageNumber: 1,
      x: 50,
      y: 750,
      width: 200,
      height: 20,
      type: "TEXT",
      fontSize: 10,
    },
    {
      placeholder: "Page2",
      pageNumber: 2,
      x: 50,
      y: 750,
      width: 200,
      height: 20,
      type: "TEXT",
      fontSize: 10,
    },
    {
      placeholder: "Page3",
      pageNumber: 3,
      x: 50,
      y: 750,
      width: 200,
      height: 20,
      type: "TEXT",
      fontSize: 10,
    },
  ];
  const fieldValues = { Page1: "Trang 1", Page2: "Trang 2", Page3: "Trang 3" };
  return {
    id: "multi-page",
    name: "multi-page PDF",
    description: "Kiểm tra render trên nhiều trang.",
    templatePdf,
    positions,
    fieldValues,
    expectedPageCount: 3,
    tags: ["multi-page"],
  };
}

/** Fixture 13: required-field failure. */
export async function fixtureRequiredFieldFailure(): Promise<VerificationFixture> {
  const templatePdf = await makeBlankTemplate(1);
  const positions: PdfPositionSpec[] = [
    {
      placeholder: "Ho_ten",
      pageNumber: 1,
      x: 50,
      y: 750,
      width: 200,
      height: 20,
      type: "TEXT",
      fontSize: 10,
      isRequired: true,
    },
  ];
  const fieldValues = { Ho_ten: "" };
  return {
    id: "required-field-failure",
    name: "required-field failure",
    description: "Kiểm tra lỗi MISSING_REQUIRED_FIELD khi field bắt buộc rỗng.",
    templatePdf,
    positions,
    fieldValues,
    expectedPageCount: 1,
    expectedError: "MISSING_REQUIRED_FIELD",
    tags: ["error", "required"],
  };
}

/** Fixture 14: FIELD_OVERFLOW failure. */
export async function fixtureFieldOverflowFailure(): Promise<VerificationFixture> {
  const templatePdf = await makeBlankTemplate(1);
  const positions: PdfPositionSpec[] = [
    {
      placeholder: "Ho_ten",
      pageNumber: 1,
      x: 50,
      y: 750,
      width: 30,
      height: 20,
      type: "TEXT",
      fontSize: 10,
    },
  ];
  const fieldValues = { Ho_ten: "Một câu rất dài để chắc chắn tràn ra ngoài ô" };
  return {
    id: "field-overflow-failure",
    name: "FIELD_OVERFLOW failure",
    description: "Kiểm tra lỗi FIELD_OVERFLOW khi text không vừa box.",
    templatePdf,
    positions,
    fieldValues,
    expectedPageCount: 1,
    expectedError: "FIELD_OVERFLOW",
    tags: ["error", "overflow"],
  };
}

/** Fixture 15: text near page boundaries. */
export async function fixturePageBoundaries(): Promise<VerificationFixture> {
  const templatePdf = await makeBlankTemplate(1);
  const positions: PdfPositionSpec[] = [
    {
      placeholder: "TopLeft",
      pageNumber: 1,
      x: 10,
      y: A4_HEIGHT_PT - 30,
      width: 100,
      height: 20,
      type: "TEXT",
      fontSize: 10,
    },
    {
      placeholder: "BottomRight",
      pageNumber: 1,
      x: A4_WIDTH_PT - 110,
      y: 10,
      width: 100,
      height: 20,
      type: "TEXT",
      fontSize: 10,
    },
  ];
  const fieldValues = { TopLeft: "Góc trên trái", BottomRight: "Góc dưới phải" };
  return {
    id: "page-boundaries",
    name: "text near page boundaries",
    description: "Kiểm tra text ở gần mép trang.",
    templatePdf,
    positions,
    fieldValues,
    expectedPageCount: 1,
    tags: ["boundary", "edge"],
  };
}

/** Tạo tất cả 15 fixtures. */
export async function generateAllFixtures(): Promise<VerificationFixture[]> {
  return Promise.all([
    fixtureVietnameseName(),
    fixtureLongAddress(),
    fixtureDates(),
    fixtureCurrency(),
    fixtureMultiline(),
    fixtureShrinkToFit(),
    fixtureAlignment(),
    fixtureVerticalAlignment(),
    fixtureCheckboxChecked(),
    fixtureCheckboxUnchecked(),
    fixtureMultiPosition(),
    fixtureMultiPage(),
    fixtureRequiredFieldFailure(),
    fixtureFieldOverflowFailure(),
    fixturePageBoundaries(),
  ]);
}
