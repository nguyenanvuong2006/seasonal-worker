/**
 * Document Merge Engine — Checkbox Engine
 * 
 * Xử lý checkbox options cho merge documents.
 * Không tạo nhiều database column cho checkbox.
 * 
 * Ví dụ:
 * Source field: tien_an_tien_su = "Không"
 * Template placeholders:
 *   <<Tien_an_tien_su_Khong>> → ☒ (checked)
 *   <<Tien_an_tien_su_Co>> → ☐ (unchecked)
 */

/** Ký hiệu checkbox mặc định */
export const DEFAULT_CHECKBOX_SYMBOLS: CheckboxSymbols = {
  checked: '☒',
  unchecked: '☐',
};

/** Cấu hình checkbox symbols có thể tùy chỉnh */
export interface CheckboxSymbols {
  checked: string;
  unchecked: string;
}

/**
 * Tạo checkbox text với symbols tùy chỉnh
 */
export function createCheckbox(
  isChecked: boolean,
  symbols: CheckboxSymbols = DEFAULT_CHECKBOX_SYMBOLS
): string {
  return isChecked ? symbols.checked : symbols.unchecked;
}

/**
 * Kiểm tra xem checkbox option có match với source value không
 * 
 * @param sourceValue Giá trị từ database
 * @param optionValue Giá trị của checkbox option (ví dụ: "Có", "Không")
 * @returns true nếu checkbox nên được check
 */
export function isCheckboxMatch(
  sourceValue: string | null | undefined,
  optionValue: string | null | undefined
): boolean {
  if (sourceValue === null || sourceValue === undefined) return false;
  if (optionValue === null || optionValue === undefined) return false;
  
  // So sánh không phân biệt hoa thường và loại bỏ dấu
  const normalizedSource = normalizeVietnameseText(sourceValue.trim());
  const normalizedOption = normalizeVietnameseText(optionValue.trim());
  
  return normalizedSource === normalizedOption;
}

/**
 * Normalize Vietnamese text để so sánh
 */
function normalizeVietnameseText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Loại bỏ dấu
    .replace(/\s+/g, ' ')           // Loại bỏ khoảng trắng thừa
    .trim();
}

/**
 * Parse checkbox placeholder để lấy field name và option value
 * 
 * Ví dụ:
 *   "Tien_an_tien_su_Co" → { fieldName: "tien_an_tien_su", optionValue: "Co" }
 *   "Gioi_tinh_Nam" → { fieldName: "gioi_tinh", optionValue: "Nam" }
 */
export function parseCheckboxPlaceholder(placeholder: string): {
  fieldName: string;
  optionValue: string;
} | null {
  // Tìm vị trí của option cuối cùng (giả định option là từ cuối)
  // Trường hợp đặc biệt: có thể là dạng "field_option" với option viết hoa đầu
  
  // Thử tách bằng dấu gạch dưới
  const parts = placeholder.split('_');
  
  if (parts.length < 2) return null;
  
  // Option thường là phần cuối, field name là phần còn lại
  // Nhưng cần xử lý trường hợp field name có nhiều từ
  // VD: "Tien_an_tien_su" là field, "Co" là option
  // VD: "Gioi_tinh_Nam" → "Gioi_tinh" là field, "Nam" là option
  
  // Heuristic: nếu phần cuối là 1 từ ngắn (1-4 ký tự, bắt đầu bằng chữ hoa)
  // thì đó là option
  const lastPart = parts[parts.length - 1];
  const secondLastPart = parts[parts.length - 2];
  
  // Nếu phần cuối ngắn và phần trước đó cũng ngắn, có thể là option
  if (lastPart.length <= 4 && /^[A-ZÀÁÂÃÈÉÊÌÍÒÓÔÕÙÚĂĐĨŨƠƯ][a-zàáâãèéêìíòóôõùúăđĩũơư]?$/.test(lastPart)) {
    return {
      fieldName: parts.slice(0, -1).join('_'),
      optionValue: lastPart,
    };
  }
  
  // Fallback: giả định phần cuối là option
  return {
    fieldName: parts.slice(0, -1).join('_'),
    optionValue: lastPart,
  };
}

/**
 * Lấy tất cả checkbox options có thể có từ template placeholders
 */
export function extractCheckboxOptions(
  placeholders: string[]
): Map<string, string[]> {
  const checkboxFields = new Map<string, string[]>();
  
  for (const placeholder of placeholders) {
    const parsed = parseCheckboxPlaceholder(placeholder);
    if (parsed) {
      const { fieldName, optionValue } = parsed;
      
      if (!checkboxFields.has(fieldName)) {
        checkboxFields.set(fieldName, []);
      }
      
      const options = checkboxFields.get(fieldName)!;
      if (!options.includes(optionValue)) {
        options.push(optionValue);
      }
    }
  }
  
  return checkboxFields;
}

/**
 * Tạo checkbox mapping cho tất cả placeholders của một field
 */
export function generateCheckboxMappings(
  fieldName: string,
  sourceValue: string | null | undefined,
  options: string[],
  symbols: CheckboxSymbols = DEFAULT_CHECKBOX_SYMBOLS
): Record<string, string> {
  const mappings: Record<string, string> = {};
  
  for (const option of options) {
    const placeholder = `${fieldName}_${option}`;
    const isMatch = isCheckboxMatch(sourceValue, option);
    mappings[placeholder] = createCheckbox(isMatch, symbols);
  }
  
  return mappings;
}

/**
 * Common checkbox patterns
 */
export const COMMON_CHECKBOX_PATTERNS = {
  YES_NO: ['Có', 'Không'],
  GENDER: ['Nam', 'Nữ'],
  BOOLEAN: ['Có', 'Không'],
  TRUE_FALSE: ['Có', 'Không'],
  CONFIRM: ['Xác nhận', 'Không xác nhận'],
};
