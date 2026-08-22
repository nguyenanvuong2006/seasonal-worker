/**
 * PDF Overlay — controlled STAGING-only E2E fixture + job snapshot (PR5).
 *
 * Mục đích: chứng minh toàn bộ luồng staging end-to-end cho PDF Overlay
 * renderer bằng dữ liệu GIẢ (synthetic, KHÔNG PII) và KHÔNG đụng production:
 *
 *   queue (merge_jobs + merge_job_records) → worker /run-overlay (staging)
 *   → renderer pdf-overlay → storage (staging) → document_history
 *   → idempotency / retry / failure semantics.
 *
 * Module THUẦN (không import server-only / DB) — dùng chung được bởi:
 *   - Cloud Run worker (worker/src/index.ts → /run-overlay)
 *   - E2E script (scripts/staging-e2e-overlay.mjs)
 *   - bộ test `node --test` (src/lib/.../*.test.ts)
 *
 * AN TOÀN (hard constraints của PR5):
 *   - Mọi field value đều là dữ liệu giả, vượt qua assertFixtureSafe()
 *     (production-isolation.ts) — KHÔNG chứa CCCD 12 số / số điện thoại thật /
 *     email thật.
 *   - Snapshot ghi vào merge_jobs.metadata chỉ chứa fixture + positions —
 *     KHÔNG chứa secret, KHÔNG chứa dữ liệu production.
 *   - Engine marker riêng "PDF_OVERLAY" — KHÔNG đổi DOCUMENT_MERGE_ENGINE
 *     (production vẫn GOOGLE_DOCS).
 */

import { PDFDocument } from "pdf-lib";

import { A4_HEIGHT_PT, A4_WIDTH_PT } from "./geometry.ts";
import { readEmbeddedFontBytes } from "./vietnamese-font.ts";
import { renderPdfOverlay, sha256Hex } from "./renderer.ts";
import type { PdfOverlayRenderResult, PdfPositionSpec } from "./types.ts";

/** Engine marker cho job overlay E2E (cột merge_jobs.engine). KHÔNG phải DocumentMergeEngine. */
export const OVERLAY_E2E_ENGINE = "PDF_OVERLAY" as const;

/** Kind marker trong metadata.e2e.kind — worker chỉ nhận đúng marker này. */
export const OVERLAY_E2E_KIND = "staging-e2e-overlay" as const;

/** Số trang template (A4) của fixture — phải khớp page count output. */
export const OVERLAY_E2E_EXPECTED_PAGE_COUNT = 2;

/** Retention snapshot cho document_history (giống mặc định HTML engine). */
export const OVERLAY_E2E_RETENTION_YEARS = 3;

/** Tên document type ghi vào document_history + filename (đánh dấu NON-PRODUCTION). */
export const OVERLAY_E2E_DOCUMENT_TYPE = "PDF-Overlay-E2E";

/** Snapshot đầy đủ ghi vào merge_jobs.metadata.e2e — worker render từ đây. */
export interface OverlayE2ESnapshot {
  kind: typeof OVERLAY_E2E_KIND;
  /** Bắt buộc true — đánh dấu artifact/job là NON-PRODUCTION. */
  nonProduction: true;
  /** Template PDF (blank A4, 2 trang) dạng base64 — nhỏ (~1KB), không phải PII. */
  templatePdfB64: string;
  /** Vị trí render (snapshot deterministic). */
  positions: PdfPositionSpec[];
  /** Field values cơ sở (giả, không PII). Per-item chỉ khác So_thu_tu/Tong_so. */
  fieldValues: Record<string, string>;
  /** Số trang kỳ vọng — renderer fail nếu lệch (STRUCTURAL gate). */
  expectedPageCount: number;
  /** Tổng số record của job (để per-item field Tong_so). */
  total: number;
}

/** Tạo template blank A4 với `pageCount` trang — deterministic (cùng input → cùng bytes). */
export async function makeStagingE2ETemplate(pageCount = OVERLAY_E2E_EXPECTED_PAGE_COUNT): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) {
    doc.addPage([A4_WIDTH_PT, A4_HEIGHT_PT]);
  }
  return doc.save({ useObjectStreams: true });
}

/**
 * Positions của fixture E2E: 10 vị trí trên 2 trang — phủ TEXT, MULTILINE_TEXT,
 * DATE, NUMBER, CHECKBOX (checked + unchecked) — tất cả isRequired để
 * "no unresolved placeholders" có nghĩa kiểm tra mạnh.
 */
