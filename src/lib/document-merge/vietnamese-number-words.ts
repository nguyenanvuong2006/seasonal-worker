/**
 * Document Merge Engine — Vietnamese Number to Words Converter
 * 
 * Chuyển đổi số thành chữ viết bằng tiếng Việt.
 * Ví dụ: 8500000 → "Tám triệu năm trăm nghìn đồng"
 * 
 * Không gọi AI/API bên ngoài - deterministic server-side utility.
 */

// Đơn vị
const DON_VI = ['không', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín'];

// Hàng chục
const CHUC = ['không', 'mười', 'hai mươi', 'ba mươi', 'bốn mươi', 'năm mươi', 'sáu mươi', 'bảy mươi', 'tám mươi', 'chín mươi'];

// Hàng trăm
const TRAM = ['không trăm', 'một trăm', 'hai trăm', 'ba trăm', 'bốn trăm', 'năm trăm', 'sáu trăm', 'bảy trăm', 'tám trăm', 'chín trăm'];

// Tên đơn vị lớn
const LON = ['', 'nghìn', 'triệu', 'tỷ'];

/**
 * Chuyển một phần (tối đa 3 chữ số) thành chữ
 */
function doc_chu(number: number, isLast: boolean = false): string {
  if (number === 0) return '';
  
  let result = '';
  const hundred = Math.floor(number / 100);
  const tens = Math.floor((number % 100) / 10);
  const units = number % 10;
  
  // Xử lý hàng trăm
  if (hundred > 0) {
    result += TRAM[hundred];
  }
  
  // Xử lý hàng chục và đơn vị
  if (tens > 0) {
    if (tens === 1 && hundred === 0) {
      result += 'mười';
    } else {
      result += CHUC[tens];
    }
  }
  
  // Xử lý đơn vị
  if (units > 0) {
    if (tens === 0 && hundred > 0) {
      result += ' lẻ ';
    }
    if (tens > 1 && units === 1) {
      result += ' mốt';
    } else if (tens >= 1 && units === 5) {
      result += ' lăm';
    } else if (units === 4 && tens > 0) {
      result += ' tư';
    } else {
      result += ' ' + DON_VI[units];
    }
  }
  
  return result;
}

/**
 * Chuyển số nguyên thành chữ viết bằng tiếng Việt
 * @param num Số nguyên dương
 * @returns Chuỗi số viết bằng chữ
 */
export function numberToVietnameseWords(num: number): string {
  if (num === 0) return 'không';
  
  if (num < 0) {
    return 'âm ' + numberToVietnameseWords(Math.abs(num));
  }
  
  if (!Number.isInteger(num)) {
    return numberToVietnameseWords(Math.round(num));
  }
  
  // Giới hạn: tối đa 15 chữ số
  if (num > 999999999999999) {
    throw new Error('Số quá lớn để chuyển đổi (tối đa 999.999.999.999.999)');
  }
  
  // Xử lý trường hợp đặc biệt
  if (num === 10) return 'mười';
  if (num === 100) return 'một trăm';
  if (num === 1000) return 'một nghìn';
  if (num === 1000000) return 'một triệu';
  
  const numStr = num.toString();
  const length = numStr.length;
  const parts: string[] = [];
  
  // Xử lý từng nhóm 3 chữ số từ phải sang trái
  let index = 0; // 0 = hàng đơn vị, 1 = nghìn, 2 = triệu, 3 = tỷ...
  
  // Bắt đầu từ nhóm cuối cùng (3 chữ số bên phải)
  for (let i = length; i > 0; i -= 3) {
    const start = Math.max(0, i - 3);
    const partStr = numStr.slice(start, i);
    const partNum = parseInt(partStr, 10);
    
    // Thêm phần nếu có giá trị hoặc là phần cuối cùng (sẽ không bao giờ xảy ra vì num > 0)
    if (partNum > 0) {
      const lonName = LON[index % LON.length] || '';
      parts.unshift(doc_chu(partNum, index === 0) + (lonName ? ' ' + lonName : ''));
    }
    
    index++;
  }
  
  let result = parts.join(' ');
  return result.replace(/\s+/g, ' ').trim() || 'không';
}

/**
 * Chuyển số tiền thành chữ với đơn vị tiền tệ (đồng)
 * @param amount Số tiền
 * @param includeCurrency Có thêm "đồng" không (mặc định: có)
 * @returns Chuỗi số tiền viết bằng chữ
 */
export function currencyToVietnameseWords(amount: number, includeCurrency: boolean = true): string {
  const words = numberToVietnameseWords(Math.round(amount));
  return includeCurrency ? words + ' đồng' : words;
}

/**
 * Format số với dấu phân cách hàng nghìn
 */
export function formatNumber(num: number): string {
  return num.toLocaleString('vi-VN');
}

/**
 * Parse chuỗi thành số
 */
export function parseNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return isNaN(value) ? null : value;
  
  const cleaned = value.toString().replace(/\./g, '').replace(/,/g, '.');
  const num = parseFloat(cleaned);
  
  return isNaN(num) ? null : num;
}

/**
 * Kiểm tra xem giá trị có phải là số hợp lệ không
 */
export function isValidNumber(value: unknown): value is number {
  return typeof value === 'number' && !isNaN(value) && isFinite(value);
}
