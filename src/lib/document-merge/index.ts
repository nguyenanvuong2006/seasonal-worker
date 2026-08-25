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
} from './placeholder-extractor.ts';

// Vietnamese number words
export {
  numberToVietnameseWords,
  currencyToVietnameseWords,
  formatNumber,
  parseNumber,
  isValidNumber,
} from './vietnamese-number-words.ts';

// Canonical HTML template contracts
export {
  validateTemplateContract,
  validateContractRequiredValues,
  validateContractRequiredMappings,
  type TemplateContract,
  type TemplateFieldContract,
  type TemplateFieldValueKind,
} from './template-contract.ts';

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
} from './checkbox-engine.ts';

// Auto mapping
export {
  autoMapPlaceholder,
  autoMapFormQuestionPlaceholder,
  autoMapAllPlaceholders,
  getMappedFieldKeys,
  normalizeToFieldKey,
  type AutoMappingSuggestion,
  type SourceEntity,
} from './auto-mapping.ts';

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
} from './formatters.ts';

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
} from './data-resolver.ts';

// Field catalog
export {
  buildFieldCatalogFromDefinitions,
  filterCatalogByCategory,
  findFieldInCatalog,
  getMergeableFields,
  FIELD_CATALOG_GROUPS,
  type CatalogField,
  type FieldCategory,
} from './field-catalog.ts';

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
} from './google-docs-service.ts';

// Dual-template routing (Tài liệu A / Tài liệu B)
export {
  DOCUMENT_KIND_META,
  extractGoogleDocId,
  googleDocEditUrl,
  googleDocPdfUrl,
  googleDocPreviewUrl,
  documentKindLabel,
  isReturningWorker,
  resolveDocumentKind,
  resolveDwClassification,
  selectTemplateForApplicant,
  selectTemplateForKind,
  type DocumentKind,
  type DwClassification,
} from './template-routing.ts';

// Preview + fallback placeholders
export {
  FALLBACK_PLACEHOLDER_MAP,
  applyFallbackPlaceholders,
  buildPreviewContent,
  countPageBreaks,
  joinWithPageBreaks,
} from './preview-merge.ts';

// Placeholder aliases (shared by the fallback resolver + the Template Diff Engine)
export {
  FALLBACK_PLACEHOLDER_MAP as ALIAS_FALLBACK_PLACEHOLDER_MAP,
  CUSTOM_ANSWER_PLACEHOLDER_MAP,
  SOURCE_FIELD_LABELS,
} from './placeholder-aliases.ts';

// Template Diff Engine — read-only change analysis for a DRAFT vs its base.
export {
  buildTemplateDiff,
  extractPlaceholderSet,
  compareMappingSemantics,
  toMappingSemantics,
  suggestDeterministicMapping,
  sourceFieldLabel,
  MAPPING_SEMANTIC_FIELDS,
  type MappingSemantics,
  type PlaceholderChangeKind,
  type PlaceholderDiffItem,
  type PlaceholderDiffSummary,
  type TemplateDiffInput,
  type TemplateDiffResult,
  type MappingSuggestion,
} from './template-diff.ts';

// Electronic signature / confirmation
export {
  MAX_SIGNATURE_DATA_URL_LENGTH,
  isValidSignatureDataUrl,
  normalizeConfirmedAnswersInput,
  validateConfirmedAnswers,
} from './signature.ts';

// Flattened applicant record
export { buildApplicantMergeRecord } from './applicant-record.ts';