export function buildStagingE2EPositions(): PdfPositionSpec[] {
  return [
    // Trang 1
    { placeholder: "Ho_ten", pageNumber: 1, x: 50, y: 760, width: 260, height: 22, type: "TEXT", fontSize: 13, align: "left", valign: "middle", isRequired: true },
    { placeholder: "Ngay_sinh", pageNumber: 1, x: 340, y: 760, width: 130, height: 22, type: "DATE", fontSize: 12, align: "left", valign: "middle", isRequired: true },
    { placeholder: "So_thu_tu", pageNumber: 1, x: 490, y: 760, width: 55, height: 22, type: "NUMBER", fontSize: 12, align: "center", valign: "middle", isRequired: true },
    { placeholder: "Tong_so", pageNumber: 1, x: 545, y: 760, width: 45, height: 22, type: "NUMBER", fontSize: 12, align: "center", valign: "middle", isRequired: true },
    { placeholder: "Gioi_tinh", pageNumber: 1, x: 50, y: 720, width: 120, height: 20, type: "TEXT", fontSize: 12, align: "left", valign: "middle", isRequired: true },
    { placeholder: "Dia_chi", pageNumber: 1, x: 50, y: 640, width: 340, height: 72, type: "MULTILINE_TEXT", fontSize: 11, align: "left", valign: "top", multiline: true, maxLines: 4, isRequired: true },
    { placeholder: "Ghi_chu", pageNumber: 1, x: 50, y: 320, width: 480, height: 34, type: "TEXT", fontSize: 10, align: "left", valign: "middle", isRequired: true },
    { placeholder: "Dong_y", pageNumber: 1, x: 60, y: 220, width: 16, height: 16, type: "CHECKBOX", checkboxStyle: "SQUARE_X", isRequired: true },
    { placeholder: "Tu_choi", pageNumber: 1, x: 60, y: 180, width: 16, height: 16, type: "CHECKBOX", checkboxStyle: "SQUARE_X", isRequired: true },
    { placeholder: "Ngay_ky", pageNumber: 1, x: 420, y: 180, width: 130, height: 20, type: "DATE", fontSize: 11, align: "left", valign: "middle", isRequired: true },
    // Trang 2 — phủ ký tự tiếng Việt + số tiền
    { placeholder: "Kiem_tra_tieng_viet", pageNumber: 2, x: 50, y: 770, width: 460, height: 22, type: "TEXT", fontSize: 12, align: "left", valign: "middle", isRequired: true },
    { placeholder: "Gia_tri", pageNumber: 2, x: 50, y: 730, width: 180, height: 20, type: "NUMBER", fontSize: 12, align: "left", valign: "middle", isRequired: true },
  ];
}

/**
 * Field values CƠ SỞ (giả, không PII — vượt assertFixtureSafe):
 * KHÔNG có CCCD 12 số, KHÔNG có số điện thoại 0xxxxxxxxx, KHÔNG có email thật.
 */
export function buildStagingE2EBaseFieldValues(): Record<string, string> {
  return {
    Ho_ten: "Nguyễn Thị Thử Nghiệm",
    Ngay_sinh: "15/03/2000",
    Gioi_tinh: "Nữ",
    Dia_chi: "Phòng Kiểm Thử 1, Khu Công Nghệ Thử Nghiệm, Thành phố Thử Nghiệm, Việt Nam",
    Ghi_chu: "HỒ SƠ KIỂM THỬ STAGING — dữ liệu giả, không phải hồ sơ thật.",
    Dong_y: "☒",
    Tu_choi: "☐",
    Ngay_ky: "22/08/2026",
    Kiem_tra_tieng_viet: "Đà Lạt — ă â đ ê ô ơ ư, Cộng hòa xã hội chủ nghĩa Việt Nam",
    Gia_tri: "12.345.678",
  };
}

/**
 * Field values của ITEM thứ `index` (1-based) trong job `total` record —
 * deterministic, chỉ khác So_thu_tu/Tong_so → mỗi item ra 1 PDF khác nhau,
 * cùng input → cùng sha256 (deterministic).
 */
export function buildStagingE2EFieldValues(
  base: Record<string, string>,
  index: number,
  total: number,
): Record<string, string> {
  return {
    ...base,
    So_thu_tu: String(index),
    Tong_so: String(total),
  };
}

/** Giải mã template PDF từ snapshot (base64 → Uint8Array). */
export function decodeStagingE2ETemplate(snapshot: OverlayE2ESnapshot): Uint8Array {
  if (!snapshot.templatePdfB64) {
    throw new Error("OVERLAY_E2E_SNAPSHOT_INVALID: thiếu templatePdfB64.");
  }
  return new Uint8Array(Buffer.from(snapshot.templatePdfB64, "base64"));
}

/**
 * Validate snapshot đọc từ merge_jobs.metadata — worker CHỈ render khi hợp lệ.
 * Ném Error với message rõ ràng (không chứa dữ liệu nhạy cảm).
 */
