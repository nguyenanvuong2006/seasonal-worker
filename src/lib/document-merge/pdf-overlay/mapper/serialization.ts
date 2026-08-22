/**
 * PDF Overlay — Visual Mapper position serialization (PR3, management layer).
 *
 * Chuyển đổi giữa:
 *   - row DB (PdfFieldPosition từ PR2 service/list API)
 *   - trạng thái editor (EditorPosition — client dùng cho box overlay + form)
 *   - payload upsert (NewPdfFieldPositionInput — gửi lên PUT positions bulk upsert)
 *
 * Module THUẦN. Giá trị tọa độ LUÔN là pt gốc bottom-left (PR1). KHÔNG bypass
 * PR2 service — module này chỉ chuẩn bị payload mà service/API đã kiểm tra.
 *
 * Bao gồm dirty-state detection (so sánh payload chuẩn hoá) và giá trị mặc định
 * khi tạo position mới.
 */

import type {
  Align,
  CheckboxStyle,
  OverflowPolicy,
  PdfPositionType,
  Valign,
} from "./../types.ts";

/**
 * Payload gửi lên PUT /positions (bulk upsert). Khớp NewPdfFieldPositionInput của
 * PR2 position-service nhưng định nghĩa LOCAL ở đây để module vẫn THUẦN
 * (không import position-service → không kéo drizzle/db → chạy được node --test).
 * API/service vẫn là nơi duy nhất validate + ghi DB (không bypass).
 */
export interface PositionPayload {
  placeholder: string;
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
  type?: PdfPositionType;
  fontSize?: number;
  minFontSize?: number | null;
  fontFamily?: string | null;
  align?: Align;
  valign?: Valign;
  multiline?: boolean;
  maxLines?: number | null;
  rotation?: number;
  renderOrder?: number;
  isRequired?: boolean;
  whiteout?: boolean;
  checkboxStyle?: CheckboxStyle | null;
  optionValue?: string | null;
  sourceKey?: string | null;
  overflowPolicy?: OverflowPolicy;
  staticText?: string | null;
  metadata?: Record<string, unknown>;
}

/** Trạng thái editor của 1 position (client dùng cho overlay + form). */
export interface EditorPosition {
  /** id tạm (client) — ổn định trong phiên, không gửi lên server. */
  clientId: string;
  /** id DB khi position đã được persist (upsert); undefined nếu mới. */
  dbId?: string;
  placeholder: string;
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
  type: PdfPositionType;
  fontSize: number;
  minFontSize: number | null;
  fontFamily: string | null;
  align: Align;
  valign: Valign;
  multiline: boolean;
  maxLines: number | null;
  rotation: number;
  renderOrder: number;
  isRequired: boolean;
  whiteout: boolean;
  checkboxStyle: CheckboxStyle | null;
  optionValue: string | null;
  sourceKey: string | null;
  overflowPolicy: OverflowPolicy;
  staticText: string | null;
  metadata: Record<string, unknown>;
}

