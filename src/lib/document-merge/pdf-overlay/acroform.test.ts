import test from "node:test";
import assert from "node:assert/strict";

import { PDFDocument } from "pdf-lib";

import {
  detectAcroForm,
  fillAcroForm,
  listAcroFormFields,
} from "./acroform.ts";
import { PdfOverlayError } from "./types.ts";
import { readEmbeddedFontBytes } from "./vietnamese-font.ts";

const fontBytes = readEmbeddedFontBytes();

/** Tạo fixture AcroForm tổng hợp (không cần PDF gốc thật): text + checkbox + radio. */
async function makeAcroFormFixture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  const form = doc.getForm();

  const hoTen = form.createTextField("Ho_ten");
  hoTen.addToPage(page, { x: 50, y: 700, width: 200, height: 20 });

  const diaChi = form.createTextField("Dia_chi");
  diaChi.addToPage(page, { x: 50, y: 650, width: 300, height: 20 });

  const daKetHon = form.createCheckBox("Da_ket_hon");
  daKetHon.addToPage(page, { x: 50, y: 600, width: 12, height: 12 });

  const gioiTinh = form.createRadioGroup("Gioi_tinh");
  gioiTinh.addOptionToPage("Nam", page, { x: 50, y: 560, width: 12, height: 12 });
  gioiTinh.addOptionToPage("Nu", page, { x: 100, y: 560, width: 12, height: 12 });

  return doc.save({ useObjectStreams: true });
}

/** PDF không có AcroForm nào (chỉ trang trắng). */
async function makeNonFormPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([595.28, 841.89]);
  return doc.save({ useObjectStreams: true });
}

test("detectAcroForm: fixture có field → hasFillableForm=true", async () => {
  const tpl = await makeAcroFormFixture();
  const result = await detectAcroForm(tpl);
  assert.equal(result.hasFillableForm, true);
  assert.equal(result.fieldCount, 4);
});

test("detectAcroForm: PDF không có AcroForm → hasFillableForm=false", async () => {
  const tpl = await makeNonFormPdf();
  const result = await detectAcroForm(tpl);
  assert.equal(result.hasFillableForm, false);
  assert.equal(result.fieldCount, 0);
});

test("listAcroFormFields: liệt kê đúng type + options", async () => {
  const tpl = await makeAcroFormFixture();
  const fields = await listAcroFormFields(tpl);
  const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
  assert.equal(byName.Ho_ten?.type, "TEXT");
  assert.equal(byName.Da_ket_hon?.type, "CHECKBOX");
  assert.equal(byName.Gioi_tinh?.type, "RADIO_GROUP");
  assert.deepEqual([...(byName.Gioi_tinh?.options ?? [])].sort(), ["Nam", "Nu"]);
});

test("fillAcroForm: fill text tiếng Việt + checkbox + radio", async () => {
  const tpl = await makeAcroFormFixture();
  const result = await fillAcroForm(
    tpl,
    { Ho_ten: "Nguyễn Thị Hồng", Dia_chi: "Đạ Ròn, Lâm Đồng", Da_ket_hon: true, Gioi_tinh: "Nu" },
    { fontBytes },
  );
  assert.ok(result.bytes.byteLength > 0);
  assert.equal(result.sha256.length, 64);
  assert.deepEqual(
    [...result.filledFields].sort(),
    ["Da_ket_hon", "Dia_chi", "Gioi_tinh", "Ho_ten"],
  );

  const reloaded = await PDFDocument.load(result.bytes);
  const form = reloaded.getForm();
  assert.equal(form.getTextField("Ho_ten").getText(), "Nguyễn Thị Hồng");
  assert.equal(form.getTextField("Dia_chi").getText(), "Đạ Ròn, Lâm Đồng");
  assert.equal(form.getCheckBox("Da_ket_hon").isChecked(), true);
  assert.equal(form.getRadioGroup("Gioi_tinh").getSelected(), "Nu");
});

test("fillAcroForm: giá trị 'false'/'0' string trên checkbox → uncheck (không ghi text)", async () => {
  const tpl = await makeAcroFormFixture();
  const result = await fillAcroForm(
    tpl,
    { Ho_ten: "Trần Văn Bình", Dia_chi: "Hà Nội", Da_ket_hon: "0", Gioi_tinh: "Nam" },
    { fontBytes },
  );
  const reloaded = await PDFDocument.load(result.bytes);
  assert.equal(reloaded.getForm().getCheckBox("Da_ket_hon").isChecked(), false);
});