export function parseOverlayE2ESnapshot(metadata: unknown): OverlayE2ESnapshot {
  if (typeof metadata !== "object" || metadata === null) {
    throw new Error("OVERLAY_E2E_SNAPSHOT_INVALID: metadata rỗng.");
  }
  const e2e = (metadata as { e2e?: unknown }).e2e;
  if (typeof e2e !== "object" || e2e === null) {
    throw new Error("OVERLAY_E2E_SNAPSHOT_INVALID: thiếu metadata.e2e.");
  }
  const s = e2e as Partial<OverlayE2ESnapshot>;
  if (s.kind !== OVERLAY_E2E_KIND) {
    throw new Error(`OVERLAY_E2E_SNAPSHOT_INVALID: kind=${String(s.kind)} != ${OVERLAY_E2E_KIND}.`);
  }
  if (s.nonProduction !== true) {
    throw new Error("OVERLAY_E2E_SNAPSHOT_INVALID: nonProduction != true.");
  }
  if (typeof s.templatePdfB64 !== "string" || s.templatePdfB64.length === 0) {
    throw new Error("OVERLAY_E2E_SNAPSHOT_INVALID: thiếu templatePdfB64.");
  }
  if (!Array.isArray(s.positions) || s.positions.length === 0) {
    throw new Error("OVERLAY_E2E_SNAPSHOT_INVALID: positions rỗng.");
  }
  if (typeof s.fieldValues !== "object" || s.fieldValues === null) {
    throw new Error("OVERLAY_E2E_SNAPSHOT_INVALID: fieldValues rỗng.");
  }
  const expectedPageCount = Number(s.expectedPageCount ?? 0);
  if (!Number.isInteger(expectedPageCount) || expectedPageCount < 1) {
    throw new Error("OVERLAY_E2E_SNAPSHOT_INVALID: expectedPageCount không hợp lệ.");
  }
  const total = Number(s.total ?? 0);
  if (!Number.isInteger(total) || total < 1) {
    throw new Error("OVERLAY_E2E_SNAPSHOT_INVALID: total không hợp lệ.");
  }
  return {
    kind: OVERLAY_E2E_KIND,
    nonProduction: true,
    templatePdfB64: s.templatePdfB64,
    positions: s.positions as PdfPositionSpec[],
    fieldValues: s.fieldValues as Record<string, string>,
    expectedPageCount,
    total,
  };
}

/** Dựng snapshot đầy đủ cho 1 job E2E (template + positions + values cơ sở). */
export async function buildStagingE2ESnapshot(total: number): Promise<OverlayE2ESnapshot> {
  const templatePdf = await makeStagingE2ETemplate();
  return {
    kind: OVERLAY_E2E_KIND,
    nonProduction: true,
    templatePdfB64: Buffer.from(templatePdf).toString("base64"),
    positions: buildStagingE2EPositions(),
    fieldValues: buildStagingE2EBaseFieldValues(),
    expectedPageCount: OVERLAY_E2E_EXPECTED_PAGE_COUNT,
    total,
  };
}

/**
 * Render item thứ `index` (1-based) của job `total` record bằng đúng code path
 * renderer pdf-overlay (font DejaVu nhúng, subset, structural gate page count).
 * Deterministic: cùng input → cùng bytes + sha256.
 */
export async function renderStagingE2EItem(
  snapshot: OverlayE2ESnapshot,
  index: number,
  total: number,
): Promise<PdfOverlayRenderResult> {
  const values = buildStagingE2EFieldValues(snapshot.fieldValues, index, total);
  return renderPdfOverlay(decodeStagingE2ETemplate(snapshot), snapshot.positions, values, {
    fontBytes: readEmbeddedFontBytes(),
    expectedPageCount: snapshot.expectedPageCount,
    subsetFont: true,
  });
}

/**
 * Kiểm tra "no unresolved placeholders" cho 1 item:
 *   - Mọi position spec đều được vẽ (positionsDrawn == positions.length)
 *   - Không warning nào của renderer (FIELD_OVERFLOW / thiếu glyph ...)
 *   - Mọi placeholder trong positions đều có giá trị trong fieldValues
 *     (đã có isRequired=true → renderer tự fail nếu thiếu; check này là
 *     bằng chứng độc lập ở tầng fixture).
 */
export function assertStagingE2EItemComplete(
  result: Pick<PdfOverlayRenderResult, "positionsDrawn" | "warnings">,
  snapshot: OverlayE2ESnapshot,
  index: number,
  total: number,
): { ok: boolean; detail: string } {
  const values = buildStagingE2EFieldValues(snapshot.fieldValues, index, total);
  const placeholders = snapshot.positions.map((p) => p.placeholder);
  const missing = placeholders.filter((ph) => values[ph] === undefined || values[ph] === null);
  if (missing.length > 0) {
    return { ok: false, detail: `UNRESOLVED_PLACEHOLDERS: ${missing.join(", ")}` };
  }
  if (result.positionsDrawn !== snapshot.positions.length) {
    return { ok: false, detail: `POSITIONS_DRAWN_MISMATCH: ${result.positionsDrawn}/${snapshot.positions.length}` };
  }
  if (result.warnings.length > 0) {
    return { ok: false, detail: `RENDER_WARNINGS: ${result.warnings.join("; ")}` };
  }
  return { ok: true, detail: `positionsDrawn=${result.positionsDrawn} warnings=0 placeholders=${placeholders.length}` };
}

/** sha256 hex (cùng implementation renderer dùng — để so khớp). */
export function sha256Of(bytes: Uint8Array): string {
  return sha256Hex(bytes);
}
