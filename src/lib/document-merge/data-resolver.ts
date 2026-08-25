/**
 * Document Merge Engine — Data Resolver
 *
 * Resolve dữ liệu từ various sources để fill vào placeholders.
 * Hỗ trợ:
 * - CORE_FIELD: Trường từ database tables
 * - DYNAMIC_ANSWER: customAnswers từ form questions
 * - RELATED_FIELD: Trường từ bảng liên quan (JOIN)
 * - COMPUTED_FIELD: Giá trị tính toán (legacy fixed-enum computed values —
 *   CURRENT_DATE/AGE_FROM_DOB/DATE_DAY/...; sourceField chọn loại)
 * - COMPUTED: Safe Formula DSL V1 (H3) — sourcePath chứa MỘT biểu thức nhỏ,
 *   ví dụ `day(SigningDate)` hay `coalesce(SigningLocation, "Đà Lạt")`, chạy
 *   qua formula-dsl.ts (tokenize -> parse -> validate -> evaluate, KHÔNG bao
 *   giờ eval() JS thật) đối chiếu với Signing Context (signing-context.ts).
 *   Đây là loại NGUỒN MỚI, tách biệt với COMPUTED_FIELD ở trên — không đụng
 *   tới semantics cũ.
 * - SYSTEM_FIELD: Thông tin hệ thống (current user, timestamp, etc.)
 * - STATIC_TEXT: Giá trị tĩnh
 * - CHECKBOX_OPTION: Checkbox option matching
 */

import type { MergeTemplateField } from '../../db/schema';
import { formatValue, type FormatType } from './formatters.ts';
import { isCheckboxMatch } from './checkbox-engine.ts';
import { resolveFormula } from './formula-dsl.ts';
import { toFormulaContextValues, EMPTY_SIGNING_CONTEXT, type SigningContext } from './signing-context.ts';

/** Source types */
export type SourceType =
  | 'CORE_FIELD'
  | 'DYNAMIC_ANSWER'
  | 'RELATED_FIELD'
  | 'COMPUTED_FIELD'
  | 'COMPUTED'
  | 'SYSTEM_FIELD'
  | 'STATIC_TEXT'
  | 'CHECKBOX_OPTION';

/** Dữ liệu record cơ bản */
export interface RecordData {
  id?: string;
  cccd?: string;
  fullName?: string;
  [key: string]: unknown;
}

/** Computed field definitions */
export type ComputedFieldType =
  | 'CURRENT_DATE'
  | 'CURRENT_DATETIME'
  | 'CURRENT_USER'
  | 'CURRENT_YEAR'
  | 'AGE_FROM_DOB'
  | 'DAYS_SINCE_DATE'
  | 'DATE_DAY'
  | 'DATE_MONTH'
  | 'DATE_YEAR';

/** System field definitions */
export type SystemFieldType =
  | 'CURRENT_DATE'
  | 'CURRENT_DATETIME'
  | 'CURRENT_USER'
  | 'CURRENT_USER_NAME'
  | 'MERGE_COUNT'
  | 'MERGE_INDEX';

/** Context cho việc resolve dữ liệu */
export interface MergeContext {
  currentUserId?: string;
  currentUserName?: string;
  currentDate?: Date;
  mergeIndex?: number;
  mergeCount?: number;
  /**
   * H3 — deterministic Signing Context for COMPUTED (formula DSL) mappings.
   * Resolved ONCE by the caller (Preview) or frozen ONCE at merge-job
   * creation (async-job.ts) — never re-derived per record. See
   * signing-context.ts for the "why" (batch determinism).
   */
  signingContext?: SigningContext;
  [key: string]: unknown;
}

