/* ============================================================
   ORGANIZATION TREE — PATH MATH (thuần, không DB)
   ------------------------------------------------------------
   Mọi tính toán trên `organization_units.path` (kiểu Postgres `ltree`,
   dạng "root.daton.prodpack.production.cutflowers.chry.spray.fast.harvesting")
   PHẢI đi qua module này — không viết lại rải rác ở route/UI.

   ltree label chỉ cho phép chữ, số, dấu gạch dưới (KHÔNG khoảng trắng,
   KHÔNG dấu, KHÔNG gạch ngang) — khác với `code` (varchar tự do, hiển
   thị cho người dùng). `slugifyPathLabel` xử lý đúng ràng buộc này,
   `slugifyCode` xử lý ràng buộc của cột `code`.

   KHÔNG có khái niệm "độ sâu tối đa" hay "loại node nào bắt buộc phải
   có con/không có con" ở đây — unit_type CHỈ là metadata mô tả (đề bài
   mục 3). Một Section có thể là leaf; một Group có thể có 5 tầng con
   nữa bên dưới.
   ============================================================ */

export const ORG_UNIT_TYPES = [
  "COMPANY",
  "LOCATION",
  "DIVISION",
  "DEPARTMENT",
  "SECTION",
  "GROUP",
  "TEAM",
  "UNIT",
  "AREA",
  "FARM",
  "FACTORY",
  "LINE",
  "OTHER",
] as const;
export type OrgUnitType = (typeof ORG_UNIT_TYPES)[number];

export const PATH_SEPARATOR = ".";
export const CODE_MAX_LENGTH = 64;
const PATH_LABEL_MAX_LENGTH = 256; // giới hạn thật của ltree label

/** Bỏ dấu tiếng Việt — dùng chung cho slugifyCode/slugifyPathLabel. */
function stripDiacritics(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // combining diacritical marks
    .replace(/\u0111/g, "d") // đ
    .replace(/\u0110/g, "D"); // Đ
}

/** Chuẩn hoá thành 1 label ltree hợp lệ: chỉ [a-z0-9_], không rỗng. */
export function slugifyPathLabel(input: string, fallback = "unit"): string {
  const ascii = stripDiacritics(input).toLowerCase();
  const cleaned = ascii
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  const result = (cleaned || fallback).slice(0, PATH_LABEL_MAX_LENGTH);
  return /^[a-z0-9_]/.test(result) ? result : `u_${result}`.slice(0, PATH_LABEL_MAX_LENGTH);
}

/** Chuẩn hoá thành 1 `code` hợp lệ (varchar 64, thân thiện người dùng — cho phép "-"). */
export function slugifyCode(input: string, fallback = "unit"): string {
  const ascii = stripDiacritics(input).toLowerCase();
  const cleaned = ascii
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (cleaned || fallback).slice(0, CODE_MAX_LENGTH);
}

export function pathSegments(path: string): string[] {
  return path.split(PATH_SEPARATOR).filter(Boolean);
}

export function pathDepth(path: string): number {
  return pathSegments(path).length;
}

export function buildChildPath(parentPath: string, childLabel: string): string {
  return `${parentPath}${PATH_SEPARATOR}${childLabel}`;
}

/** true nếu `candidatePath` LÀ `ancestorPath` hoặc nằm trong subtree của nó (bao gồm chính nó). */
export function isDescendantPath(candidatePath: string, ancestorPath: string): boolean {
  return candidatePath === ancestorPath || candidatePath.startsWith(`${ancestorPath}${PATH_SEPARATOR}`);
}

/** true nếu `candidatePath` LÀ tổ tiên (hoặc chính nó) của `descendantPath`. */
export function isAncestorPath(candidatePath: string, descendantPath: string): boolean {
  return isDescendantPath(descendantPath, candidatePath);
}

/**
 * Di chuyển 1 node (đang ở `oldNodePath`) sang làm con của `newParentPath`.
 * Trả về path MỚI cho 1 dòng bất kỳ trong subtree của node đó (kể cả chính
 * node — `rowPath === oldNodePath`). Đây là phép toán THUẦN tương đương hệt
 * câu SQL đã verify trên Postgres 16 thật (xem organization-units.ts):
 *
 *   UPDATE organization_units
 *   SET path = new_parent_path || subpath(path, nlevel(old_node_path) - 1)
 *   WHERE path <@ old_node_path
 *
 * Ném lỗi nếu `rowPath` không thực sự nằm trong subtree của `oldNodePath`
 * (gọi sai — không phải lỗi nghiệp vụ, lỗi lập trình).
 */
export function rebasePath(rowPath: string, oldNodePath: string, newParentPath: string): string {
  if (!isDescendantPath(rowPath, oldNodePath)) {
    throw new Error(`rebasePath: "${rowPath}" không nằm trong subtree của "${oldNodePath}"`);
  }
  const dropCount = pathDepth(oldNodePath) - 1;
  const kept = pathSegments(rowPath).slice(dropCount);
  return [...pathSegments(newParentPath), ...kept].join(PATH_SEPARATOR);
}

/**
 * Chặn circular parent — di chuyển 1 node vào LÀM CON của chính nó hoặc của
 * bất kỳ descendant nào của nó (bao gồm cả trường hợp "parent chính nó":
 * newParentPath === nodePath cũng bị coi là descendant-of-self ở đây).
 */
export function wouldCreateCycle(nodePath: string, newParentPath: string): boolean {
  return isDescendantPath(newParentPath, nodePath);
}

/**
 * FORMAT của `code` như dữ liệu THẬT đang có, không phải định nghĩa mới áp lên
 * dữ liệu cũ (PR1 mục XIV — "audit dữ liệu hiện có trước", "không tạo migration
 * khiến dữ liệu hợp lệ hiện tại bị fail mà không có report"). Khớp CHÍNH XÁC 2
 * nguồn sinh `code` hiện có:
 *   1. slugifyCode() ở trên — chữ thường, số, gạch ngang, không rỗng, ≤64 ký tự.
 *   2. Cầu nối cơ học "legacy-<uuid>" từ migrations/2026-08-17-organization-units.sql
 *      (backfill 1-1 từ departments) — cũng chỉ [a-z0-9-].
 *   3. Root duy nhất: "root".
 * Dùng để AUDIT (scripts/audit-organization-mapping.mjs) — KHÔNG dùng để chặn
 * code hiện có tại runtime (không có migration nào retrofit format lên dữ liệu cũ).
 */
export const ORG_UNIT_CODE_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** true nếu `code` khớp format hiện hành (xem ORG_UNIT_CODE_PATTERN) và trong giới hạn cột varchar(64). */
export function isValidOrgUnitCode(code: string): boolean {
  return code.length > 0 && code.length <= CODE_MAX_LENGTH && ORG_UNIT_CODE_PATTERN.test(code);
}

export type BreadcrumbNode = { id: string; name: string };

/** Ghép breadcrumb — input PHẢI theo thứ tự root -> node (mục 5, 20 đề bài). */
export function formatBreadcrumb(ancestors: BreadcrumbNode[], separator = " > "): string {
  return ancestors.map((a) => a.name).join(separator);
}
