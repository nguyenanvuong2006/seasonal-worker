/**
 * Document Merge Engine — Data Resolver
 * 
 * Resolve dữ liệu từ various sources để fill vào placeholders.
 * Hỗ trợ:
 * - CORE_FIELD: Trường từ database tables
 * - DYNAMIC_ANSWER: customAnswers từ form questions
 * - RELATED_FIELD: Trường từ bảng liên quan (JOIN)
 * - COMPUTED_FIELD: Giá trị tính toán
 * - SYSTEM_FIELD: Thông tin hệ thống (current user, timestamp, etc.)
 * - STATIC_TEXT: Giá trị tĩnh
 * - CHECKBOX_OPTION: Checkbox option matching
 */

import type { MergeTemplateField } from '@/db/schema';
import { formatValue, type FormatType } from './formatters.ts';
import { isCheckboxMatch, parseCheckboxPlaceholder } from './checkbox-engine.ts';

/** Source types */
export type SourceType =
  | 'CORE_FIELD'
  | 'DYNAMIC_ANSWER'
  | 'RELATED_FIELD'
  | 'COMPUTED_FIELD'
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
  | 'DAYS_SINCE_DATE';

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
  [key: string]: unknown;
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
      const dateValue = recordData[dateField];
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
    default:
      return field.fallbackValue ?? '';
  }
}

/**
 * Resolve CORE_FIELD hoặc DYNAMIC_ANSWER từ record data
 */
export function resolveCoreField(
  field: MergeTemplateField,
  recordData: RecordData
): string {
  const sourcePath = field.sourcePath ?? field.sourceField ?? '';
  
  // Hỗ trợ nested path như "worker_profiles.fullName"
  const pathParts = sourcePath.split('.');
  let value: unknown = recordData;
  
  for (const part of pathParts) {
    if (value === null || value === undefined) break;
    value = (value as Record<string, unknown>)[part];
  }
  
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
  
  // Lấy giá trị từ record
  const pathParts = sourcePath.split('.');
  let value: unknown = recordData;
  
  for (const part of pathParts) {
    if (value === null || value === undefined) break;
    value = (value as Record<string, unknown>)[part];
  }
  
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
