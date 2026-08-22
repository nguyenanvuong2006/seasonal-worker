/**
 * PDF Overlay Engine — native AcroForm field filling (fillable-PDF path).
 *
 * Mission yêu cầu 2A: khi PDF gốc là fillable (có AcroForm), ƯU TIÊN fill
 * field gốc thay vì overlay toạ độ — chỉ dùng coordinate-overlay
 * (renderer.ts) khi PDF KHÔNG có AcroForm. Nguyên tắc giống renderer.ts:
 *
 *   - PDF gốc là nguồn sự thật — module này KHÔNG tái tạo trang/field, chỉ
 *     set giá trị lên field đã tồn tại + (tuỳ chọn) flatten.
 *   - Text field tiếng Việt bắt buộc nhúng font riêng (Standard-14 không có
 *     dấu) — dùng chung `embedVietnameseFont` với renderer.ts.
 *   - Checkbox/radio: set qua check()/uncheck()/select() của pdf-lib — KHÔNG
 *     bao giờ ghi chuỗi "true"/"false"/"1"/"0" vào field text. Radio group
 *     là cấu trúc AcroForm gốc nên loại trừ lẫn nhau tự nhiên (không thể
 *     chọn 2 option cùng lúc).
 *   - Field thiếu giá trị bị bỏ qua (không ghi "undefined"/"null"), trừ khi
 *     nằm trong `requiredFields` → throw MISSING_REQUIRED_FIELD xác định.
 */

import {
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
} from "pdf-lib";

import { sha256Hex } from "./renderer.ts";
import { PdfOverlayError } from "./types.ts";
import { embedVietnameseFont } from "./vietnamese-font.ts";

export type AcroFormFieldValue = string | boolean;

export interface AcroFormFieldInfo {
  name: string;
  type: "TEXT" | "CHECKBOX" | "RADIO_GROUP" | "DROPDOWN" | "OPTION_LIST" | "UNSUPPORTED";
  options?: string[];
}

export interface AcroFormFillOptions {
  /** Bắt buộc — text field tiếng Việt cần font nhúng riêng. */
  fontBytes: Uint8Array;
  subsetFont?: boolean;
  /** Flatten sau khi fill (khoá giá trị thành nội dung tĩnh, không sửa lại được). */
  flatten?: boolean;
  /** Field bắt buộc phải có giá trị non-blank — thiếu → MISSING_REQUIRED_FIELD. */
  requiredFields?: readonly string[];
}

export interface AcroFormFillResult {
  bytes: Uint8Array;
  sha256: string;
  pageCount: number;
  filledFields: string[];
  skippedBlankFields: string[];
  warnings: string[];
}

const CHECKED_TRUE_VALUES = new Set(["true", "1", "on", "yes", "có", "x"]);

/** Chuẩn hoá giá trị checkbox: boolean thật hoặc chuỗi phổ biến → checked?. */
function isCheckedValue(raw: AcroFormFieldValue): boolean {
  if (typeof raw === "boolean") return raw;
  return CHECKED_TRUE_VALUES.has(raw.trim().toLowerCase());
}

function fieldTypeOf(field: unknown): AcroFormFieldInfo["type"] {
  if (field instanceof PDFTextField) return "TEXT";
  if (field instanceof PDFCheckBox) return "CHECKBOX";
  if (field instanceof PDFRadioGroup) return "RADIO_GROUP";
  if (field instanceof PDFDropdown) return "DROPDOWN";
  if (field instanceof PDFOptionList) return "OPTION_LIST";
  return "UNSUPPORTED";
}

/**
 * Có AcroForm với ít nhất 1 field không — dùng để quyết định route
 * (native fill vs coordinate-overlay) khi đăng ký template mới.
 */
export async function detectAcroForm(
  templatePdf: Uint8Array,
): Promise<{ hasFillableForm: boolean; fieldCount: number }> {
  const pdfDoc = await PDFDocument.load(templatePdf, { updateMetadata: false });
  try {
    const form = pdfDoc.getForm();
    const fieldCount = form.getFields().length;
    return { hasFillableForm: fieldCount > 0, fieldCount };
  } catch {
    return { hasFillableForm: false, fieldCount: 0 };
  }
}

