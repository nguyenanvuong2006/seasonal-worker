/**
 * Document Merge Engine — Value Formatters
 * 
 * Hỗ trợ nhiều format types cho việc hiển thị giá trị trong documents.
 * Extensible architecture cho phép thêm formatter mới dễ dàng.
 */

import { currencyToVietnameseWords, formatNumber, parseNumber } from './vietnamese-number-words.ts';

/** Các loại format được hỗ trợ */
export type FormatType =
  | 'DATE_DDMMYYYY'
  | 'DATE_DD_MM_YYYY'
  | 'DATE_DDMMYYYY_HHMM'
  | 'UPPERCASE'
  | 'LOWERCASE'
  | 'TITLE_CASE'
  | 'NUMBER'
  | 'CURRENCY_VND'
  | 'VIETNAMESE_NUMBER_WORDS'
  | 'BOOLEAN_CHECKBOX'
  | 'RAW';

/** Cấu hình formatter */
export interface FormatterConfig {
  formatType: FormatType;
  locale?: string;
  timezone?: string;
}

/** Checkbox symbols */
const CHECKBOX = {
  CHECKED: '☒',
  UNCHECKED: '☐',
};

/** Null/empty value representation */
const NULL_PLACEHOLDER = '';

/** Timezone hiển thị chuẩn cho mọi ngày/giờ trong document — hệ thống dành cho Việt Nam. */
const DISPLAY_TIMEZONE = 'Asia/Ho_Chi_Minh';

/**
 * Trích day/month/year/hour/minute theo timezone Asia/Ho_Chi_Minh — KHÔNG
 * dùng Date.getDate()/getHours() (đọc theo timezone của TIẾN TRÌNH server,
 * không phải Việt Nam). Vercel Functions mặc định chạy UTC (không set TZ) —
 * với timestamptz có giờ thật (vd submittedAt, documentSentAt — khác hẳn cột
 * `date` thuần như regDate/startingDate/dob vốn không có time-of-day nên
 * không bị ảnh hưởng), 1 giá trị lúc 22:00 UTC là 05:00 sáng hôm SAU giờ
 * Việt Nam — đọc theo giờ server (UTC) sẽ in sai lùi 1 ngày so với ngày thật
 * người Việt Nam nhìn thấy trên đồng hồ. Dùng Intl.DateTimeFormat với
 * timeZone cố định để kết quả GIỐNG HỆT nhau dù server chạy ở UTC, giờ Việt
 * Nam, hay bất kỳ đâu.
 */
function extractDateParts(date: Date): { day: string; month: string; year: string; hours: string; minutes: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: DISPLAY_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  // Intl có thể trả "24" cho giờ nửa đêm khi hour12=false ở 1 số runtime —
  // chuẩn hoá về "00" để khớp định dạng 24h thông thường (00:00-23:59).
  const hours = get('hour') === '24' ? '00' : get('hour');
  return { day: get('day'), month: get('month'), year: get('year'), hours, minutes: get('minute') };
}

/**
 * Format date theo các pattern
 */
function formatDate(value: string | Date | null | undefined, pattern: string, fallbackValue?: string): string {
  if (!value) return fallbackValue ?? NULL_PLACEHOLDER;

  let date: Date;
  if (value instanceof Date) {
    date = value;
  } else if (typeof value === 'string') {
    // Thử parse various date formats
    date = new Date(value);
    if (isNaN(date.getTime())) {
      // Thử parse DD/MM/YYYY
      const parts = value.split(/[\/\-\.]/);
      if (parts.length === 3) {
        const day = parseInt(parts[0], 10);
        const month = parseInt(parts[1], 10) - 1;
        const year = parseInt(parts[2], 10);
        date = new Date(year, month, day);
      }
    }
  } else {
    return fallbackValue ?? NULL_PLACEHOLDER;
  }

  // Ngày không parse được (chuỗi rác) — trước đây luôn trả rỗng, bỏ qua
  // fallbackValue dù đã cấu hình (khác NUMBER/CURRENCY_VND, vốn dùng
  // fallbackValue đúng cho trường hợp này) — field required với dữ liệu
  // nguồn hỏng sẽ lặng lẽ in trống thay vì fallback đã cấu hình.
  if (isNaN(date.getTime())) return fallbackValue ?? NULL_PLACEHOLDER;

  const { day, month, year, hours, minutes } = extractDateParts(date);

  // Thay token trong 1 lần quét regex duy nhất — KHÔNG dùng .replace() nối
  // chuỗi tuần tự: pattern 'DD/MM/YYYY HH:mm' có 'MM' (tháng, hoa) và 'mm'
  // (phút, thường) khác nhau CHỈ ở chữ hoa/thường. .replace('MM', month) rồi
  // .replace('MM', minutes) tìm lại 'MM' hoa lần 2 — không còn khớp gì (chỉ
  // còn 'mm' thường) nên phút KHÔNG BAO GIỜ được thay, output giữ nguyên
  // literal "mm". Quét 1 lần bằng regex tránh hoàn toàn việc token này "ăn"
  // vào lượt thay của token khác.
  const tokens: Record<string, string> = { DD: day, MM: month, YYYY: year, HH: hours, mm: minutes };
  return pattern.replace(/DD|MM|YYYY|HH|mm/g, (token) => tokens[token]);
}

/**
 * Format text case
 */
function formatTextCase(value: string, caseType: 'UPPER' | 'LOWER' | 'TITLE'): string {
  if (!value) return NULL_PLACEHOLDER;
  
  switch (caseType) {
    case 'UPPER':
      return value.toUpperCase();
    case 'LOWER':
      return value.toLowerCase();
    case 'TITLE':
      return toTitleCase(value);
    default:
      return value;
  }
}

