/**
 * Document Merge Engine — Tests
 */

import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractUniquePlaceholders,
  replacePlaceholder,
  replaceMultiplePlaceholders,
  isValidPlaceholderName,
  hasUnreplacedPlaceholders,
  countPlaceholders,
} from './placeholder-extractor.ts';

import {
  numberToVietnameseWords,
  currencyToVietnameseWords,
  formatNumber,
  parseNumber,
  isValidNumber,
} from './vietnamese-number-words.ts';

import {
  createCheckbox,
  isCheckboxMatch,
  parseCheckboxPlaceholder,
  extractCheckboxOptions,
  generateCheckboxMappings,
} from './checkbox-engine.ts';

import {
  formatValue,
  formatValues,
  isValidFormatType,
  getAvailableFormatTypes,
} from './formatters.ts';

import {
  normalizeToFieldKey,
  autoMapPlaceholder,
  autoMapAllPlaceholders,
} from './auto-mapping.ts';

describe('Placeholder Extraction', () => {
  it('should extract unique placeholders from content', () => {
    const content = 'Họ tên: <<Ho_ten>>, CCCD: <<So_CCCD>>, <<Ho_ten>> lặp lại';
    const placeholders = extractUniquePlaceholders(content);
    
    assert.deepStrictEqual(placeholders, ['Ho_ten', 'So_CCCD']);
    assert.strictEqual(placeholders.length, 2);
  });
  
  it('should handle empty content', () => {
    const placeholders = extractUniquePlaceholders('');
    assert.deepStrictEqual(placeholders, []);
  });
  
  it('should replace placeholder with value', () => {
    const content = 'Họ tên: <<Ho_ten>>, Ngày sinh: <<Ngay_sinh>>';
    const result = replacePlaceholder(content, 'Ho_ten', 'Nguyễn Văn A');
    
    assert.strictEqual(result, 'Họ tên: Nguyễn Văn A, Ngày sinh: <<Ngay_sinh>>');
  });
  
  it('should replace multiple placeholders', () => {
    const content = '<<Ho_ten>> - <<Ngay_sinh>> - <<CCCD>>';
    const result = replaceMultiplePlaceholders(content, {
      Ho_ten: 'Trần Thị B',
      Ngay_sinh: '01/01/1990',
      CCCD: '012345678901',
    });
    
    assert.strictEqual(result, 'Trần Thị B - 01/01/1990 - 012345678901');
  });
  
  it('should validate placeholder names', () => {
    assert.strictEqual(isValidPlaceholderName('Ho_ten'), true);
    assert.strictEqual(isValidPlaceholderName('So_CCCD_12'), true);
    assert.strictEqual(isValidPlaceholderName('Ngày_sinh'), true);
    assert.strictEqual(isValidPlaceholderName(''), false);
    assert.strictEqual(isValidPlaceholderName('Test<>'), false);
    assert.strictEqual(isValidPlaceholderName('Test|'), false);
  });
  
  it('should detect unreplaced placeholders', () => {
    assert.strictEqual(hasUnreplacedPlaceholders('No placeholder here'), false);
    assert.strictEqual(hasUnreplacedPlaceholders('<<Ho_ten>> is here'), true);
  });
  
  it('should count placeholders', () => {
    assert.strictEqual(countPlaceholders('<<A>>'), 1);
    assert.strictEqual(countPlaceholders('No placeholders'), 0);
  });
});

