/**
 * HTML merge pipeline: normalized data → semantic fields → HTML → worker PDF.
 *
 * ⚠️ This module contains NO document body and can never supply one. It only
 * renders a body it is handed. The single runtime body source is the
 * explicitly PUBLISHED canonical version snapshotted onto a job — see
 * `canonical-document.ts` (`renderCanonicalDocument`), which both Preview and
 * the Cloud Run HTML_PDF worker call.
 *
 * There is intentionally no "render a registered first-party template"
 * entry point any more: that was a static-HTML runtime path that allowed an
 * obsolete template to be rendered.
 */

import type { MergeTemplateField } from "../../db/schema";
import { resolveAllFields, validateRequiredFields, type MergeContext, type RecordData } from "./data-resolver.ts";
import { applyFallbackPlaceholders } from "./preview-merge.ts";
import { renderApplicantHtmlFromParts } from "./html-renderer.ts";
import type { TemplateContract } from "./template-contract.ts";
import { validateContractRequiredValues } from "./template-contract.ts";

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

export interface HtmlRenderOptions {
  /** Optional first-party contract. Generic versioned templates rely on DB mappings only. */
  contract?: TemplateContract | null;
}

/**
 * Render an immutable version snapshot. Required fields are checked before the
 * worker calls Playwright, so an incomplete candidate cannot produce a PDF.
 */
export function renderApplicantDocumentFromParts(
  htmlBody: string,
  printCss: string | null | undefined,
  fields: MergeTemplateField[],
  recordData: RecordData,
  context: MergeContext,
  options: HtmlRenderOptions = {},
): RenderApplicantDocumentResult {
  const fieldValues = resolveHtmlFieldValues(fields, recordData, context);
  const dbValidation = validateRequiredFields(fields, fieldValues);
  const mappedKeys = new Set(fields.filter((field) => !field.isOrphaned).map((field) => field.placeholder));
  const contractMissing = validateContractRequiredValues(options.contract, fieldValues, { mappedKeys });
  const missingFields = [...new Set([...dbValidation.missingFields, ...contractMissing])].sort();
  const rendered = renderApplicantHtmlFromParts(htmlBody, printCss, fieldValues);

  return {
    html: rendered.html,
    unreplaced: rendered.unreplaced,
    missingFields,
    valid: missingFields.length === 0 && rendered.unreplaced.length === 0,
  };
}

/** Render from a version row, preserving the same validation and escaping rules. */
export function renderApplicantDocumentFromVersion(
  version: { htmlBody: string | null; printCss: string | null },
  fields: MergeTemplateField[],
  recordData: RecordData,
  context: MergeContext,
  options: HtmlRenderOptions = {},
): RenderApplicantDocumentResult {
  if (!version.htmlBody?.trim()) {
    throw new Error("HTML_TEMPLATE_EMPTY: version chưa có nội dung HTML.");
  }
  return renderApplicantDocumentFromParts(version.htmlBody, version.printCss, fields, recordData, context, options);
}
