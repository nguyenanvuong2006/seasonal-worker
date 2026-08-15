/**
 * Document Merge Engine — Placeholder Extraction
 * 
 * Quét Google Docs content để tìm tất cả placeholders theo pattern <<...>>
 */

/** Pattern để nhận diện placeholder: <<...>> */
export const PLACEHOLDER_PATTERN = /<<([^>]+)>>/g;

/** Loại bỏ duplicate placeholders */
export function extractUniquePlaceholders(content: string): string[] {
  const matches = content.matchAll(PLACEHOLDER_PATTERN);
  const unique = new Set<string>();
  
  for (const match of matches) {
    unique.add(match[1].trim());
  }
  
  return Array.from(unique).sort();
}

/** Kiểm tra xem một chuỗi có phải là placeholder hợp lệ không */
export function isPlaceholder(text: string): boolean {
  return /^<<[^>]+>>$/.test(text);
}

/** Extract placeholder name từ text có thể chứa thêm nội dung khác */
export function extractPlaceholderFromText(text: string): string | null {
  const match = text.match(/<<([^>]+)>>/);
  return match ? match[1].trim() : null;
}

/** Thay thế placeholder trong text bằng giá trị */
export function replacePlaceholder(
  content: string,
  placeholder: string,
  value: string
): string {
  const pattern = new RegExp(`<<${escapeRegex(placeholder)}>>`, 'g');
  return content.replace(pattern, value);
}

/** Thay thế nhiều placeholders cùng lúc */
export function replaceMultiplePlaceholders(
  content: string,
  replacements: Record<string, string>
): string {
  let result = content;
  
  for (const [placeholder, value] of Object.entries(replacements)) {
    result = replacePlaceholder(result, placeholder, value);
  }
  
  return result;
}

/** Escape special regex characters */
function escapeRegex(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Lấy danh sách placeholders chưa được map */
export function getUnmappedPlaceholders(
  allPlaceholders: string[],
  mappedPlaceholders: Set<string>
): string[] {
  return allPlaceholders.filter(p => !mappedPlaceholders.has(p));
}

/** Kiểm tra xem content có chứa placeholder chưa được thay thế không */
export function hasUnreplacedPlaceholders(content: string): boolean {
  return PLACEHOLDER_PATTERN.test(content);
}

/** Đếm số placeholder trong content */
export function countPlaceholders(content: string): number {
  const matches = content.match(PLACEHOLDER_PATTERN);
  return matches ? matches.length : 0;
}

/** Validate placeholder name theo convention */
export function isValidPlaceholderName(name: string): boolean {
  // Placeholder phải:
  // - Không trống
  // - Không chứa ký tự đặc biệt nguy hiểm
  // - Độ dài hợp lý
  if (!name || name.length === 0 || name.length > 255) return false;
  
  // Cho phép: chữ cái, số, dấu gạch dưới, khoảng trắng, tiếng Việt có dấu
  // Không cho phép: <> | \ / * ? " :
  return !/[<>|\\\/:*?"]/g.test(name);
}
