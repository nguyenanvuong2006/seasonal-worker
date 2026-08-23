/**
 * First-party HTML print-template registry.
 *
 * Registration supplies a stable key, canonical field contract and visual
 * source. Published DB versions remain the production source of HTML/CSS; the
 * registry is used to validate known template contracts and to support local
 * visual verification. New templates are explicit additions here, never an
 * implicit conversion to PDF-coordinate mappings.
 */

import type { HtmlTemplate } from "../lib/document-merge/html-renderer.ts";
import type { TemplateContract } from "../lib/document-merge/template-contract.ts";
import { dangKyTapNgheTemplate } from "./dang-ky-tap-nghe/template.ts";

export const HTML_TEMPLATES: HtmlTemplate[] = [dangKyTapNgheTemplate];

const byGoogleDocId = new Map<string, HtmlTemplate>();
const byKey = new Map<string, HtmlTemplate>();
for (const template of HTML_TEMPLATES) {
  byKey.set(template.key, template);
  for (const id of template.googleDocIds) byGoogleDocId.set(id, template);
}

export function getHtmlTemplateByGoogleDocId(googleDocId: string | null | undefined): HtmlTemplate | null {
  if (!googleDocId) return null;
  return byGoogleDocId.get(googleDocId) ?? null;
}

export function getHtmlTemplateByKey(key: string | null | undefined): HtmlTemplate | null {
  if (!key) return null;
  return byKey.get(key) ?? null;
}

export function getHtmlTemplateContractByKey(key: string | null | undefined): TemplateContract | null {
  return getHtmlTemplateByKey(key)?.fieldContract ?? null;
}

export function getHtmlTemplateContractByGoogleDocId(googleDocId: string | null | undefined): TemplateContract | null {
  return getHtmlTemplateByGoogleDocId(googleDocId)?.fieldContract ?? null;
}