test("fillAcroForm: field thiếu giá trị bị bỏ qua (không throw, không ghi undefined/null)", async () => {
  const tpl = await makeAcroFormFixture();
  const result = await fillAcroForm(tpl, { Ho_ten: "Đặng Đình Đạt" }, { fontBytes });
  assert.ok(result.skippedBlankFields.includes("Dia_chi"));
  assert.ok(result.skippedBlankFields.includes("Da_ket_hon"));
  assert.ok(result.skippedBlankFields.includes("Gioi_tinh"));

  const reloaded = await PDFDocument.load(result.bytes);
  const diaChi = reloaded.getForm().getTextField("Dia_chi").getText();
  assert.ok(diaChi === undefined || diaChi === "");
  assert.notEqual(diaChi, "undefined");
  assert.notEqual(diaChi, "null");
});

test("fillAcroForm: field required thiếu giá trị → MISSING_REQUIRED_FIELD xác định", async () => {
  const tpl = await makeAcroFormFixture();
  await assert.rejects(
    () => fillAcroForm(tpl, { Ho_ten: "Lê Thị Mai" }, { fontBytes, requiredFields: ["Dia_chi"] }),
    (err: unknown) => {
      assert.ok(err instanceof PdfOverlayError);
      assert.equal(err.code, "MISSING_REQUIRED_FIELD");
      return true;
    },
  );
});

test("fillAcroForm: option không tồn tại trong radio group → ACROFORM_FIELD_NOT_FOUND", async () => {
  const tpl = await makeAcroFormFixture();
  await assert.rejects(
    () => fillAcroForm(tpl, { Ho_ten: "Phạm Văn Cường", Gioi_tinh: "KhongXacDinh" }, { fontBytes }),
    (err: unknown) => {
      assert.ok(err instanceof PdfOverlayError);
      assert.equal(err.code, "ACROFORM_FIELD_NOT_FOUND");
      return true;
    },
  );
});

test("fillAcroForm: PDF không có AcroForm → ACROFORM_NOT_FOUND", async () => {
  const tpl = await makeNonFormPdf();
  await assert.rejects(
    () => fillAcroForm(tpl, { Ho_ten: "X" }, { fontBytes }),
    (err: unknown) => {
      assert.ok(err instanceof PdfOverlayError);
      assert.equal(err.code, "ACROFORM_NOT_FOUND");
      return true;
    },
  );
});

test("fillAcroForm: thiếu fontBytes → FONT_BYTES_REQUIRED", async () => {
  const tpl = await makeAcroFormFixture();
  await assert.rejects(
    () => fillAcroForm(tpl, { Ho_ten: "X" }, { fontBytes: new Uint8Array(0) }),
    (err: unknown) => {
      assert.ok(err instanceof PdfOverlayError);
      assert.equal(err.code, "FONT_BYTES_REQUIRED");
      return true;
    },
  );
});

test("fillAcroForm: flatten=true khoá field thành nội dung tĩnh", async () => {
  const tpl = await makeAcroFormFixture();
  const result = await fillAcroForm(
    tpl,
    { Ho_ten: "Nguyễn Văn A", Dia_chi: "TP. Hồ Chí Minh", Da_ket_hon: true, Gioi_tinh: "Nam" },
    { fontBytes, flatten: true },
  );
  const reloaded = await PDFDocument.load(result.bytes);
  assert.equal(reloaded.getForm().getFields().length, 0);
});

test("fillAcroForm: deterministic — cùng input → cùng SHA-256", async () => {
  const tpl = await makeAcroFormFixture();
  const values = { Ho_ten: "Vũ Thị Thu", Dia_chi: "Đà Lạt", Da_ket_hon: false, Gioi_tinh: "Nu" };
  const [r1, r2] = await Promise.all([
    fillAcroForm(tpl, values, { fontBytes }),
    fillAcroForm(tpl, values, { fontBytes }),
  ]);
  assert.equal(r1.sha256, r2.sha256);
});