describe('Vietnamese Number Words', () => {
  it('should convert simple numbers to words', () => {
    assert.strictEqual(numberToVietnameseWords(0), 'không');
    assert.strictEqual(numberToVietnameseWords(1), 'một');
    assert.strictEqual(numberToVietnameseWords(5), 'năm');
    assert.strictEqual(numberToVietnameseWords(10), 'mười');
  });
  
  it('should convert two-digit numbers', () => {
    assert.ok(numberToVietnameseWords(15).includes('mười'));
    assert.ok(numberToVietnameseWords(25).includes('hai mươi'));
    assert.ok(numberToVietnameseWords(99).includes('chín mươi'));
  });
  
  it('should convert hundreds', () => {
    assert.strictEqual(numberToVietnameseWords(100), 'một trăm');
    assert.ok(numberToVietnameseWords(250).includes('hai trăm'));
  });
  
  it('should convert thousands', () => {
    assert.strictEqual(numberToVietnameseWords(1000), 'một nghìn');
    assert.ok(numberToVietnameseWords(2000).includes('nghìn'));
  });
  
  it('should convert millions', () => {
    assert.strictEqual(numberToVietnameseWords(1000000), 'một triệu');
  });
  
  it('should convert large numbers', () => {
    const words = numberToVietnameseWords(8500000);
    assert.ok(words.includes('triệu'));
    assert.ok(words.includes('nghìn'));
  });
  
  it('should handle negative numbers', () => {
    assert.ok(numberToVietnameseWords(-5).includes('âm'));
  });
  
  it('should convert currency', () => {
    const currency = currencyToVietnameseWords(8500000);
    assert.ok(currency.includes('đồng'));
  });
  
  it('should format number with thousand separators', () => {
    assert.strictEqual(formatNumber(1234567), '1.234.567');
    assert.strictEqual(formatNumber(1000), '1.000');
  });
  
  it('should parse numbers', () => {
    assert.strictEqual(parseNumber('1.234.567'), 1234567);
    assert.strictEqual(parseNumber('1234567'), 1234567);
    assert.strictEqual(parseNumber('invalid'), null);
    assert.strictEqual(parseNumber(null), null);
    assert.strictEqual(parseNumber(123), 123);
  });
  
  it('should validate numbers', () => {
    assert.strictEqual(isValidNumber(123), true);
    assert.strictEqual(isValidNumber(0), true);
    assert.strictEqual(isValidNumber(NaN), false);
    assert.strictEqual(isValidNumber(Infinity), false);
    assert.strictEqual(isValidNumber('string'), false);
  });
});

