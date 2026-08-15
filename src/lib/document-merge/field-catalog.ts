/**
 * Document Merge Engine — Field Catalog
 * 
 * Catalog của tất cả các field có thể được sử dụng trong merge.
 * Không expose các field nhạy cảm không được phép sử dụng.
 */

import type { FieldDefinition, FormQuestion } from '@/db/schema';
import { normalizeToFieldKey } from './auto-mapping.ts';

/** Field category */
export type FieldCategory =
  | 'worker_profile'
  | 'daily_application'
  | 'employment_session'
  | 'department'
  | 'dynamic_form'
  | 'computed'
  | 'system';

/** Một field trong catalog */
export interface CatalogField {
  fieldKey: string;
  label: string;
  category: FieldCategory;
  databaseSource: string;
  fieldType: string;
  aliases: string[];
  isMergeable: boolean;
  suggestedPlaceholder: string;
  description?: string;
  required?: boolean;
}

/** Field groups */
export const FIELD_CATALOG_GROUPS: {
  key: FieldCategory;
  label: string;
  description: string;
}[] = [
  { key: 'worker_profile', label: 'Hồ sơ Tập nghề', description: 'Thông tin từ bảng worker_profiles' },
  { key: 'daily_application', label: 'Đơn đăng ký', description: 'Thông tin từ bảng daily_applications' },
  { key: 'employment_session', label: 'Phiên làm việc', description: 'Thông tin từ bảng employment_sessions' },
  { key: 'department', label: 'Bộ phận', description: 'Thông tin từ bảng departments' },
  { key: 'dynamic_form', label: 'Câu hỏi động', description: 'Câu trả lời từ Dynamic Form' },
  { key: 'computed', label: 'Trường tính toán', description: 'Giá trị được tính toán tự động' },
  { key: 'system', label: 'Hệ thống', description: 'Thông tin từ hệ thống' },
];

/** Sensitive fields không được phép merge */
const SENSITIVE_FIELDS = new Set([
  'password',
  'password_hash',
  'session_version',
  'deleted_at',
  'deleted_by',
  'created_at',
  'updated_at',
  // PII fields cần RBAC check
  'cccd', // CCCD cần permission riêng
  'phone', // SĐT cần permission riêng
  'permanent_address', // Địa chỉ cần permission riêng
]);

/** Check if field has mergeable property */
function hasMergeable(obj: unknown): obj is { mergeable?: boolean } {
  return typeof obj === 'object' && obj !== null && 'mergeable' in obj;
}

/** Safe get aliases array */
function getAliases(obj: { aliases?: unknown }): string[] {
  if (Array.isArray(obj.aliases)) {
    return obj.aliases as string[];
  }
  return [];
}

/**
 * Check xem field có được phép merge không
 */
function isFieldMergeable(fieldKey: string): boolean {
  return !SENSITIVE_FIELDS.has(fieldKey.toLowerCase());
}

/**
 * Tạo suggested placeholder name từ field key
 */
function createSuggestedPlaceholder(fieldKey: string): string {
  return fieldKey
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join('_');
}

/**
 * Build catalog từ field definitions
 */
