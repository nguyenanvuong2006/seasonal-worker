/**
 * Document Merge Engine — Auto Mapping Engine
 * 
 * Tự động gợi ý mapping dựa trên:
 * - fieldDefinitions.fieldKey
 * - databaseField
 * - displayName
 * - aliases
 * - Dynamic Form fieldKey
 * - aliases của formQuestions
 */

import type { FieldDefinition, FormQuestion } from '@/db/schema';

/** Kết quả của auto-mapping */
export interface AutoMappingSuggestion {
  placeholder: string;
  fieldKey: string;
  sourceEntity: string;
  sourceField: string;
  sourceType: 'CORE_FIELD' | 'DYNAMIC_ANSWER' | 'RELATED_FIELD' | 'COMPUTED_FIELD' | 'SYSTEM_FIELD';
  confidence: number; // 0-1
  matchType: 'exact' | 'alias' | 'fuzzy';
  suggestion: string;
}

/** Entity type cho source data */
export type SourceEntity = 
  | 'worker_profiles'
  | 'daily_applications'
  | 'employment_sessions'
  | 'departments'
  | 'custom_answers'
  | 'system';

/** Entity configuration */
const ENTITY_CONFIG: Record<SourceEntity, { table: string; label: string }> = {
  worker_profiles: { table: 'worker_profiles', label: 'Hồ sơ Tập nghề' },
  daily_applications: { table: 'daily_applications', label: 'Đơn đăng ký' },
  employment_sessions: { table: 'employment_sessions', label: 'Phiên làm việc' },
  departments: { table: 'departments', label: 'Bộ phận' },
  custom_answers: { table: 'customAnswers', label: 'Câu trả lời động' },
  system: { table: 'system', label: 'Hệ thống' },
};

/**
 * Normalize placeholder name thành field key format
 */
export function normalizeToFieldKey(placeholder: string): string {
  return placeholder
    .toLowerCase()
    .replace(/\s+/g, '_')           // Khoảng trắng → gạch dưới
    .replace(/_+/g, '_')           // Nhiều gạch dưới → 1
    .replace(/^_|_$/g, '');        // Trim gạch dưới đầu/cuối
}

/**
 * So sánh two strings với độ tương đồng
 */
function calculateSimilarity(str1: string, str2: string): number {
  const s1 = str1.toLowerCase();
  const s2 = str2.toLowerCase();
  
  if (s1 === s2) return 1;
  if (s1.includes(s2) || s2.includes(s1)) return 0.8;
  
  // Levenshtein distance
  const len1 = s1.length;
  const len2 = s2.length;
  const matrix: number[][] = [];
  
  for (let i = 0; i <= len1; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= len2; j++) {
    matrix[0][j] = j;
  }
  
  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  
  const maxLen = Math.max(len1, len2);
  return maxLen === 0 ? 1 : 1 - matrix[len1][len2] / maxLen;
}

/**
 * Tìm kiếm exact match trong aliases
 */
function findExactAliasMatch(
  placeholder: string,
  fieldDef: FieldDefinition
): boolean {
  const aliases: string[] = fieldDef.aliases ?? [];
  const normalizedPlaceholder = normalizeToFieldKey(placeholder);
  
  return aliases.some(alias => normalizeToFieldKey(alias) === normalizedPlaceholder);
}

/**
 * Tìm kiếm exact match trong form question
 */
function findExactFormQuestionMatch(
  placeholder: string,
  formQuestion: FormQuestion
): boolean {
  const aliases: string[] = formQuestion.aliases ?? [];
  const normalizedPlaceholder = normalizeToFieldKey(placeholder);
  
  return (
    normalizeToFieldKey(formQuestion.fieldKey) === normalizedPlaceholder ||
    aliases.some(alias => normalizeToFieldKey(alias) === normalizedPlaceholder)
  );
}

/**
 * Auto-map một placeholder với field definitions
 */
export function autoMapPlaceholder(
  placeholder: string,
  fieldDefinitions: FieldDefinition[]
): AutoMappingSuggestion | null {
  const normalizedPlaceholder = normalizeToFieldKey(placeholder);
  
  for (const fieldDef of fieldDefinitions) {
    // 1. Exact match với fieldKey
    if (normalizeToFieldKey(fieldDef.fieldKey) === normalizedPlaceholder) {
      return {
        placeholder,
        fieldKey: fieldDef.fieldKey,
        sourceEntity: fieldDef.groupName as SourceEntity,
        sourceField: fieldDef.databaseField,
        sourceType: 'CORE_FIELD',
        confidence: 1.0,
        matchType: 'exact',
        suggestion: `${fieldDef.fieldKey} → ${fieldDef.databaseField}`,
      };
    }
    
    // 2. Exact match với databaseField
    if (normalizeToFieldKey(fieldDef.databaseField) === normalizedPlaceholder) {
      return {
        placeholder,
        fieldKey: fieldDef.fieldKey,
        sourceEntity: fieldDef.groupName as SourceEntity,
        sourceField: fieldDef.databaseField,
        sourceType: 'CORE_FIELD',
        confidence: 0.95,
        matchType: 'exact',
        suggestion: `${placeholder} → ${fieldDef.databaseField}`,
      };
    }
    
    // 3. Match với aliases
    if (findExactAliasMatch(placeholder, fieldDef)) {
      return {
        placeholder,
        fieldKey: fieldDef.fieldKey,
        sourceEntity: fieldDef.groupName as SourceEntity,
        sourceField: fieldDef.databaseField,
        sourceType: 'CORE_FIELD',
        confidence: 0.95,
        matchType: 'alias',
        suggestion: `${placeholder} (alias) → ${fieldDef.fieldKey}`,
      };
    }
    
    // 4. Fuzzy match với displayName
    const similarity = calculateSimilarity(normalizedPlaceholder, normalizeToFieldKey(fieldDef.displayName));
    if (similarity > 0.7) {
      return {
        placeholder,
        fieldKey: fieldDef.fieldKey,
        sourceEntity: fieldDef.groupName as SourceEntity,
        sourceField: fieldDef.databaseField,
        sourceType: 'CORE_FIELD',
        confidence: similarity,
        matchType: 'fuzzy',
        suggestion: `${placeholder} (fuzzy) → ${fieldDef.displayName}`,
      };
    }
  }
  
  return null;
}

