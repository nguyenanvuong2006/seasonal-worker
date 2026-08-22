/**
 * PDF Overlay — Visual Mapper validation summary (PR3, management layer).
 *
 * Hàm THUẦN (không DB/storage): tính toán tổng kết validation trước khi publish.
 * Đầu vào:
 *   - positions  : danh sách position đang soạn (pt, gốc bottom-left — PR1).
 *   - pageLayout : page_layout của version (pdf_template_versions).
 *   - fields     : danh sách placeholder của template (mapping đang hoạt động).
 *
 * Trả về:
 *   - errors   : lỗi CHẶN publish (geometry, out-of-bounds, page invalid, checkbox,
 *                overflow config, duplicates). Publish vẫn được thực hiện qua PR2
 *                lifecycle API (gate SHA integrity là bất biến ở service), panel này
 *                chỉ trình bày cho Admin.
 *   - warnings : cảnh báo không chặn — gồm "unmapped placeholder" (optional) và các
 *                orphan mapping đã tồn tại (KHÔNG tự xoá — xem ghi chú dưới).
 *   - infos    : thông tin (vd số placeholder đã map).
 *
 * LƯU Ý bất biến (theo yêu cầu PR3):
 *   - 2 orphan mapping đã biết (So_hop_dong_dich_vu_thue, Ngay_hop_dong_dich_vu_thue)
 *     KHÔNG tự động chặn PR này và KHÔNG được tự xoá. Chúng chỉ xuất hiện như warning
 *     "orphan placeholder" nếu được truyền vào `fields`.
 *   - Không rewrite/xoá mapping GOOGLE_DOCS — module này chỉ ĐỌC.
 */

import { isBoxInsidePage, isValidRotation } from "./../geometry.ts";
import { positionKeyOf } from "./../validation.ts";

export const VALID_TYPES = [
  "TEXT",
  "MULTILINE_TEXT",
  "DATE",
  "NUMBER",
  "CHECKBOX",
  "RADIO_OPTION",
  "SIGNATURE_TEXT",
  "STATIC_TEXT",
  "IMAGE",
] as const;

export interface PageLayoutEntry {
  pageNumber: number;
  width: number;
  height: number;
  rotation?: number;
}

export interface PositionLike {
  id?: string;
  placeholder: string;
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
  type?: string;
  fontSize?: number | null;
  minFontSize?: number | null;
  align?: string | null;
  valign?: string | null;
  multiline?: boolean | null;
  maxLines?: number | null;
  rotation?: number | null;
  isRequired?: boolean | null;
  checkboxStyle?: string | null;
  optionValue?: string | null;
  sourceKey?: string | null;
  overflowPolicy?: string | null;
  staticText?: string | null;
}

export interface FieldLike {
  placeholder: string;
  isRequired?: boolean;
  isOrphaned?: boolean;
}

export interface ValidationSummary {
  errors: string[];
  warnings: string[];
  infos: string[];
  /** Nhóm error theo code ổn định — dùng để hiện badge/icon. */
  errorCodes: string[];
  /** Số placeholder đã có ít nhất 1 position. */
  mappedPlaceholderCount: number;
}

const ALIGN_VALUES = ["left", "center", "right"];
const VALIGN_VALUES = ["top", "middle", "bottom"];
const CHECKBOX_STYLES = ["SQUARE_X", "SQUARE_TICK", "SQUARE_FILLED", "CIRCLE_DOT"];
const OVERFLOW_VALUES = ["FAIL", "ELLIPSIZE"];

const KNOWN_ORPHAN_HINTS = [
  "So_hop_dong_dich_vu_thue",
  "Ngay_hop_dong_dich_vu_thue",
];