/** Loại row linh hoạt (accept DB row hoặc object tương tự). */
export interface DbPositionRowLike {
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
  fontFamily?: string | null;
  align?: string | null;
  valign?: string | null;
  multiline?: boolean | null;
  maxLines?: number | null;
  rotation?: number | null;
  renderOrder?: number | null;
  isRequired?: boolean | null;
  whiteout?: boolean | null;
  checkboxStyle?: string | null;
  optionValue?: string | null;
  sourceKey?: string | null;
  overflowPolicy?: string | null;
  staticText?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** Tạo clientId ổn định trong session. */
export function newClientId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `pos-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

const isAlign = (v: string): v is Align => v === "left" || v === "center" || v === "right";
const isValign = (v: string): v is Valign => v === "top" || v === "middle" || v === "bottom";
const isCheckboxStyle = (v: string): v is CheckboxStyle =>
  v === "SQUARE_X" || v === "SQUARE_TICK" || v === "SQUARE_FILLED" || v === "CIRCLE_DOT";
const isOverflow = (v: string): v is OverflowPolicy => v === "FAIL" || v === "ELLIPSIZE";

/** Chuyển 1 row DB → EditorPosition (giá trị mặc định khi thiếu). */
export function dbRowToEditor(row: DbPositionRowLike): EditorPosition {
  const type = (row.type ?? "TEXT") as PdfPositionType;
  return {
    clientId: newClientId(),
    dbId: row.id,
    placeholder: row.placeholder,
    pageNumber: row.pageNumber,
    x: row.x,
    y: row.y,
    width: row.width,
    height: row.height,
    type,
    fontSize: row.fontSize ?? 10,
    minFontSize: row.minFontSize ?? null,
    fontFamily: row.fontFamily ?? null,
    align: row.align && isAlign(row.align) ? row.align : "left",
    valign: row.valign && isValign(row.valign) ? row.valign : "top",
    multiline: row.multiline ?? false,
    maxLines: row.maxLines ?? null,
    rotation: row.rotation ?? 0,
    renderOrder: row.renderOrder ?? 0,
    isRequired: row.isRequired ?? false,
    whiteout: row.whiteout ?? false,
    checkboxStyle: row.checkboxStyle && isCheckboxStyle(row.checkboxStyle) ? row.checkboxStyle : null,
    optionValue: row.optionValue ?? null,
    sourceKey: row.sourceKey ?? null,
    overflowPolicy: row.overflowPolicy && isOverflow(row.overflowPolicy) ? row.overflowPolicy : "FAIL",
    staticText: row.staticText ?? null,
    metadata: row.metadata ?? {},
  };
}

/**
 * EditorPosition → payload upsert (PR2). Gửi trực tiếp cho PUT positions bulk upsert.
 * Tọa độ đã ở pt bottom-left; metadata giữ nguyên (nếu có).
 */
export function editorToPayload(pos: EditorPosition): PositionPayload {
  return {
    placeholder: pos.placeholder,
    pageNumber: pos.pageNumber,
    x: pos.x,
    y: pos.y,
    width: pos.width,
    height: pos.height,
    type: pos.type,
    fontSize: pos.fontSize,
    minFontSize: pos.minFontSize,
    fontFamily: pos.fontFamily,
    align: pos.align,
    valign: pos.valign,
    multiline: pos.multiline,
    maxLines: pos.maxLines,
    rotation: pos.rotation,
    renderOrder: pos.renderOrder,
    isRequired: pos.isRequired,
    whiteout: pos.whiteout,
    checkboxStyle: pos.checkboxStyle,
    optionValue: pos.optionValue,
    sourceKey: pos.sourceKey,
    overflowPolicy: pos.overflowPolicy,
    staticText: pos.staticText,
    metadata: pos.metadata,
  };
}

/**
 * Chuẩn hoá payload để so sánh dirty-state (không quan tâm thứ tự key / metadata).
 * Trả bản so sánh ổn định (string) của từng position theo clientId.
 */
export function positionDirtyKey(pos: EditorPosition): string {
  const p = editorToPayload(pos);
  return JSON.stringify({
    placeholder: p.placeholder,
    pageNumber: p.pageNumber,
    x: Math.round(p.x * 1000) / 1000,
    y: Math.round(p.y * 1000) / 1000,
    width: Math.round(p.width * 1000) / 1000,
    height: Math.round(p.height * 1000) / 1000,
    type: p.type,
    fontSize: p.fontSize,
    minFontSize: p.minFontSize ?? null,
    align: p.align,
    valign: p.valign,
    multiline: p.multiline,
    maxLines: p.maxLines ?? null,
    rotation: p.rotation,
    isRequired: p.isRequired,
    whiteout: p.whiteout,
    checkboxStyle: p.checkboxStyle ?? null,
    optionValue: p.optionValue ?? null,
    sourceKey: p.sourceKey ?? null,
    overflowPolicy: p.overflowPolicy,
    staticText: p.staticText ?? null,
  });
}

/** Kiểm tra editor positions có khác bản gốc (đã persist) không. */
export function isDirty(current: EditorPosition[], baseline: EditorPosition[]): boolean {
  const cur = new Map(current.map((p) => [p.dbId ?? p.clientId, positionDirtyKey(p)]));
  const base = new Map(baseline.map((p) => [p.dbId ?? p.clientId, positionDirtyKey(p)]));

  if (cur.size !== base.size) return true;
  for (const [k, v] of cur) {
    if (base.get(k) !== v) return true;
  }
  return false;
}

/** Box mặc định cho text khi tạo position mới (pt). */
export function defaultTextBox(): { x: number; y: number; width: number; height: number } {
  return { x: 100, y: 500, width: 200, height: 18 };
}

/** Tạo EditorPosition mới (chưa persist). */
export function makeNewPosition(
  placeholder: string,
  pageNumber: number,
  opts: { type?: PdfPositionType; sourceKey?: string | null; optionValue?: string | null } = {},
): EditorPosition {
  const type = opts.type ?? "TEXT";
  const box = defaultTextBox();
  const isCheckbox = type === "CHECKBOX" || type === "RADIO_OPTION";
  return {
    clientId: newClientId(),
    placeholder,
    pageNumber,
    ...box,
    type,
    fontSize: 10,
    minFontSize: null,
    fontFamily: null,
    align: "left",
    valign: "top",
    multiline: false,
    maxLines: null,
    rotation: 0,
    renderOrder: 0,
    isRequired: false,
    whiteout: false,
    checkboxStyle: isCheckbox ? "SQUARE_X" : null,
    optionValue: opts.optionValue ?? null,
    sourceKey: opts.sourceKey ?? null,
    overflowPolicy: "FAIL",
    staticText: null,
    metadata: {},
  };
}