/**
 * Auto-map một placeholder với form questions (Dynamic Form)
 */
export function autoMapFormQuestionPlaceholder(
  placeholder: string,
  formQuestions: FormQuestion[]
): AutoMappingSuggestion | null {
  const normalizedPlaceholder = normalizeToFieldKey(placeholder);
  
  for (const question of formQuestions) {
    // 1. Exact match với fieldKey
    if (normalizeToFieldKey(question.fieldKey) === normalizedPlaceholder) {
      return {
        placeholder,
        fieldKey: question.fieldKey,
        sourceEntity: 'custom_answers',
        sourceField: question.fieldKey,
        sourceType: 'DYNAMIC_ANSWER',
        confidence: 1.0,
        matchType: 'exact',
        suggestion: `${placeholder} → customAnswers.${question.fieldKey}`,
      };
    }
    
    // 2. Match với aliases
    if (findExactFormQuestionMatch(placeholder, question)) {
      return {
        placeholder,
        fieldKey: question.fieldKey,
        sourceEntity: 'custom_answers',
        sourceField: question.fieldKey,
        sourceType: 'DYNAMIC_ANSWER',
        confidence: 0.95,
        matchType: 'alias',
        suggestion: `${placeholder} (alias) → customAnswers.${question.fieldKey}`,
      };
    }
  }
  
  return null;
}

/**
 * Auto-map tất cả placeholders với field definitions và form questions
 */
export function autoMapAllPlaceholders(
  placeholders: string[],
  fieldDefinitions: FieldDefinition[],
  formQuestions: FormQuestion[]
): AutoMappingSuggestion[] {
  const suggestions: AutoMappingSuggestion[] = [];
  const mappedPlaceholders = new Set<string>();
  
  // Ưu tiên 1: Exact match với field definitions
  for (const placeholder of placeholders) {
    const suggestion = autoMapPlaceholder(placeholder, fieldDefinitions);
    if (suggestion && !mappedPlaceholders.has(placeholder)) {
      suggestions.push(suggestion);
      mappedPlaceholders.add(placeholder);
    }
  }
  
  // Ưu tiên 2: Exact match với form questions
  for (const placeholder of placeholders) {
    if (mappedPlaceholders.has(placeholder)) continue;
    
    const suggestion = autoMapFormQuestionPlaceholder(placeholder, formQuestions);
    if (suggestion) {
      suggestions.push(suggestion);
      mappedPlaceholders.add(placeholder);
    }
  }
  
  // Ưu tiên 3: Fuzzy match
  for (const placeholder of placeholders) {
    if (mappedPlaceholders.has(placeholder)) continue;
    
    // Thử fuzzy match với field definitions trước
    let bestSuggestion: AutoMappingSuggestion | null = null;
    let bestSimilarity = 0;
    
    for (const fieldDef of fieldDefinitions) {
      const normalizedPlaceholder = normalizeToFieldKey(placeholder);
      const similarity = calculateSimilarity(
        normalizedPlaceholder,
        normalizeToFieldKey(fieldDef.fieldKey)
      );
      
      if (similarity > bestSimilarity && similarity > 0.6) {
        bestSimilarity = similarity;
        bestSuggestion = {
          placeholder,
          fieldKey: fieldDef.fieldKey,
          sourceEntity: fieldDef.groupName as SourceEntity,
          sourceField: fieldDef.databaseField,
          sourceType: 'CORE_FIELD',
          confidence: similarity,
          matchType: 'fuzzy',
          suggestion: `${placeholder} → ${fieldDef.displayName} (${Math.round(similarity * 100)}%)`,
        };
      }
    }
    
    if (bestSuggestion) {
      suggestions.push(bestSuggestion);
      mappedPlaceholders.add(placeholder);
    }
  }
  
  return suggestions;
}

/**
 * Lấy danh sách field keys đã được map
 */
export function getMappedFieldKeys(
  suggestions: AutoMappingSuggestion[]
): Map<string, AutoMappingSuggestion> {
  const map = new Map<string, AutoMappingSuggestion>();
  
  for (const suggestion of suggestions) {
    if (!map.has(suggestion.fieldKey)) {
      map.set(suggestion.fieldKey, suggestion);
    }
  }
  
  return map;
}
