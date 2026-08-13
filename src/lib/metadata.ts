import "server-only";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { fieldDefinitions, formQuestions, type FieldDefinition, type FormQuestion } from "@/db/schema";

/**
 * METADATA ENGINE
 * ----------------
 * Nguồn duy nhất mô tả "trường dữ liệu" cho 3 khối lõi (Department, DW Data,
 * Daily Application) là bảng `field_definitions`. Câu hỏi động (Dynamic Form)
 * tiếp tục là bảng `form_questions` (đã có sẵn từ trước) nhưng nay cũng mang
 * đủ thuộc tính alias/exportColumnName để tham gia vào import/export tự động.
 *
 * File này là nơi DUY NHẤT chứa logic "đọc tên cột nào ứng với field nào" —
 * import (CSV/XLSX), export (Excel) và các trang tìm kiếm/lọc đều phải gọi
 * qua đây, KHÔNG tự ý đọc row["Tên cột cố định"] ở nơi khác.
 */

export type Group = "department" | "dw_data" | "daily_application";

let cache: { at: number; defs: FieldDefinition[] } | null = null;
const CACHE_MS = 15_000; // tránh query lại field_definitions trên từng dòng của 1 lô import

export async function getFieldDefinitions(group?: Group): Promise<FieldDefinition[]> {
  const now = Date.now();
  if (!cache || now - cache.at > CACHE_MS) {
    const defs = await db.select().from(fieldDefinitions).orderBy(asc(fieldDefinitions.sortOrder));
    cache = { at: now, defs };
  }
  return group ? cache.defs.filter((d) => d.groupName === group) : cache.defs;
}

export function invalidateFieldDefinitionsCache() {
  cache = null;
}

