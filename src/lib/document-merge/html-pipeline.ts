/**
 * HTML merge pipeline: normalized data → semantic fields → HTML → worker PDF.
 *
 * The worker and the read-only HTML preview call this same pipeline.  It has no
 * coordinate-overlay dependency and relies on the existing Data Resolver,
 * template-version snapshots, authorization and queue lifecycle.
 */

import type { MergeTemplateField } from "../../db/schema";
import { resolveAllFields, validateRequiredFields, type MergeContext, type RecordData } from "./data-resolver.ts";
import { applyFallbackPlaceholders } from "./preview-merge.ts";
import { renderApplicantHtmlFromParts } from "./html-renderer.ts";
import { getHtmlTemplateByGoogleDocId } from "../../document-templates/registry.ts";
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
 * Render a registered first-party template. This route is useful for local
 * verification; production jobs render their immutable version snapshot below.
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
  return renderApplicantDocumentFromParts(template.html, template.css, fields, recordData, context, {
    contract: template.fieldContract,
  });
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
  const contractMissing = validateContractRequiredValues(options.contract, fieldValues);
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
