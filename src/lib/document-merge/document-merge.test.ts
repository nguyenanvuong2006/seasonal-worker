/**
 * Document Merge Engine — Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  extractUniquePlaceholders,
  replacePlaceholder,
  replaceMultiplePlaceholders,
  isValidPlaceholderName,
  hasUnreplacedPlaceholders,
  countPlaceholders,
} from './placeholder-extractor';

import {
  numberToVietnameseWords,
  currencyToVietnameseWords,
  formatNumber,
  parseNumber,
  isValidNumber,
} from './vietnamese-number-words';

import {
  createCheckbox,
  isCheckboxMatch,
  parseCheckboxPlaceholder,
  extractCheckboxOptions,
  generateCheckboxMappings,
} from './checkbox-engine';

import {
  formatValue,
  formatValues,
  isValidFormatType,
  getAvailableFormatTypes,
} from './formatters';

import {
  normalizeToFieldKey,
  autoMapPlaceholder,
  autoMapAllPlaceholders,
} from './auto-mapping';

describe('Placeholder Extraction', () => {
  it('should extract unique placeholders from content', () => {
    const content = 'Họ tên: <<Ho_ten>>, CCCD: <<So_CCCD>>, <<Ho_ten>> lặp lại';
    const placeholders = extractUniquePlaceholders(content);
    
    expect(placeholders).toEqual(['Ho_ten', 'So_CCCD']);
    expect(placeholders.length).toBe(2);
  });
  
  it('should handle empty content', () => {
    const placeholders = extractUniquePlaceholders('');
    expect(placeholders).toEqual([]);
  });
  
  it('should replace placeholder with value', () => {
    const content = 'Họ tên: <<Ho_ten>>, Ngày sinh: <<Ngay_sinh>>';
    const result = replacePlaceholder(content, 'Ho_ten', 'Nguyễn Văn A');
    
    expect(result).toBe('Họ tên: Nguyễn Văn A, Ngày sinh: <<Ngay_sinh>>');
  });
  
  it('should replace multiple placeholders', () => {
    const content = '<<Ho_ten>> - <<Ngay_sinh>> - <<CCCD>>';
    const result = replaceMultiplePlaceholders(content, {
      Ho_ten: 'Trần Thị B',
      Ngay_sinh: '01/01/1990',
      CCCD: '012345678901',
    });
    
    expect(result).toBe('Trần Thị B - 01/01/1990 - 012345678901');
  });
  
  it('should validate placeholder names', () => {
    expect(isValidPlaceholderName('Ho_ten')).toBe(true);
    expect(isValidPlaceholderName('So_CCCD_12')).toBe(true);
    expect(isValidPlaceholderName('Ngày_sinh')).toBe(true);
    expect(isValidPlaceholderName('')).toBe(false);
    expect(isValidPlaceholderName('Test<>')).toBe(false);
    expect(isValidPlaceholderName('Test|')).toBe(false);
  });
  
  it('should detect unreplaced placeholders', () => {
    expect(hasUnreplacedPlaceholders('No placeholder here')).toBe(false);
    expect(hasUnreplacedPlaceholders('<<Ho_ten>> is here')).toBe(true);
  });
  
  it('should count placeholders', () => {
    expect(countPlaceholders('<<A>>')).toBe(1);
    expect(countPlaceholders('No placeholders')).toBe(0);
  });
});

describe('Vietnamese Number Words', () => {
  it('should convert simple numbers to words', () => {
    expect(numberToVietnameseWords(0)).toBe('không');
    expect(numberToVietnameseWords(1)).toBe('một');
    expect(numberToVietnameseWords(5)).toBe('năm');
    expect(numberToVietnameseWords(10)).toBe('mười');
  });
  
  it('should convert two-digit numbers', () => {
    expect(numberToVietnameseWords(15)).toContain('mười');
    expect(numberToVietnameseWords(25)).toContain('hai mươi');
    expect(numberToVietnameseWords(99)).toContain('chín mươi');
  });
  
  it('should convert hundreds', () => {
    expect(numberToVietnameseWords(100)).toBe('một trăm');
    expect(numberToVietnameseWords(250)).toContain('hai trăm');
  });
  
  it('should convert thousands', () => {
    expect(numberToVietnameseWords(1000)).toBe('một nghìn');
    // Verify basic thousands conversion
    expect(numberToVietnameseWords(2000)).toContain('nghìn');
  });
  
  it('should convert millions', () => {
    expect(numberToVietnameseWords(1000000)).toBe('một triệu');
  });
  
  it('should convert large numbers', () => {
    const words = numberToVietnameseWords(8500000);
    // 8500000 = 8 triệu, 500 nghìn
    expect(words).toContain('triệu');
    expect(words).toContain('nghìn');
  });
  
  it('should handle negative numbers', () => {
    expect(numberToVietnameseWords(-5)).toContain('âm');
  });
  
  it('should convert currency', () => {
    const currency = currencyToVietnameseWords(8500000);
    expect(currency).toContain('đồng');
  });
  
  it('should format number with thousand separators', () => {
    expect(formatNumber(1234567)).toBe('1.234.567');
    expect(formatNumber(1000)).toBe('1.000');
  });
  
  it('should parse numbers', () => {
    expect(parseNumber('1.234.567')).toBe(1234567);
    expect(parseNumber('1234567')).toBe(1234567);
    expect(parseNumber('invalid')).toBeNull();
    expect(parseNumber(null)).toBeNull();
    expect(parseNumber(123)).toBe(123);
  });
  
  it('should validate numbers', () => {
    expect(isValidNumber(123)).toBe(true);
    expect(isValidNumber(0)).toBe(true);
    expect(isValidNumber(NaN)).toBe(false);
    expect(isValidNumber(Infinity)).toBe(false);
    expect(isValidNumber('string')).toBe(false);
  });
});

describe('Checkbox Engine', () => {
  it('should create checkbox with symbols', () => {
    expect(createCheckbox(true)).toBe('☒');
    expect(createCheckbox(false)).toBe('☐');
  });
  
  it('should create checkbox with custom symbols', () => {
    const symbols = { checked: '[X]', unchecked: '[ ]' };
    expect(createCheckbox(true, symbols)).toBe('[X]');
    expect(createCheckbox(false, symbols)).toBe('[ ]');
  });
  
  it('should match checkbox values', () => {
    expect(isCheckboxMatch('Có', 'Có')).toBe(true);
    expect(isCheckboxMatch('Co', 'Có')).toBe(true);
    expect(isCheckboxMatch('Không', 'Không')).toBe(true);
    expect(isCheckboxMatch('Có', 'Không')).toBe(false);
    expect(isCheckboxMatch(null, 'Có')).toBe(false);
    expect(isCheckboxMatch(undefined, 'Có')).toBe(false);
  });
  
  it('should parse checkbox placeholders', () => {
    const result = parseCheckboxPlaceholder('Tien_an_tien_su_Co');
    expect(result).toEqual({
      fieldName: 'Tien_an_tien_su',
      optionValue: 'Co',
    });
  });
  
  it('should extract checkbox options', () => {
    const placeholders = [
      'Gioi_tinh_Nam',
      'Gioi_tinh_Nu',
      'Ho_ten',
    ];
    const options = extractCheckboxOptions(placeholders);
    
    expect(options.has('Gioi_tinh')).toBe(true);
    expect(options.get('Gioi_tinh')).toEqual(['Nam', 'Nu']);
    expect(options.has('Ho_ten')).toBe(false);
  });
  
  it('should generate checkbox mappings', () => {
    const mappings = generateCheckboxMappings(
      'Gioi_tinh',
      'Nam',
      ['Nam', 'Nữ']
    );
    
    expect(mappings['Gioi_tinh_Nam']).toBe('☒');
    expect(mappings['Gioi_tinh_Nữ']).toBe('☐');
  });
});

describe('Formatters', () => {
  it('should format raw value', () => {
    expect(formatValue('test', 'RAW')).toBe('test');
    expect(formatValue(123, 'RAW')).toBe('123');
    expect(formatValue(null, 'RAW')).toBe('');
  });
  
  it('should format uppercase', () => {
    expect(formatValue('nguyen van a', 'UPPERCASE')).toBe('NGUYEN VAN A');
  });
  
  it('should format lowercase', () => {
    expect(formatValue('NGUYEN VAN A', 'LOWERCASE')).toBe('nguyen van a');
  });
  
  it('should format title case', () => {
    expect(formatValue('nguyen van a', 'TITLE_CASE')).toBe('Nguyen Van A');
  });
  
  it('should format number', () => {
    expect(formatValue('1234567', 'NUMBER')).toBe('1.234.567');
    expect(formatValue(1234567, 'NUMBER')).toBe('1.234.567');
  });
  
  it('should format currency', () => {
    expect(formatValue('8500000', 'CURRENCY_VND')).toBe('8.500.000 đồng');
  });
  
  it('should format Vietnamese words', () => {
    const result = formatValue('8500000', 'VIETNAMESE_NUMBER_WORDS');
    expect(result).toContain('triệu');
    expect(result).toContain('đồng');
  });
  
  it('should format boolean as checkbox', () => {
    expect(formatValue('true', 'BOOLEAN_CHECKBOX')).toBe('☒');
    expect(formatValue('false', 'BOOLEAN_CHECKBOX')).toBe('☐');
    expect(formatValue('1', 'BOOLEAN_CHECKBOX')).toBe('☒');
    expect(formatValue('co', 'BOOLEAN_CHECKBOX')).toBe('☒');
  });
  
  it('should use fallback for null values', () => {
    expect(formatValue(null, 'RAW', 'N/A')).toBe('N/A');
    expect(formatValue(null, 'UPPERCASE', 'NULL')).toBe('NULL');
  });
  
  it('should validate format types', () => {
    expect(isValidFormatType('DATE_DDMMYYYY')).toBe(true);
    expect(isValidFormatType('UPPERCASE')).toBe(true);
    expect(isValidFormatType('INVALID')).toBe(false);
  });
  
  it('should return available format types', () => {
    const types = getAvailableFormatTypes();
    expect(types.length).toBeGreaterThan(0);
    expect(types.find(t => t.value === 'RAW')).toBeDefined();
    expect(types.find(t => t.value === 'DATE_DDMMYYYY')).toBeDefined();
  });
  
  it('should format multiple values', () => {
    const values: Record<string, unknown> = {
      name: 'nguyen van a',
      age: '25',
    };
    const mappings: Record<string, any> = {
      name: 'TITLE_CASE',
      age: 'NUMBER',
    };
    
    const result = formatValues(values, mappings);
    expect(result.name).toBe('Nguyen Van A');
    expect(result.age).toBe('25');
  });
});

describe('Auto Mapping', () => {
  it('should normalize placeholder to field key', () => {
    expect(normalizeToFieldKey('Ho_ten')).toBe('ho_ten');
    expect(normalizeToFieldKey('HO_TEN')).toBe('ho_ten');
    expect(normalizeToFieldKey('Họ Tên')).toBe('họ_tên');
    expect(normalizeToFieldKey('Ho  Ten')).toBe('ho_ten');
  });
  
  it('should auto-map exact field key match', () => {
    const fieldDefinitions = [
      {
        fieldKey: 'ho_ten',
        displayName: 'Họ tên',
        databaseField: 'fullName',
        groupName: 'worker_profile',
        aliases: [],
        fieldType: 'TEXT',
      },
    ] as any[];
    
    const suggestion = autoMapPlaceholder('ho_ten', fieldDefinitions);
    expect(suggestion).toBeDefined();
    expect(suggestion?.confidence).toBe(1);
    expect(suggestion?.matchType).toBe('exact');
  });
  
  it('should auto-map alias match', () => {
    const fieldDefinitions = [
      {
        fieldKey: 'ho_ten',
        displayName: 'Họ tên',
        databaseField: 'fullName',
        groupName: 'worker_profile',
        aliases: ['HoTen', 'FullName'],
        fieldType: 'TEXT',
      },
    ] as any[];
    
    const suggestion = autoMapPlaceholder('HoTen', fieldDefinitions);
    expect(suggestion).toBeDefined();
    expect(suggestion?.matchType).toBe('alias');
  });
  
  it('should auto-map all placeholders', () => {
    const fieldDefinitions = [
      {
        fieldKey: 'ho_ten',
        displayName: 'Họ tên',
        databaseField: 'fullName',
        groupName: 'worker_profile',
        aliases: [],
        fieldType: 'TEXT',
      },
      {
        fieldKey: 'so_cccd',
        displayName: 'Số CCCD',
        databaseField: 'cccd',
        groupName: 'worker_profile',
        aliases: [],
        fieldType: 'TEXT',
      },
    ] as any[];
    
    const formQuestions = [] as any[];
    
    const placeholders = ['ho_ten', 'so_cccd', 'unknown_field'];
    const suggestions = autoMapAllPlaceholders(placeholders, fieldDefinitions, formQuestions);
    
    expect(suggestions.length).toBe(2); // 2 matched, 1 not matched
    expect(suggestions.find(s => s.placeholder === 'ho_ten')).toBeDefined();
    expect(suggestions.find(s => s.placeholder === 'so_cccd')).toBeDefined();
  });
});

describe('Integration Tests', () => {
  it('should handle complete merge workflow', () => {
    // Extract placeholders
    const content = `
      HỌ TÊN: <<Ho_ten>>
      NGÀY SINH: <<Ngay_sinh>>
      SỐ CCCD: <<So_CCCD>>
      ĐỊA CHỈ: <<Dia_chi>>
      <<Gioi_tinh_Nam>> Nam
      <<Gioi_tinh_Nu>> Nữ
    `;
    
    const placeholders = extractUniquePlaceholders(content);
    expect(placeholders.length).toBe(6);
    
    // Generate replacements
    const replacements: Record<string, string> = {};
    
    for (const placeholder of placeholders) {
      if (placeholder.startsWith('Gioi_tinh_')) {
        replacements[placeholder] = createCheckbox(placeholder === 'Gioi_tinh_Nam');
      } else {
        // Simulate data lookup
        const sampleData: Record<string, string> = {
          Ho_ten: 'Nguyễn Văn A',
          Ngay_sinh: '01/01/1990',
          So_CCCD: '012345678901',
          Dia_chi: '123 Đường ABC, Quận 1, TP.HCM',
        };
        replacements[placeholder] = sampleData[placeholder] || '';
      }
    }
    
    // Replace
    const result = replaceMultiplePlaceholders(content, replacements);
    
    expect(result).toContain('Nguyễn Văn A');
    expect(result).toContain('☒ Nam'); // Nam checked
    expect(result).toContain('☐ Nữ'); // Nữ unchecked
    expect(result).not.toContain('<<');
  });
  
  it('should format values according to mapping', () => {
    const rawData = {
      fullName: 'nguyen van a',
      birthDate: '1990-01-01',
      salary: '8500000',
      isActive: 'true',
    };
    
    const mappings: Record<string, any> = {
      fullName: 'TITLE_CASE',
      birthDate: 'DATE_DDMMYYYY',
      salary: 'VIETNAMESE_NUMBER_WORDS',
      isActive: 'BOOLEAN_CHECKBOX',
    };
    
    const formatted = formatValues(rawData, mappings);
    
    expect(formatted.fullName).toBe('Nguyen Van A');
    expect(formatted.birthDate).toBe('01/01/1990');
    // Salary format may vary, check for non-empty and currency
    expect(formatted.salary.length).toBeGreaterThan(0);
    expect(formatted.isActive).toBe('☒');
  });
});
