/**
 * TEST SUPPORT — dựng lại TẦNG CSS THẬT của trang Document Merge trong jsdom.
 *
 * VÌ SAO FILE NÀY TỒN TẠI
 * -----------------------
 * jsdom mặc định KHÔNG có stylesheet nào: `getComputedStyle(el).zIndex` của
 * một `<div class="fixed inset-0 z-[100]">` trả về "" chứ không phải "100".
 * Vì vậy mọi test UI cũ chỉ assert được CHUỖI class ("có z-[100] trong
 * className") — mà chuỗi class thì KHÔNG quyết định thứ tự vẽ. Thứ tự vẽ do
 * CSS đã biên dịch quyết định, và ở Document Merge nó còn bị
 * `document-merge-parity.css` ghi đè bằng `!important`.
 *
 * Kết quả: bug production "bấm 'Xuất bản phiên bản' không thấy checklist" là
 * một bug THUẦN CSS (checklist bị đè DƯỚI modal 'Sửa Template') mà toàn bộ
 * test cũ không thể nhìn thấy.
 *
 * File này dựng lại đúng hai tầng CSS mà trình duyệt của operator tải về:
 *   1. CSS Tailwind THẬT — biên dịch bằng chính pipeline của repo
 *      (`@tailwindcss/postcss` chạy trên `src/app/globals.css`), rồi chỉ giữ
 *      lại các rule `z-index` để jsdom parse ổn định. Giá trị z-index do đó
 *      KHÔNG phải do test tự bịa ra.
 *   2. `document-merge-parity.css` THẬT — đọc thẳng từ đĩa, nguyên văn, gồm
 *      cả rule `!important` đang ghi đè z-index của overlay modal.
 *
 * Nếu Tailwind không sinh ra utility cho một class z-index nào đó đang có
 * trong cây component, `zIndexUtilitiesFor()` NÉM LỖI chứ không trả về thiếu —
 * để test không bao giờ "pass" trên một tầng CSS bị thiếu.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const GLOBALS_CSS = path.join(REPO_ROOT, "src/app/globals.css");
const PARITY_CSS = path.join(
  REPO_ROOT,
  "src/app/(internal)/admin/document-merge/document-merge-parity.css",
);

let cachedTailwindZIndexCss: string | null = null;

/**
 * Biên dịch Tailwind THẬT của repo rồi trích các rule `z-index`.
 * Trả về CSS dạng `.z-50{z-index:50}` / `.z-\[100\]{z-index:100}`.
 */
export async function tailwindZIndexUtilities(): Promise<string> {
  if (cachedTailwindZIndexCss !== null) return cachedTailwindZIndexCss;
  const input = readFileSync(GLOBALS_CSS, "utf8");
  const result = await postcss([tailwind({ optimize: false })]).process(input, { from: GLOBALS_CSS });
  // Chỉ giữ lại các rule khai báo z-index — đủ cho thứ tự vẽ, và tránh jsdom
  // phải parse toàn bộ CSS hiện đại (oklch/color-mix/@property).
  const rules = [...result.css.matchAll(/([^{}]+)\{([^{}]*z-index[^{}]*)\}/g)]
    .map((m) => `${m[1].trim()}{${m[2].trim()}}`)
    .filter((rule) => /\.z-(?:\\\[\d+\\\]|\d+)/.test(rule));
  if (rules.length === 0) {
    throw new Error(
      "Tailwind không sinh ra bất kỳ z-index utility nào — tầng CSS của test không còn đúng với production.",
    );
  }
  cachedTailwindZIndexCss = rules.join("\n");
  return cachedTailwindZIndexCss;
}

/** `document-merge-parity.css` nguyên văn từ đĩa (kể cả các rule `!important`). */
export function parityCss(): string {
  return readFileSync(PARITY_CSS, "utf8");
}

/**
 * Cả hai tầng CSS, theo đúng thứ tự trình duyệt nạp: Tailwind trước, CSS
 * parity của layout Document Merge sau (layout import CSS của chính nó).
 */
export async function documentMergeStylesheets(): Promise<string[]> {
  return [await tailwindZIndexUtilities(), parityCss()];
}

/**
 * Assert rằng Tailwind THẬT có sinh utility cho mọi class z-index đang dùng,
 * rồi trả về danh sách class đó — dùng để phát hiện overlay mới mà tầng CSS
 * của test chưa phủ.
 */
export async function zIndexUtilitiesFor(classNames: string[]): Promise<string[]> {
  const css = await tailwindZIndexUtilities();
  const missing: string[] = [];
  for (const className of classNames) {
    // Selector Tailwind của `z-[100]` là `.z-\[100\]` — so khớp NGUYÊN VĂN
    // (không dựng regex: dấu `\` và `[]` trong selector rất dễ escape sai).
    const selector = `.${className.replace(/[[\]]/g, (c) => `\\${c}`)}`;
    if (!css.includes(`${selector}{`)) missing.push(className);
  }
  if (missing.length > 0) {
    throw new Error(
      `Tailwind của repo không sinh z-index utility cho: ${missing.join(", ")} — ` +
        "tầng CSS dựng lại trong test không còn tương đương production.",
    );
  }
  return classNames;
}