/** Chuẩn hoá tên cột để so khớp không phân biệt hoa/thường, khoảng trắng thừa. */
export function normalizeHeader(s: string): string {
  return String(s ?? "")
    .replace(/\uFEFF/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * Chuẩn hoá "mờ" (fuzzy) — bỏ dấu tiếng Việt + ký tự đặc biệt, dùng làm LỚP DỰ PHÒNG khi so
 * khớp chính xác (normalizeHeader) không tìm thấy — để "Ho va ten"/"HO VA TEN"/"họ  và   tên"
 * đều khớp với alias "Họ và tên". Không thay thế so khớp chính xác — chỉ là fallback, nên
 * không làm giảm độ chính xác của các alias đã cấu hình đúng dấu.
 */
export function normalizeHeaderFuzzy(s: string): string {
  return normalizeHeader(s)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // bỏ dấu (kết hợp Unicode)
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, ""); // bỏ khoảng trắng + ký tự đặc biệt (không phải chữ/số)
}

/** Tạo index tra cứu nhanh: tên cột đã chuẩn hoá -> tên cột gốc trong file. */
export function buildHeaderIndex(row: Record<string, unknown>): Map<string, string> {
  const idx = new Map<string, string>();
  for (const key of Object.keys(row)) idx.set(normalizeHeader(key), key);
  return idx;
}

/** Index "mờ" (fuzzy) song song — dùng làm fallback khi buildHeaderIndex không khớp được. */
export function buildFuzzyHeaderIndex(row: Record<string, unknown>): Map<string, string> {
  const idx = new Map<string, string>();
  for (const key of Object.keys(row)) idx.set(normalizeHeaderFuzzy(key), key);
  return idx;
}

/** Toàn bộ tên cột 1 field có thể nhận diện được khi import: import name + tất cả alias. */
export function acceptedColumnNames(def: FieldDefinition | FormQuestion, isQuestion = false): string[] {
  const names: string[] = [];
  if (isQuestion) {
    const q = def as FormQuestion;
    names.push(q.questionText);
    if (Array.isArray(q.aliases)) names.push(...q.aliases);
  } else {
    const f = def as FieldDefinition;
    if (f.importColumnName) names.push(f.importColumnName);
    if (Array.isArray(f.aliases)) names.push(...f.aliases);
  }
  return names.filter(Boolean);
}

/**
 * Lấy giá trị của 1 field trong 1 dòng dữ liệu import, dò theo tên cột chính
 * (importColumnName) rồi lần lượt các alias — không phân biệt hoa/thường.
 */
export function pickByDef(
  row: Record<string, unknown>,
  headerIndex: Map<string, string>,
  def: FieldDefinition | FormQuestion,
  isQuestion = false,
): string | undefined {
  const names = acceptedColumnNames(def, isQuestion);
  for (const name of names) {
    const original = headerIndex.get(normalizeHeader(name));
    if (original !== undefined && row[original] !== undefined && String(row[original]).trim() !== "") {
      return String(row[original]);
    }
  }
  // Fallback "mờ" — bỏ dấu/khoảng trắng/ký tự đặc biệt (vd "Ho va ten" khớp "Họ và tên").
  const fuzzyIndex = buildFuzzyHeaderIndex(row);
  for (const name of names) {
    const original = fuzzyIndex.get(normalizeHeaderFuzzy(name));
    if (original !== undefined && row[original] !== undefined && String(row[original]).trim() !== "") {
      return String(row[original]);
    }
  }
  return undefined;
}

/** Tiện ích: lấy giá trị theo fieldKey (tự tìm definition tương ứng trong danh sách đã load). */
export function makeFieldPicker(row: Record<string, unknown>, defs: FieldDefinition[]) {
  const headerIndex = buildHeaderIndex(row);
  const byKey = new Map(defs.map((d) => [d.fieldKey, d]));
  return (fieldKey: string, fallbackLegacyNames: string[] = []): string | undefined => {
    const def = byKey.get(fieldKey);
    if (def) {
      const v = pickByDef(row, headerIndex, def);
      if (v !== undefined) return v;
    }
    // fallback an toàn cho dữ liệu cũ nếu admin chưa cấu hình alias cho field này
    for (const name of fallbackLegacyNames) {
      const original = headerIndex.get(normalizeHeader(name));
      if (original !== undefined && String(row[original] ?? "").trim() !== "") return String(row[original]);
    }
    return undefined;
  };
}

/** Danh sách cột dùng khi export (đã lọc exportable=true, sắp theo sortOrder). */
export function exportColumns(defs: FieldDefinition[]): { def: FieldDefinition; header: string }[] {
  return defs
    .filter((d) => d.exportable && d.visible)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((d) => ({ def: d, header: d.exportColumnName || d.displayName }));
}

/** Danh sách cột dùng khi tạo file mẫu (template) import. */
export function templateColumns(defs: FieldDefinition[]): string[] {
  return defs
    .filter((d) => d.importable)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((d) => d.importColumnName || d.displayName);
}

/* ============================================================
   SEED MẶC ĐỊNH — khớp đúng các tên cột đang hard-code trước đây
   để KHÔNG làm hỏng import/export hiện tại khi nâng cấp lên.
   ============================================================ */
type SeedDef = {
  fieldKey: string;
  groupName: Group;
  displayName: string;
  databaseField: string;
  importColumnName: string;
  aliases?: string[];
  fieldType?: string;
  required?: boolean;
  searchable?: boolean;
  sortable?: boolean;
  filterable?: boolean;
  exportable?: boolean;
  importable?: boolean;
  sortOrder: number;
};

export const DEFAULT_FIELD_DEFINITIONS: SeedDef[] = [
  // ---- Department ----
  { fieldKey: "dept_stt", groupName: "department", displayName: "STT", databaseField: "stt", importColumnName: "STT", fieldType: "NUMBER", sortOrder: 1, exportable: false },
  { fieldKey: "dept_name", groupName: "department", displayName: "Bộ phận (Dept.)", databaseField: "dept_name", importColumnName: "Dept.", aliases: ["Department", "Bộ phận"], required: true, searchable: true, sortOrder: 2 },
  { fieldKey: "dept_group", groupName: "department", displayName: "Nhóm (Group)", databaseField: "group_name", importColumnName: "Group", aliases: ["Nhóm"], searchable: true, sortOrder: 3 },
  { fieldKey: "dept_vn_name", groupName: "department", displayName: "Tên Tiếng Việt", databaseField: "vn_name", importColumnName: "Tên Tiếng Việt", aliases: ["Ten Tieng Viet"], sortOrder: 4 },
  { fieldKey: "dept_supervisor", groupName: "department", displayName: "Phụ trách tiếp nhận", databaseField: "supervisor", importColumnName: "Phụ Trách Lao Động", aliases: ["Người phụ trách", "Supervisor", "Phụ Trách Lao Động"], sortOrder: 5 },
  { fieldKey: "dept_supervisor_phone", groupName: "department", displayName: "SĐT phụ trách", databaseField: "supervisor_phone", importColumnName: "SĐT", aliases: ["Phone", "Điện thoại"], sortOrder: 6 },
  { fieldKey: "dept_note", groupName: "department", displayName: "Ghi chú", databaseField: "sheet_link", importColumnName: "Note here!", aliases: ["Ghi chú", "Note"], sortOrder: 7 },

  // ---- DW Data ----
  { fieldKey: "dw_code", groupName: "dw_data", displayName: "CODE", databaseField: "code", importColumnName: "CODE", searchable: true, sortOrder: 1 },
  { fieldKey: "dw_it_code", groupName: "dw_data", displayName: "IT CODE", databaseField: "it_code", importColumnName: "IT CODE", sortOrder: 2 },
  { fieldKey: "dw_old_code", groupName: "dw_data", displayName: "Old DW Code", databaseField: "old_dw_code", importColumnName: "OldDW_VLOOKUP", sortOrder: 3, exportable: false },
  { fieldKey: "dw_id_vlookup", groupName: "dw_data", displayName: "ID Vlookup", databaseField: "id_vlookup", importColumnName: "ID_VLOOKUP", sortOrder: 4, exportable: false },
  { fieldKey: "dw_full_name", groupName: "dw_data", displayName: "Họ và tên", databaseField: "full_name", importColumnName: "HỌ TÊN", aliases: ["Full Name", "Họ tên", "Ho ten"], required: true, searchable: true, sortOrder: 5 },
  { fieldKey: "dw_gender", groupName: "dw_data", displayName: "Giới tính", databaseField: "gender", importColumnName: "GENDER", aliases: ["Giới tính"], sortOrder: 6 },
  { fieldKey: "dw_bod", groupName: "dw_data", displayName: "Ngày sinh", databaseField: "bod", importColumnName: "BOD", aliases: ["Ngày sinh", "DOB"], sortOrder: 7 },
  { fieldKey: "dw_profile", groupName: "dw_data", displayName: "Profile", databaseField: "profile", importColumnName: "PROFILE", sortOrder: 8, exportable: false },
  { fieldKey: "dw_dktn", groupName: "dw_data", displayName: "ĐKTN", databaseField: "dktn", importColumnName: "ĐKTN", sortOrder: 9, exportable: false },
  { fieldKey: "dw_cccd", groupName: "dw_data", displayName: "CCCD", databaseField: "cccd", importColumnName: "ID No", aliases: ["CCCD", "Citizen ID", "Số CCCD"], required: true, searchable: true, sortOrder: 10 },
  { fieldKey: "dw_date_of_issue", groupName: "dw_data", displayName: "Ngày cấp", databaseField: "date_of_issue", importColumnName: "Date of issue", aliases: ["Ngày cấp"], sortOrder: 11, exportable: false },
  { fieldKey: "dw_place_of_issue", groupName: "dw_data", displayName: "Nơi cấp", databaseField: "place_of_issue", importColumnName: "Place of issue", aliases: ["Nơi cấp"], sortOrder: 12, exportable: false },
  { fieldKey: "dw_permanent_address", groupName: "dw_data", displayName: "Địa chỉ thường trú", databaseField: "permanent_address", importColumnName: "Permanent address", aliases: ["Địa chỉ thường trú"], sortOrder: 13 },
  { fieldKey: "dw_residential_address", groupName: "dw_data", displayName: "Địa chỉ hiện tại", databaseField: "residential_address", importColumnName: "Residential address", aliases: ["Địa chỉ hiện tại", "Địa chỉ"], searchable: true, sortOrder: 14 },
  { fieldKey: "dw_phone", groupName: "dw_data", displayName: "Số điện thoại", databaseField: "phone", importColumnName: "Phone number", aliases: ["Phone", "SĐT", "Mobile", "Điện thoại"], searchable: true, sortOrder: 15 },

  // ---- Daily Application ----
  { fieldKey: "da_timestamp", groupName: "daily_application", displayName: "Ngày đăng ký", databaseField: "reg_date", importColumnName: "Timepstamp", aliases: ["Timestamp", "Ngày ĐK"], required: true, sortable: true, sortOrder: 1 },
  { fieldKey: "da_cccd", groupName: "daily_application", displayName: "CCCD", databaseField: "cccd", importColumnName: "CCCD", aliases: ["ID No", "Citizen ID", "Số CCCD"], required: true, searchable: true, sortOrder: 2 },
  { fieldKey: "da_full_name", groupName: "daily_application", displayName: "Họ và tên", databaseField: "full_name", importColumnName: "Họ và tên", aliases: ["Full Name", "Họ tên"], required: true, searchable: true, sortOrder: 3 },
  { fieldKey: "da_gender", groupName: "daily_application", displayName: "Giới tính", databaseField: "gender", importColumnName: "Giới tính", aliases: ["Gender"], sortOrder: 4 },
  { fieldKey: "da_dob", groupName: "daily_application", displayName: "Ngày sinh", databaseField: "dob", importColumnName: "Năm sinh", aliases: ["DOB", "Ngày sinh"], sortOrder: 5 },
  { fieldKey: "da_age", groupName: "daily_application", displayName: "Tuổi", databaseField: "age", importColumnName: "Tuổi", aliases: ["Age"], sortOrder: 6 },
  { fieldKey: "da_phone", groupName: "daily_application", displayName: "SĐT", databaseField: "phone", importColumnName: "SĐT", aliases: ["Phone", "Phone Number", "Mobile", "Số điện thoại"], required: true, searchable: true, sortOrder: 7 },
  { fieldKey: "da_ethnicity", groupName: "daily_application", displayName: "Dân tộc", databaseField: "ethnicity", importColumnName: "Dân tộc", aliases: ["Ethnicity"], sortOrder: 8 },
  { fieldKey: "da_address", groupName: "daily_application", displayName: "Địa chỉ hiện tại", databaseField: "residential_address", importColumnName: " Địa chỉ", aliases: ["Địa chỉ hiện tại", "Địa chỉ", "Address"], searchable: true, sortOrder: 9 },
  { fieldKey: "da_permanent_address", groupName: "daily_application", displayName: "Địa chỉ thường trú", databaseField: "permanent_address", importColumnName: "Địa chỉ", aliases: ["Địa chỉ thường trú"], exportable: false, sortOrder: 10 },
  { fieldKey: "da_declared_type", groupName: "daily_application", displayName: "Cũ / Mới (tự khai)", databaseField: "declared_type", importColumnName: "Thông tin lao động", aliases: ["Cũ/Mới", "Loại lao động"], sortOrder: 11 },
  { fieldKey: "da_dw_match", groupName: "daily_application", displayName: "Cũ / Mới (đối chiếu DW)", databaseField: "dw_match", importColumnName: "DW Match", exportable: true, importable: false, filterable: true, sortOrder: 12 },
  { fieldKey: "da_dw_code", groupName: "daily_application", displayName: "Mã DW", databaseField: "dw_code", importColumnName: "Mã DW", importable: false, sortOrder: 13 },
  { fieldKey: "da_work_duration", groupName: "daily_application", displayName: "Thời gian đăng ký làm", databaseField: "work_duration", importColumnName: "Thời gian đăng ký làm", aliases: ["Thời gian làm việc"], sortOrder: 14, exportable: false },
  { fieldKey: "da_referral", groupName: "daily_application", displayName: "Kênh giới thiệu", databaseField: "referral_channel", importColumnName: "Kênh giới thiệu", aliases: ["Referral"], sortOrder: 15, exportable: false },
  { fieldKey: "da_dept", groupName: "daily_application", displayName: "Bộ phận", databaseField: "dept_id", importColumnName: "Bộ phận", aliases: ["Dept."], searchable: true, filterable: true, sortOrder: 16 },
  { fieldKey: "da_group", groupName: "daily_application", displayName: "Nhóm", databaseField: "dept_id", importColumnName: "Nhóm", aliases: ["Group"], sortOrder: 17 },
  { fieldKey: "da_status", groupName: "daily_application", displayName: "Trạng thái", databaseField: "status", importColumnName: "Trạng thái", importable: false, searchable: true, filterable: true, sortOrder: 18 },
  { fieldKey: "da_starting_date", groupName: "daily_application", displayName: "Ngày bắt đầu", databaseField: "starting_date", importColumnName: "Starting date (Date)", aliases: ["Ngày bắt đầu"], sortOrder: 19, exportable: false },
  { fieldKey: "da_appointment_list", groupName: "daily_application", displayName: "DS hẹn", databaseField: "appointment_list", importColumnName: "DS hẹn", sortOrder: 20, exportable: false },
  { fieldKey: "da_note", groupName: "daily_application", displayName: "Ghi chú", databaseField: "note_worker", importColumnName: "Ghi chú về lao động", aliases: ["Ghi chú", "Note"], sortOrder: 21 },
  { fieldKey: "da_vaccine", groupName: "daily_application", displayName: "Tiêm vaccine", databaseField: "vaccine", importColumnName: "Tiêm vacccine", sortOrder: 22, exportable: false },
  { fieldKey: "da_code_check", groupName: "daily_application", displayName: "Code check", databaseField: "code_check", importColumnName: "Code check", sortOrder: 23, exportable: false },
];
