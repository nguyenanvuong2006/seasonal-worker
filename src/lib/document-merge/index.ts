/**
 * Document Merge Engine — Library Index
 * 
 * Export all public functions and types
 */

// Placeholder extraction
export {
  extractUniquePlaceholders,
  isPlaceholder,
  extractPlaceholderFromText,
  replacePlaceholder,
  replaceMultiplePlaceholders,
  getUnmappedPlaceholders,
  hasUnreplacedPlaceholders,
  countPlaceholders,
  isValidPlaceholderName,
  PLACEHOLDER_PATTERN,
} from './placeholder-extractor';

// Vietnamese number words
export {
  numberToVietnameseWords,
  currencyToVietnameseWords,
  formatNumber,
  parseNumber,
  isValidNumber,
} from './vietnamese-number-words';

// Checkbox engine
export {
  DEFAULT_CHECKBOX_SYMBOLS,
  createCheckbox,
  isCheckboxMatch,
  parseCheckboxPlaceholder,
  extractCheckboxOptions,
  generateCheckboxMappings,
  COMMON_CHECKBOX_PATTERNS,
  type CheckboxSymbols,
} from './checkbox-engine';

// Auto mapping
export {
  autoMapPlaceholder,
  autoMapFormQuestionPlaceholder,
  autoMapAllPlaceholders,
  getMappedFieldKeys,
  normalizeToFieldKey,
  type AutoMappingSuggestion,
  type SourceEntity,
} from './auto-mapping';

// Formatters
export {
  formatValue,
  formatValues,
  isValidFormatType,
  getAvailableFormatTypes,
  registerCustomFormatter,
  callCustomFormatter,
  type FormatType,
  type FormatterConfig,
} from './formatters';

// Data resolver
export {
  resolveFieldValue,
  resolveAllFields,
  validateRequiredFields,
  resolveSystemField,
  resolveComputedField,
  resolveCoreField,
  resolveCheckboxOption,
  COMPUTED_FIELD_DEFINITIONS,
  SYSTEM_FIELD_DEFINITIONS,
  type SourceType,
  type RecordData,
  type MergeContext,
} from './data-resolver';

// Field catalog
export {
  buildFieldCatalogFromDefinitions,
  filterCatalogByCategory,
  findFieldInCatalog,
  getMergeableFields,
  FIELD_CATALOG_GROUPS,
  type CatalogField,
  type FieldCategory,
} from './field-catalog';

// Google Docs service
export {
  createGoogleDocsService,
  MockGoogleDocsService,
  RealGoogleDocsService,
  replacePlaceholdersInContent,
  mergeRecordsToDocument,
  PAGE_BREAK_TEXT,
  type GoogleDocsService,
  type PlaceholderReplacement,
} from './google-docs-service';
