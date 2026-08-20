/**
 * HTML merge pipeline — nối Data Resolver + Template Registry + HTML Renderer.
 *
 * Đây là ĐƯỜNG RENDER DUY NHẤT cho engine HTML_PDF:
 *   - Preview (Phase 7) và Cloud Run worker (Phase 3) đều gọi `renderApplicantDocument`
 *     → Preview đúng thì PDF đúng (cùng renderer).
 *   - Reuse `resolveAllFields` + `applyFallbackPlaceholders` (KHÔNG mapping mới).
 */

import type { MergeTemplateField } from "../../db/schema";
import { resolveAllFields, validateRequiredFields, type MergeContext, type RecordData } from "./data-resolver.ts";
import { applyFallbackPlaceholders } from "./preview-merge.ts";
import { renderApplicantHtml, renderApplicantHtmlFromParts } from "./html-renderer.ts";
import { getHtmlTemplateByGoogleDocId } from "../../document-templates/registry.ts";

export function resolveHtmlFieldValues(
  fields: MergeTemplateField[],
  recordData: RecordData,
  context: MergeContext,
): Record<string, string> {
  const mapped = resolveAllFields(fields, recordData, context);
  return applyFallbackPlaceholders(recordData, mapped);
}

export interface RenderApplicantDocumentResult {
  html: string;
  unreplaced: string[];
  missingFields: string[];
  valid: boolean;
}

/**
 * Render 1 candidate → HTML hoàn chỉnh.
 * `fields` = field mappings của template (từ DB hoặc snapshot trong merge_jobs.metadata).
 */
export function renderApplicantDocument(
  googleDocId: string,
  fields: MergeTemplateField[],
  recordData: RecordData,
  context: MergeContext,
): RenderApplicantDocumentResult {
  const template = getHtmlTemplateByGoogleDocId(googleDocId);
  if (!template) {
    throw new Error(`HTML_TEMPLATE_MISSING: chưa có HTML template cho Google Doc ${googleDocId}.`);
  }
  return renderApplicantDocumentFromParts(template.html, template.css, fields, recordData, context);
}

/**
 * Render từ version PUBLISHED (htmlBody/printCss lưu trong merge_template_versions) —
 * Phase 4: Template Builder quản lý HTML, KHÔNG hardcode registry.
 */
export function renderApplicantDocumentFromParts(
  htmlBody: string,
  printCss: string | null | undefined,
  fields: MergeTemplateField[],
  recordData: RecordData,
  context: MergeContext,
): RenderApplicantDocumentResult {
  const fieldValues = resolveHtmlFieldValues(fields, recordData, context);
  const rendered = renderApplicantHtmlFromParts(htmlBody, printCss, fieldValues);
  const validation = validateRequiredFields(fields, fieldValues);

  return {
    html: rendered.html,
    unreplaced: rendered.unreplaced,
    missingFields: validation.missingFields,
    valid: validation.valid && rendered.unreplaced.length === 0,
  };
}

/**
 * Render từ 1 version row (merge_template_versions) — điểm vào cho worker + preview.
 */
export function renderApplicantDocumentFromVersion(
  version: { htmlBody: string | null; printCss: string | null },
  fields: MergeTemplateField[],
  recordData: RecordData,
  context: MergeContext,
): RenderApplicantDocumentResult {
  if (!version.htmlBody?.trim()) {
    throw new Error(`HTML_TEMPLATE_EMPTY: version chưa có nội dung HTML.`);
  }
  return renderApplicantDocumentFromParts(version.htmlBody, version.printCss, fields, recordData, context);
}