/**
 * Convert string to title case
 */
function toTitleCase(str: string): string {
  return str
    .toLowerCase()
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Format boolean thành checkbox
 */
function formatBooleanAsCheckbox(value: unknown): string {
  if (value === null || value === undefined) return CHECKBOX.UNCHECKED;
  
  const truthy = String(value).toLowerCase().trim();
  const trueValues = ['true', '1', 'yes', 'co', 'xac_nhan', 'confirmed', 'ok'];
  
  return trueValues.includes(truthy) ? CHECKBOX.CHECKED : CHECKBOX.UNCHECKED;
}

/**
 * Main formatter function
 */
export function formatValue(
  value: unknown,
  formatType: FormatType,
  fallbackValue?: string
): string {
  // Handle null/undefined
  if (value === null || value === undefined) {
    return fallbackValue ?? NULL_PLACEHOLDER;
  }
  
  const stringValue = String(value);
  
  switch (formatType) {
    case 'DATE_DDMMYYYY':
      return formatDate(stringValue, 'DD/MM/YYYY', fallbackValue);

    case 'DATE_DD_MM_YYYY':
      return formatDate(stringValue, 'DD-MM-YYYY', fallbackValue);

    case 'DATE_DDMMYYYY_HHMM':
      return formatDate(stringValue, 'DD/MM/YYYY HH:mm', fallbackValue);
      
    case 'UPPERCASE':
      return formatTextCase(stringValue, 'UPPER');
      
    case 'LOWERCASE':
      return formatTextCase(stringValue, 'LOWER');
      
    case 'TITLE_CASE':
      return formatTextCase(stringValue, 'TITLE');
      
    case 'NUMBER':
      const num = parseNumber(stringValue);
      return num !== null ? formatNumber(num) : (fallbackValue ?? stringValue);
      
    case 'CURRENCY_VND':
      const amount = parseNumber(stringValue);
      return amount !== null ? formatNumber(amount) + ' đồng' : (fallbackValue ?? stringValue);
      
    case 'VIETNAMESE_NUMBER_WORDS':
      const amountWords = parseNumber(stringValue);
      return amountWords !== null ? currencyToVietnameseWords(amountWords) : (fallbackValue ?? stringValue);
      
    case 'BOOLEAN_CHECKBOX':
      return formatBooleanAsCheckbox(value);
      
    case 'RAW':
    default:
      return stringValue;
  }
}

/**
 * Format multiple values với cùng format type
 */
export function formatValues(
  values: Record<string, unknown>,
  mappings: Record<string, FormatType>,
  fallbackValues?: Record<string, string>
): Record<string, string> {
  const results: Record<string, string> = {};
  
  for (const [key, value] of Object.entries(values)) {
    const formatType = mappings[key] ?? 'RAW';
    const fallback = fallbackValues?.[key];
    results[key] = formatValue(value, formatType, fallback);
  }
  
  return results;
}

/**
 * Kiểm tra format type có hợp lệ không
 */
export function isValidFormatType(type: string): type is FormatType {
  const validTypes: FormatType[] = [
    'DATE_DDMMYYYY',
    'DATE_DD_MM_YYYY',
    'DATE_DDMMYYYY_HHMM',
    'UPPERCASE',
    'LOWERCASE',
    'TITLE_CASE',
    'NUMBER',
    'CURRENCY_VND',
    'VIETNAMESE_NUMBER_WORDS',
    'BOOLEAN_CHECKBOX',
    'RAW',
  ];
  
  return validTypes.includes(type as FormatType);
}

/**
 * Lấy danh sách format types
 */
export function getAvailableFormatTypes(): { value: FormatType; label: string }[] {
  return [
    { value: 'RAW', label: 'Nguyên gốc' },
    { value: 'DATE_DDMMYYYY', label: 'Ngày (DD/MM/YYYY)' },
    { value: 'DATE_DD_MM_YYYY', label: 'Ngày (DD-MM-YYYY)' },
    { value: 'DATE_DDMMYYYY_HHMM', label: 'Ngày giờ (DD/MM/YYYY HH:mm)' },
    { value: 'UPPERCASE', label: 'IN HOA' },
    { value: 'LOWERCASE', label: 'in thường' },
    { value: 'TITLE_CASE', label: 'Viết hoa đầu từ' },
    { value: 'NUMBER', label: 'Số (có dấu phân cách)' },
    { value: 'CURRENCY_VND', label: 'Tiền VND' },
    { value: 'VIETNAMESE_NUMBER_WORDS', label: 'Số viết bằng chữ (Tiếng Việt)' },
    { value: 'BOOLEAN_CHECKBOX', label: 'Checkbox (☒/☐)' },
  ];
}

/** Registry cho custom formatters */
type CustomFormatter = (value: unknown, options?: Record<string, unknown>) => string;

const customFormatters: Map<string, CustomFormatter> = new Map();

/**
 * Đăng ký custom formatter
 */
export function registerCustomFormatter(
  name: string,
  formatter: CustomFormatter
): void {
  customFormatters.set(name, formatter);
}

/**
 * Gọi custom formatter
 */
export function callCustomFormatter(
  name: string,
  value: unknown,
  options?: Record<string, unknown>
): string {
  const formatter = customFormatters.get(name);
  if (!formatter) {
    throw new Error(`Custom formatter "${name}" not found`);
  }
  return formatter(value, options);
}