function readRecordPath(recordData: RecordData, path: string): unknown {
  const parts = path.split('.');
  let value: unknown = recordData;
  for (const part of parts) {
    if (value === null || value === undefined) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function datePart(value: unknown, part: 'day' | 'month' | 'year'): string {
  if (!value) return '';
  const raw = String(value).trim();
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    if (part === 'year') return iso[1];
    if (part === 'month') return iso[2];
    return iso[3];
  }
  const vi = raw.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (vi) {
    if (part === 'year') return vi[3];
    if (part === 'month') return vi[2].padStart(2, '0');
    return vi[1].padStart(2, '0');
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return '';
  if (part === 'year') return String(parsed.getFullYear());
  if (part === 'month') return String(parsed.getMonth() + 1).padStart(2, '0');
  return String(parsed.getDate()).padStart(2, '0');
}

/**
 * Resolve SYSTEM_FIELD
 */
export function resolveSystemField(
  field: MergeTemplateField,
  context: MergeContext
): string {
  const systemType = field.sourceField as SystemFieldType;
  const now = context.currentDate ?? new Date();
  
  switch (systemType) {
    case 'CURRENT_DATE':
      return formatValue(now, 'DATE_DDMMYYYY');
    case 'CURRENT_DATETIME':
      return formatValue(now, 'DATE_DDMMYYYY_HHMM');
    case 'CURRENT_USER':
      return context.currentUserId ?? '';
    case 'CURRENT_USER_NAME':
      return context.currentUserName ?? '';
    case 'MERGE_INDEX':
      return String(context.mergeIndex ?? 0);
    case 'MERGE_COUNT':
      return String(context.mergeCount ?? 0);
    default:
      return field.fallbackValue ?? '';
  }
}

/**
 * Resolve COMPUTED_FIELD
 */
export function resolveComputedField(
  field: MergeTemplateField,
  recordData: RecordData,
  context: MergeContext
): string {
  const computedType = field.sourceField as ComputedFieldType;
  
  switch (computedType) {
    case 'CURRENT_DATE':
      return formatValue(context.currentDate ?? new Date(), 'DATE_DDMMYYYY');
    case 'CURRENT_DATETIME':
      return formatValue(context.currentDate ?? new Date(), 'DATE_DDMMYYYY_HHMM');
    case 'CURRENT_YEAR':
      return String((context.currentDate ?? new Date()).getFullYear());
    case 'AGE_FROM_DOB': {
      const dob = recordData.dob as string | undefined;
      if (!dob) return field.fallbackValue ?? '';
      try {
        const birthDate = new Date(dob);
        const today = context.currentDate ?? new Date();
        let age = today.getFullYear() - birthDate.getFullYear();
        const monthDiff = today.getMonth() - birthDate.getMonth();
        if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
          age--;
        }
        return String(age);
      } catch {
        return field.fallbackValue ?? '';
      }
    }
    case 'DAYS_SINCE_DATE': {
      const dateField = field.sourcePath ?? 'createdAt';
      const dateValue = readRecordPath(recordData, dateField);
      if (!dateValue) return field.fallbackValue ?? '';
      try {
        const date = new Date(dateValue as string);
        const today = context.currentDate ?? new Date();
        const diffTime = today.getTime() - date.getTime();
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        return String(Math.max(0, diffDays));
      } catch {
        return field.fallbackValue ?? '';
      }
    }
    case 'DATE_DAY':
      return datePart(readRecordPath(recordData, field.sourcePath ?? 'startingDate'), 'day') || field.fallbackValue || '';
    case 'DATE_MONTH':
      return datePart(readRecordPath(recordData, field.sourcePath ?? 'startingDate'), 'month') || field.fallbackValue || '';
    case 'DATE_YEAR':
      return datePart(readRecordPath(recordData, field.sourcePath ?? 'startingDate'), 'year') || field.fallbackValue || '';
    default:
      return field.fallbackValue ?? '';
  }
}

/**
 * Resolve COMPUTED — Safe Formula DSL V1 (H3).
 *
 * `field.sourcePath` holds the raw expression (e.g. `day(SigningDate)`).
 * Runs through formula-dsl.ts's tokenize -> parse -> validate -> evaluate
 * pipeline against the frozen Signing Context — never a live wall-clock
 * read, never JS execution of any kind.
 *
 * NEVER THROWS. A syntax error, an unknown identifier, an invalid date, or
 * a genuinely-missing Signing Context value all collapse to the field's
 * fallbackValue (or "") — the exact same "resolve to empty, let the
 * required-field gate decide" contract every other source type already
 * follows (resolveCoreField, resolveComputedField, ...). This is what
 * guarantees a computed placeholder NEVER renders as a literal
 * `<<Ngay_ky_day>>` tag: resolveAllFields always supplies SOME string for
 * every non-orphaned placeholder, so substitution always finds a match.
 * A formula mistake in a REQUIRED placeholder is caught by
 * validateRequiredFields()/the pre-queue required-field gate exactly like a
 * missing CORE_FIELD value is (Phase 24) — the primary defense against a
 * broken expression is validating it BEFORE save (Mapping UI "Thử công
 * thức" -> parseFormula()), not a throw here.
 */
export function resolveComputedExpression(
  field: MergeTemplateField,
  context: MergeContext,
): string {
  const expression = field.sourcePath ?? '';
  if (!expression.trim()) return field.fallbackValue ?? '';

  const values = toFormulaContextValues(context.signingContext ?? EMPTY_SIGNING_CONTEXT);
  const result = resolveFormula(expression, values);
  if (!result.ok) return field.fallbackValue ?? '';
  return result.value || (field.fallbackValue ?? '');
}

/**
 * Resolve CORE_FIELD hoặc DYNAMIC_ANSWER từ record data
 */
export function resolveCoreField(
  field: MergeTemplateField,
  recordData: RecordData
): string {
  const sourcePath = field.sourcePath ?? field.sourceField ?? '';
  const value = readRecordPath(recordData, sourcePath);
  
  if (value === null || value === undefined) {
    return field.fallbackValue ?? '';
  }
  
  const formatType = (field.formatType ?? 'RAW') as FormatType;
  return formatValue(value, formatType, field.fallbackValue ?? '');
}

/**
 * Resolve CHECKBOX_OPTION
 */
export function resolveCheckboxOption(
  field: MergeTemplateField,
  recordData: RecordData
): string {
  const sourcePath = field.sourcePath ?? field.sourceField ?? '';
  const optionValue = field.optionValue ?? '';
  const value = readRecordPath(recordData, sourcePath);
  
  const isMatch = isCheckboxMatch(
    value as string | null | undefined,
    optionValue
  );
  
  return isMatch ? '☒' : '☐';
}

/**
 * Resolve STATIC_TEXT
 */
export function resolveStaticText(field: MergeTemplateField): string {
  return field.fallbackValue ?? '';
}

/**
 * Main resolve function
 */
export function resolveFieldValue(
  field: MergeTemplateField,
  recordData: RecordData,
  context: MergeContext
): string {
  const sourceType = field.sourceType as SourceType;
  
  switch (sourceType) {
    case 'SYSTEM_FIELD':
      return resolveSystemField(field, context);
    case 'COMPUTED_FIELD':
      return resolveComputedField(field, recordData, context);
    case 'COMPUTED':
      return resolveComputedExpression(field, context);
    case 'CHECKBOX_OPTION':
      return resolveCheckboxOption(field, recordData);
    case 'STATIC_TEXT':
      return resolveStaticText(field);
    case 'CORE_FIELD':
    case 'DYNAMIC_ANSWER':
    case 'RELATED_FIELD':
    default:
      return resolveCoreField(field, recordData);
  }
}

/**
 * Resolve tất cả fields cho một record
 */
export function resolveAllFields(
  fields: MergeTemplateField[],
  recordData: RecordData,
  context: MergeContext
): Record<string, string> {
  const results: Record<string, string> = {};
  
  for (const field of fields) {
    if (!field.isOrphaned) {
      results[field.placeholder] = resolveFieldValue(field, recordData, context);
    }
  }
  
  return results;
}

/**
 * Kiểm tra xem tất cả required fields có giá trị không
 */
export function validateRequiredFields(
  fields: MergeTemplateField[],
  values: Record<string, string>
): { valid: boolean; missingFields: string[] } {
  const missingFields: string[] = [];
  
  for (const field of fields) {
    if (field.isRequired) {
      const value = values[field.placeholder];
      if (!value || value.trim() === '') {
        missingFields.push(field.placeholder);
      }
    }
  }
  
  return {
    valid: missingFields.length === 0,
    missingFields,
  };
}

/**
 * Computed field definitions
 */
export const COMPUTED_FIELD_DEFINITIONS: {
  key: ComputedFieldType;
  label: string;
  description: string;
}[] = [
  { key: 'CURRENT_DATE', label: 'Ngày hiện tại', description: 'Ngày thực hiện merge (DD/MM/YYYY)' },
  { key: 'CURRENT_DATETIME', label: 'Ngày giờ hiện tại', description: 'Thời điểm thực hiện merge' },
  { key: 'CURRENT_YEAR', label: 'Năm hiện tại', description: 'Năm hiện tại (VD: 2026)' },
  { key: 'AGE_FROM_DOB', label: 'Tuổi từ ngày sinh', description: 'Tính tuổi từ trường dob' },
  { key: 'DAYS_SINCE_DATE', label: 'Số ngày từ ngày', description: 'Tính số ngày từ một ngày cụ thể' },
  { key: 'DATE_DAY', label: 'Ngày của một trường ngày', description: 'Lấy DD từ sourcePath (mặc định startingDate)' },
  { key: 'DATE_MONTH', label: 'Tháng của một trường ngày', description: 'Lấy MM từ sourcePath (mặc định startingDate)' },
  { key: 'DATE_YEAR', label: 'Năm của một trường ngày', description: 'Lấy YYYY từ sourcePath (mặc định startingDate)' },
];

/**
 * System field definitions
 */
export const SYSTEM_FIELD_DEFINITIONS: {
  key: SystemFieldType;
  label: string;
  description: string;
}[] = [
  { key: 'CURRENT_DATE', label: 'Ngày hiện tại', description: 'Ngày thực hiện merge' },
  { key: 'CURRENT_DATETIME', label: 'Ngày giờ hiện tại', description: 'Thời điểm thực hiện merge' },
  { key: 'CURRENT_USER', label: 'ID người dùng', description: 'ID của người thực hiện merge' },
  { key: 'CURRENT_USER_NAME', label: 'Tên người dùng', description: 'Tên của người thực hiện merge' },
  { key: 'MERGE_INDEX', label: 'Số thứ tự', description: 'Số thứ tự trong batch merge' },
  { key: 'MERGE_COUNT', label: 'Tổng số bản ghi', description: 'Tổng số bản ghi được merge' },
];