/** Liệt kê field + type + option (radio/dropdown/optionlist) — dùng cho mapping UI. */
export async function listAcroFormFields(templatePdf: Uint8Array): Promise<AcroFormFieldInfo[]> {
  const pdfDoc = await PDFDocument.load(templatePdf, { updateMetadata: false });
  let form;
  try {
    form = pdfDoc.getForm();
  } catch {
    return [];
  }
  return form.getFields().map((field) => {
    const type = fieldTypeOf(field);
    const info: AcroFormFieldInfo = { name: field.getName(), type };
    if (field instanceof PDFRadioGroup || field instanceof PDFDropdown || field instanceof PDFOptionList) {
      info.options = field.getOptions();
    }
    return info;
  });
}

/**
 * Fill AcroForm gốc bằng dữ liệu đã resolve (key = tên field PDF thật).
 * Throws PdfOverlayError xác định (ACROFORM_NOT_FOUND / MISSING_REQUIRED_FIELD /
 * ACROFORM_FIELD_NOT_FOUND / FONT_GLYPH_MISSING / FONT_BYTES_REQUIRED) — không
 * bao giờ âm thầm bỏ qua field bắt buộc hoặc option không hợp lệ.
 */
export async function fillAcroForm(
  templatePdf: Uint8Array,
  fieldValues: Record<string, AcroFormFieldValue>,
  options: AcroFormFillOptions,
): Promise<AcroFormFillResult> {
  if (!options.fontBytes || options.fontBytes.byteLength === 0) {
    throw new PdfOverlayError("FONT_BYTES_REQUIRED", "fontBytes bắt buộc để fill text field tiếng Việt.");
  }

  const pdfDoc = await PDFDocument.load(templatePdf, { updateMetadata: false });
  let form;
  try {
    form = pdfDoc.getForm();
  } catch {
    throw new PdfOverlayError("ACROFORM_NOT_FOUND", "PDF không có AcroForm.");
  }
  const fields = form.getFields();
  if (fields.length === 0) {
    throw new PdfOverlayError("ACROFORM_NOT_FOUND", "PDF không có field nào trong AcroForm.");
  }

  const { pdfFont, missing } = await embedVietnameseFont(pdfDoc, options.fontBytes, {
    subset: options.subsetFont ?? true,
  });
  if (missing.length > 0) {
    throw new PdfOverlayError(
      "FONT_GLYPH_MISSING",
      `Font nhúng thiếu glyph bắt buộc: ${missing.join(" ")}`,
    );
  }

  const requiredFields = new Set(options.requiredFields ?? []);
  const filledFields: string[] = [];
  const skippedBlankFields: string[] = [];
  const warnings: string[] = [];

  const requireOrSkip = (name: string): boolean => {
    if (requiredFields.has(name)) {
      throw new PdfOverlayError(
        "MISSING_REQUIRED_FIELD",
        `Field bắt buộc "${name}" không có giá trị.`,
        { placeholder: name },
      );
    }
    skippedBlankFields.push(name);
    return false;
  };

  for (const field of fields) {
    const name = field.getName();
    const hasValue = Object.prototype.hasOwnProperty.call(fieldValues, name);
    const raw = fieldValues[name];

    if (field instanceof PDFTextField) {
      const value = hasValue && raw !== undefined && raw !== null ? String(raw).trim() : "";
      if (value === "") {
        if (!requireOrSkip(name)) continue;
      }
      field.setText(value);
      field.updateAppearances(pdfFont);
      filledFields.push(name);
      continue;
    }

    if (field instanceof PDFCheckBox) {
      if (!hasValue) {
        if (!requireOrSkip(name)) continue;
      }
      if (isCheckedValue(raw)) field.check();
      else field.uncheck();
      filledFields.push(name);
      continue;
    }

    if (field instanceof PDFRadioGroup || field instanceof PDFDropdown || field instanceof PDFOptionList) {
      const value = typeof raw === "string" ? raw.trim() : "";
      if (!hasValue || value === "") {
        if (!requireOrSkip(name)) continue;
      }
      const validOptions = field.getOptions();
      if (!validOptions.includes(value)) {
        throw new PdfOverlayError(
          "ACROFORM_FIELD_NOT_FOUND",
          `Field "${name}" không có option "${value}" (hợp lệ: ${validOptions.join(", ") || "(không có option)"}).`,
          { placeholder: name },
        );
      }
      field.select(value);
      filledFields.push(name);
      continue;
    }

    warnings.push(`Field "${name}" (${field.constructor.name}) không được hỗ trợ — bỏ qua (không ghi giá trị).`);
  }

  if (options.flatten) {
    form.flatten();
  }

  const bytes = await pdfDoc.save({ useObjectStreams: true });
  return {
    bytes,
    sha256: sha256Hex(bytes),
    pageCount: pdfDoc.getPageCount(),
    filledFields,
    skippedBlankFields,
    warnings,
  };
}