export function buildFieldCatalogFromDefinitions(
  fieldDefinitions: FieldDefinition[],
  formQuestions: FormQuestion[]
): CatalogField[] {
  const catalog: CatalogField[] = [];
  
  // Worker Profile fields
  for (const field of fieldDefinitions.filter(f => f.groupName === 'worker_profile')) {
    if (isFieldMergeable(field.databaseField)) {
      catalog.push({
        fieldKey: field.fieldKey,
        label: field.displayName,
        category: 'worker_profile',
        databaseSource: `worker_profiles.${field.databaseField}`,
        fieldType: field.fieldType,
        aliases: getAliases(field),
        isMergeable: hasMergeable(field) ? (field.mergeable ?? isFieldMergeable(field.fieldKey)) : isFieldMergeable(field.fieldKey),
        suggestedPlaceholder: createSuggestedPlaceholder(field.fieldKey),
        description: field.exportColumnName ?? undefined,
        required: field.required,
      });
    }
  }
  
  // Daily Application fields
  for (const field of fieldDefinitions.filter(f => f.groupName === 'daily_application')) {
    if (isFieldMergeable(field.databaseField)) {
      catalog.push({
        fieldKey: field.fieldKey,
        label: field.displayName,
        category: 'daily_application',
        databaseSource: `daily_applications.${field.databaseField}`,
        fieldType: field.fieldType,
        aliases: getAliases(field),
        isMergeable: hasMergeable(field) ? (field.mergeable ?? isFieldMergeable(field.fieldKey)) : isFieldMergeable(field.fieldKey),
        suggestedPlaceholder: createSuggestedPlaceholder(field.fieldKey),
        description: field.exportColumnName ?? undefined,
        required: field.required,
      });
    }
  }
  
  // Employment Session fields (hardcoded basics)
  const employmentSessionFields: { fieldKey: string; label: string; dbField: string; type: string }[] = [
    { fieldKey: 'reg_date', label: 'Ngày đăng ký', dbField: 'reg_date', type: 'DATE' },
    { fieldKey: 'status', label: 'Trạng thái', dbField: 'status', type: 'TEXT' },
    { fieldKey: 'starting_date', label: 'Ngày bắt đầu', dbField: 'starting_date', type: 'DATE' },
    { fieldKey: 'end_date', label: 'Ngày kết thúc', dbField: 'end_date', type: 'DATE' },
    { fieldKey: 'note', label: 'Ghi chú', dbField: 'note', type: 'TEXT' },
  ];
  
  for (const f of employmentSessionFields) {
    if (isFieldMergeable(f.dbField)) {
      catalog.push({
        fieldKey: f.fieldKey,
        label: f.label,
        category: 'employment_session',
        databaseSource: `employment_sessions.${f.dbField}`,
        fieldType: f.type,
        aliases: [],
        isMergeable: true,
        suggestedPlaceholder: createSuggestedPlaceholder(f.fieldKey),
      });
    }
  }
  
  // Department fields
  for (const field of fieldDefinitions.filter(f => f.groupName === 'department')) {
    if (isFieldMergeable(field.databaseField)) {
      catalog.push({
        fieldKey: field.fieldKey,
        label: field.displayName,
        category: 'department',
        databaseSource: `departments.${field.databaseField}`,
        fieldType: field.fieldType,
        aliases: getAliases(field),
        isMergeable: hasMergeable(field) ? (field.mergeable ?? isFieldMergeable(field.fieldKey)) : isFieldMergeable(field.fieldKey),
        suggestedPlaceholder: createSuggestedPlaceholder(field.fieldKey),
        description: field.exportColumnName ?? undefined,
        required: field.required,
      });
    }
  }
  
  // Dynamic Form fields
  for (const question of formQuestions.filter(q => q.isActive)) {
    catalog.push({
      fieldKey: question.fieldKey,
      label: question.questionText,
      category: 'dynamic_form',
      databaseSource: `customAnswers.${question.fieldKey}`,
      fieldType: question.fieldType,
      aliases: getAliases(question),
      isMergeable: !hasMergeable(question) || question.mergeable !== false,
      suggestedPlaceholder: createSuggestedPlaceholder(question.fieldKey),
      required: question.isRequired,
    });
  }
  
  // Computed fields
  const computedFields: { key: string; label: string; desc: string }[] = [
    { key: 'AGE_FROM_DOB', label: 'Tuổi (từ ngày sinh)', desc: 'Tính tuổi tự động từ dob' },
    { key: 'CURRENT_DATE', label: 'Ngày hiện tại', desc: 'Ngày thực hiện merge' },
    { key: 'CURRENT_YEAR', label: 'Năm hiện tại', desc: 'Năm hiện tại' },
  ];
  
  for (const cf of computedFields) {
    catalog.push({
      fieldKey: cf.key,
      label: cf.label,
      category: 'computed',
      databaseSource: `COMPUTED.${cf.key}`,
      fieldType: 'TEXT',
      aliases: [],
      isMergeable: true,
      suggestedPlaceholder: cf.label.replace(/\s+/g, '_').toUpperCase(),
      description: cf.desc,
    });
  }
  
  // System fields
  const systemFields: { key: string; label: string; desc: string }[] = [
    { key: 'CURRENT_USER_NAME', label: 'Người thực hiện', desc: 'Tên người dùng hiện tại' },
    { key: 'MERGE_INDEX', label: 'STT trong batch', desc: 'Số thứ tự bản ghi' },
    { key: 'MERGE_COUNT', label: 'Tổng số bản ghi', desc: 'Tổng số bản ghi trong batch' },
  ];
  
  for (const sf of systemFields) {
    catalog.push({
      fieldKey: sf.key,
      label: sf.label,
      category: 'system',
      databaseSource: `SYSTEM.${sf.key}`,
      fieldType: 'TEXT',
      aliases: [],
      isMergeable: true,
      suggestedPlaceholder: sf.label.replace(/\s+/g, '_').toUpperCase(),
      description: sf.desc,
    });
  }
  
  return catalog;
}

/**
 * Lọc catalog theo category
 */
export function filterCatalogByCategory(
  catalog: CatalogField[],
  categories: FieldCategory[]
): CatalogField[] {
  return catalog.filter(f => categories.includes(f.category));
}

/**
 * Tìm field trong catalog
 */
export function findFieldInCatalog(
  catalog: CatalogField[],
  fieldKey: string
): CatalogField | undefined {
  return catalog.find(
    f => f.fieldKey === fieldKey || 
         f.suggestedPlaceholder === fieldKey ||
         f.aliases.includes(fieldKey)
  );
}

/**
 * Lấy tất cả mergeable fields
 */
export function getMergeableFields(catalog: CatalogField[]): CatalogField[] {
  return catalog.filter(f => f.isMergeable);
}
