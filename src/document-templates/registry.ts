/**
 * HTML print template registry.
 *
 * Map merge_templates.google_doc_id → HTML template (cùng canonical placeholder).
 * Khi thêm mẫu mới: tạo thư mục + module template rồi đăng ký ở đây.
 */

import type { HtmlTemplate } from "../lib/document-merge/html-renderer.ts";
import { dangKyTapNgheTemplate } from "./dang-ky-tap-nghe/template.ts";

export const HTML_TEMPLATES: HtmlTemplate[] = [dangKyTapNgheTemplate];

const byGoogleDocId = new Map<string, HtmlTemplate>();
for (const tpl of HTML_TEMPLATES) {
  for (const id of tpl.googleDocIds) byGoogleDocId.set(id, tpl);
}

export function getHtmlTemplateByGoogleDocId(googleDocId: string | null | undefined): HtmlTemplate | null {
  if (!googleDocId) return null;
  return byGoogleDocId.get(googleDocId) ?? null;
}

export function getHtmlTemplateByKey(key: string): HtmlTemplate | null {
  return HTML_TEMPLATES.find((t) => t.key === key) ?? null;
}