describe('Checkbox Engine', () => {
  it('should create checkbox with symbols', () => {
    assert.strictEqual(createCheckbox(true), '☒');
    assert.strictEqual(createCheckbox(false), '☐');
  });
  
  it('should create checkbox with custom symbols', () => {
    const symbols = { checked: '[X]', unchecked: '[ ]' };
    assert.strictEqual(createCheckbox(true, symbols), '[X]');
    assert.strictEqual(createCheckbox(false, symbols), '[ ]');
  });
  
  it('should match checkbox values', () => {
    assert.strictEqual(isCheckboxMatch('Có', 'Có'), true);
    assert.strictEqual(isCheckboxMatch('Co', 'Có'), true);
    assert.strictEqual(isCheckboxMatch('Không', 'Không'), true);
    assert.strictEqual(isCheckboxMatch('Có', 'Không'), false);
    assert.strictEqual(isCheckboxMatch(null, 'Có'), false);
    assert.strictEqual(isCheckboxMatch(undefined, 'Có'), false);
  });
  
  it('should parse checkbox placeholders', () => {
    const result = parseCheckboxPlaceholder('Tien_an_tien_su_Co');
    assert.deepStrictEqual(result, {
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
    
    assert.strictEqual(options.has('Gioi_tinh'), true);
    assert.deepStrictEqual(options.get('Gioi_tinh'), ['Nam', 'Nu']);
    assert.strictEqual(options.has('Ho_ten'), false);
  });
  
  it('should generate checkbox mappings', () => {
    const mappings = generateCheckboxMappings(
      'Gioi_tinh',
      'Nam',
      ['Nam', 'Nữ']
    );
    
    assert.strictEqual(mappings['Gioi_tinh_Nam'], '☒');
    assert.strictEqual(mappings['Gioi_tinh_Nữ'], '☐');
  });
});

describe('Formatters', () => {
  it('should format raw value', () => {
    assert.strictEqual(formatValue('test', 'RAW'), 'test');
    assert.strictEqual(formatValue(123, 'RAW'), '123');
    assert.strictEqual(formatValue(null, 'RAW'), '');
  });
  
  it('should format uppercase', () => {
    assert.strictEqual(formatValue('nguyen van a', 'UPPERCASE'), 'NGUYEN VAN A');
  });
  
  it('should format lowercase', () => {
    assert.strictEqual(formatValue('NGUYEN VAN A', 'LOWERCASE'), 'nguyen van a');
  });
  
  it('should format title case', () => {
    assert.strictEqual(formatValue('nguyen van a', 'TITLE_CASE'), 'Nguyen Van A');
  });
  
  it('should format number', () => {
    assert.strictEqual(formatValue('1234567', 'NUMBER'), '1.234.567');
    assert.strictEqual(formatValue(1234567, 'NUMBER'), '1.234.567');
  });
  
  it('should format currency', () => {
    assert.strictEqual(formatValue('8500000', 'CURRENCY_VND'), '8.500.000 đồng');
  });
  
  it('should format Vietnamese words', () => {
    const result = formatValue('8500000', 'VIETNAMESE_NUMBER_WORDS');
    assert.ok(result.includes('triệu'));
    assert.ok(result.includes('đồng'));
  });
  
  it('should format boolean as checkbox', () => {
    assert.strictEqual(formatValue('true', 'BOOLEAN_CHECKBOX'), '☒');
    assert.strictEqual(formatValue('false', 'BOOLEAN_CHECKBOX'), '☐');
    assert.strictEqual(formatValue('1', 'BOOLEAN_CHECKBOX'), '☒');
    assert.strictEqual(formatValue('co', 'BOOLEAN_CHECKBOX'), '☒');
  });
  
  it('should use fallback for null values', () => {
    assert.strictEqual(formatValue(null, 'RAW', 'N/A'), 'N/A');
    assert.strictEqual(formatValue(null, 'UPPERCASE', 'NULL'), 'NULL');
  });
  
  it('should validate format types', () => {
    assert.strictEqual(isValidFormatType('DATE_DDMMYYYY'), true);
    assert.strictEqual(isValidFormatType('UPPERCASE'), true);
    assert.strictEqual(isValidFormatType('INVALID'), false);
  });
  
  it('should return available format types', () => {
    const types = getAvailableFormatTypes();
    assert.ok(types.length > 0);
    assert.ok(types.find(t => t.value === 'RAW') !== undefined);
    assert.ok(types.find(t => t.value === 'DATE_DDMMYYYY') !== undefined);
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
    assert.strictEqual(result.name, 'Nguyen Van A');
    assert.strictEqual(result.age, '25');
  });
});

describe('Auto Mapping', () => {
  it('should normalize placeholder to field key', () => {
    assert.strictEqual(normalizeToFieldKey('Ho_ten'), 'ho_ten');
    assert.strictEqual(normalizeToFieldKey('HO_TEN'), 'ho_ten');
    assert.strictEqual(normalizeToFieldKey('Họ Tên'), 'họ_tên');
    assert.strictEqual(normalizeToFieldKey('Ho  Ten'), 'ho_ten');
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
    assert.ok(suggestion !== null && suggestion !== undefined);
    assert.strictEqual(suggestion?.confidence, 1);
    assert.strictEqual(suggestion?.matchType, 'exact');
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
    assert.ok(suggestion !== null && suggestion !== undefined);
    assert.strictEqual(suggestion?.matchType, 'alias');
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
    
    assert.strictEqual(suggestions.length, 2);
    assert.ok(suggestions.find(s => s.placeholder === 'ho_ten') !== undefined);
    assert.ok(suggestions.find(s => s.placeholder === 'so_cccd') !== undefined);
  });
});

describe('Integration Tests', () => {
  it('should handle complete merge workflow', () => {
    const content = `
      HỌ TÊN: <<Ho_ten>>
      NGÀY SINH: <<Ngay_sinh>>
      SỐ CCCD: <<So_CCCD>>
      ĐỊA CHỈ: <<Dia_chi>>
      <<Gioi_tinh_Nam>> Nam
      <<Gioi_tinh_Nu>> Nữ
    `;
    
    const placeholders = extractUniquePlaceholders(content);
    assert.strictEqual(placeholders.length, 6);
    
    const replacements: Record<string, string> = {};
    
    for (const placeholder of placeholders) {
      if (placeholder.startsWith('Gioi_tinh_')) {
        replacements[placeholder] = createCheckbox(placeholder === 'Gioi_tinh_Nam');
      } else {
        const sampleData: Record<string, string> = {
          Ho_ten: 'Nguyễn Văn A',
          Ngay_sinh: '01/01/1990',
          So_CCCD: '012345678901',
          Dia_chi: '123 Đường ABC, Quận 1, TP.HCM',
        };
        replacements[placeholder] = sampleData[placeholder] || '';
      }
    }
    
    const result = replaceMultiplePlaceholders(content, replacements);
    
    assert.ok(result.includes('Nguyễn Văn A'));
    assert.ok(result.includes('☒ Nam'));
    assert.ok(result.includes('☐ Nữ'));
    assert.ok(!result.includes('<<'));
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
    
    assert.strictEqual(formatted.fullName, 'Nguyen Van A');
    assert.strictEqual(formatted.birthDate, '01/01/1990');
    assert.ok(formatted.salary.length > 0);
    assert.strictEqual(formatted.isActive, '☒');
  });
});