/** Tính tổng kết validation — thuần, không throw. */
export function buildValidationSummary(
  positions: PositionLike[],
  pageLayout: PageLayoutEntry[],
  fields: FieldLike[],
): ValidationSummary {
  const errors: string[] = [];
  const warnings: string[] = [];
  const infos: string[] = [];
  const errorCodes = new Set<string>();

  const pagesByNumber = new Map(pageLayout.map((p) => [p.pageNumber, p]));
  const requiredByPlaceholder = new Map(
    fields.filter((f) => f.isRequired).map((f) => [f.placeholder, true]),
  );
  const activePlaceholders = new Set(fields.filter((f) => !f.isOrphaned).map((f) => f.placeholder));

  // --- geometry / page / type / font per position ---
  const keys = new Map<string, { placeholder: string; pageNumber: number }>();
  const overlapping: string[] = [];

  const boxRects = positions.map((pos) => {
    const page = pagesByNumber.get(pos.pageNumber);
    return { pos, page, rect: page ? { x: pos.x, y: pos.y, width: pos.width, height: pos.height } : null };
  });

  for (const { pos, page } of boxRects) {
    const label = `${pos.placeholder}@page${pos.pageNumber}`;

    if (!Number.isInteger(pos.pageNumber) || pos.pageNumber < 1) {
      errors.push(`${label}: page_number phải là số nguyên ≥ 1.`);
      errorCodes.add("INVALID_PAGE_NUMBER");
      continue;
    }
    if (!page) {
      errors.push(`${label}: page ${pos.pageNumber} không tồn tại trong template (${pageLayout.length} trang).`);
      errorCodes.add("INVALID_PAGE_NUMBER");
      continue;
    }

    const type = pos.type ?? "TEXT";
    if (!(VALID_TYPES as readonly string[]).includes(type)) {
      errors.push(`${label}: type=${type} không hợp lệ.`);
      errorCodes.add("UNSUPPORTED_FIELD_TYPE");
    }

    if (
      !Number.isFinite(pos.x) || !Number.isFinite(pos.y) ||
      !Number.isFinite(pos.width) || !Number.isFinite(pos.height)
    ) {
      errors.push(`${label}: x/y/width/height phải là số hợp lệ.`);
      errorCodes.add("INVALID_GEOMETRY");
      continue;
    }
    if (pos.width <= 0 || pos.height <= 0) {
      errors.push(`${label}: width/height phải > 0.`);
      errorCodes.add("INVALID_GEOMETRY");
      continue;
    }
    if (!isBoxInsidePage({ x: pos.x, y: pos.y, width: pos.width, height: pos.height }, page.width, page.height)) {
      errors.push(
        `${label}: box (${pos.x},${pos.y},${pos.width},${pos.height}) nằm ngoài trang ${pos.pageNumber} (${page.width}×${page.height}).`,
      );
      errorCodes.add("OUT_OF_BOUNDS");
    }

    if (pos.rotation !== undefined && pos.rotation !== null && !isValidRotation(pos.rotation)) {
      errors.push(`${label}: rotation=${pos.rotation} không hợp lệ (0/90/180/270).`);
      errorCodes.add("OUT_OF_BOUNDS");
    }

    const fontSize = pos.fontSize ?? 10;
    if (!Number.isFinite(fontSize) || fontSize <= 0) {
      errors.push(`${label}: fontSize phải > 0.`);
      errorCodes.add("OVERFLOW_CONFIG");
    }
    if (pos.minFontSize !== null && pos.minFontSize !== undefined) {
      if (!Number.isFinite(pos.minFontSize) || pos.minFontSize <= 0) {
        errors.push(`${label}: minFontSize phải > 0.`);
        errorCodes.add("OVERFLOW_CONFIG");
      } else if (pos.minFontSize > fontSize) {
        errors.push(`${label}: minFontSize (${pos.minFontSize}) > fontSize (${fontSize}).`);
        errorCodes.add("OVERFLOW_CONFIG");
      }
    }
    if (pos.maxLines !== null && pos.maxLines !== undefined && pos.maxLines < 1) {
      errors.push(`${label}: maxLines phải ≥ 1.`);
      errorCodes.add("OVERFLOW_CONFIG");
    }
    if (pos.align !== undefined && pos.align !== null && !ALIGN_VALUES.includes(pos.align)) {
      errors.push(`${label}: align=${pos.align} không hợp lệ.`);
      errorCodes.add("OVERFLOW_CONFIG");
    }
    if (pos.valign !== undefined && pos.valign !== null && !VALIGN_VALUES.includes(pos.valign)) {
      errors.push(`${label}: valign=${pos.valign} không hợp lệ.`);
      errorCodes.add("OVERFLOW_CONFIG");
    }
    if (pos.overflowPolicy !== undefined && pos.overflowPolicy !== null && !OVERFLOW_VALUES.includes(pos.overflowPolicy)) {
      errors.push(`${label}: overflowPolicy=${pos.overflowPolicy} không hợp lệ (FAIL/ELLIPSIZE).`);
      errorCodes.add("OVERFLOW_CONFIG");
    }

    // checkbox / radio rules
    const isCheckbox = type === "CHECKBOX" || type === "RADIO_OPTION";
    if (isCheckbox) {
      if (!pos.optionValue || String(pos.optionValue).trim() === "") {
        errors.push(`${label}: ${type} yêu cầu optionValue.`);
        errorCodes.add("INVALID_CHECKBOX");
      }
      if (!pos.sourceKey || String(pos.sourceKey).trim() === "") {
        errors.push(`${label}: ${type} yêu cầu sourceKey.`);
        errorCodes.add("INVALID_CHECKBOX");
      }
      if (pos.checkboxStyle && !CHECKBOX_STYLES.includes(pos.checkboxStyle)) {
        errors.push(`${label}: checkboxStyle=${pos.checkboxStyle} không hợp lệ.`);
        errorCodes.add("INVALID_CHECKBOX");
      }
    }

    if (type === "STATIC_TEXT") {
      if (!pos.staticText || String(pos.staticText).trim() === "") {
        errors.push(`${label}: STATIC_TEXT yêu cầu staticText.`);
        errorCodes.add("INVALID_GEOMETRY");
      }
      if (pos.isRequired) {
        errors.push(`${label}: STATIC_TEXT không thể là required.`);
        errorCodes.add("OVERFLOW_CONFIG");
      }
    }

    // duplicate natural key
    const key = positionKeyOf({ placeholder: pos.placeholder, pageNumber: pos.pageNumber, x: pos.x, y: pos.y });
    if (keys.has(key)) {
      const prev = keys.get(key)!;
      if (prev.placeholder === pos.placeholder && prev.pageNumber === pos.pageNumber) {
        errors.push(
          `Position trùng khoá: placeholder=${pos.placeholder} page=${pos.pageNumber} (${pos.x},${pos.y}).`,
        );
        errorCodes.add("DUPLICATE");
      }
    } else {
      keys.set(key, { placeholder: pos.placeholder, pageNumber: pos.pageNumber });
    }
  }

  // --- overlap (2 box chồng nhau cùng placeholder khác vị trí, hoặc khác placeholder) ---
  const validRects = boxRects.filter((b) => b.page && b.pos.width > 0 && b.pos.height > 0);
  for (let i = 0; i < validRects.length; i++) {
    for (let j = i + 1; j < validRects.length; j++) {
      const a = validRects[i];
      const b = validRects[j];
      if (a.page!.pageNumber !== b.page!.pageNumber) continue;
      if (rectsOverlap(a.rect!, b.rect!)) {
        const same = a.pos.placeholder === b.pos.placeholder;
        const msg = same
          ? `Hai position của "${a.pos.placeholder}" chồng nhau trên page ${a.page!.pageNumber}.`
          : `Position "${a.pos.placeholder}" và "${b.pos.placeholder}" chồng nhau trên page ${a.page!.pageNumber}.`;
        overlapping.push(msg);
      }
    }
  }
  // Overlap là warning (không chặn) trừ khi cùng placeholder (khó nhìn). Ta đưa
  // tất cả overlap thành warning để Admin tự xử lý — không chặn publish.
  warnings.push(...[...new Set(overlapping)]);

  // --- missing required mappings / unmapped placeholders ---
  const placed = new Set(positions.map((p) => p.placeholder));
  for (const ph of activePlaceholders) {
    if (!placed.has(ph)) {
      if (requiredByPlaceholder.has(ph)) {
        warnings.push(`Placeholder bắt buộc chưa có position: ${ph}.`);
      } else {
        warnings.push(`Placeholder chưa map (optional): ${ph}.`);
      }
    }
  }

  // --- orphan mappings (đã biết) — KHÔNG chặn, không xoá ---
  const orphans = fields.filter((f) => f.isOrphaned || KNOWN_ORPHAN_HINTS.includes(f.placeholder));
  for (const o of orphans) {
    warnings.push(
      `Orphan placeholder tồn tại (không chặn publish): ${o.placeholder}. Bạn có thể bỏ qua hoặc map nó; hệ thống không tự xoá mapping GOOGLE_DOCS.`,
    );
  }

  const placedActive = [...placed].filter((p) => activePlaceholders.has(p));
  const mappedPlaceholderCount = placedActive.length;

  infos.push(
    `${mappedPlaceholderCount}/${activePlaceholders.size} placeholder active đã có ít nhất 1 position; tổng ${positions.length} position trên ${pageLayout.length} trang.`,
  );
  if (positions.length === 0) {
    infos.push("Chưa có position nào — bắt đầu kéo placeholder từ panel bên trái.");
  }

  return {
    errors,
    warnings,
    infos,
    errorCodes: [...errorCodes],
    mappedPlaceholderCount,
  };
}

function rectsOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  const EPS = 0.5;
  return (
    a.x < b.x + b.width - EPS &&
    b.x < a.x + a.width - EPS &&
    a.y < b.y + b.height - EPS &&
    b.y < a.y + a.height - EPS
  );
}
