/**
 * FULL DOCUMENT ANALYZE (H2) — thin wrapper composing three UNMODIFIED H1
 * building blocks, in order:
 *   1. full-document-normalizer.ts's normalizeFullHtmlDocument() — strips a
 *      pasted full HTML document down to {htmlBody, extractedCss, warnings}.
 *      Idempotent/pass-through for a bare fragment (H1's existing "advanced"
 *      split html+css mode), so this module works for BOTH UI modes without
 *      a client-supplied flag.
 *   2. ai-template-analyze.ts's analyzeTemplate() (PR #102 buildTemplateDiff
 *      reused inside it, untouched) — evaluated against the NORMALIZED body
 *      + combined CSS, never against the raw paste.
 *   3. analysis-hash.ts's computeAnalysisHash() — a deterministic hash of
 *      exactly what was analyzed, for the Apply-time staleness guard.
 *
 * This module does not reimplement diffing, security, or layout analysis —
 * it only wires the three pieces together and classifies the normalizer's
 * warnings into the two buckets the operator UI (Phase 15) shows separately.
 */

import { normalizeFullHtmlDocument, type NormalizationWarning } from "./full-document-normalizer.ts";
import { analyzeTemplate, type AnalyzeTemplateInput, type AnalyzeTemplateResult } from "./ai-template-analyze.ts";
import { computeAnalysisHash } from "./analysis-hash.ts";

export interface FullDocumentAnalyzeInput {
  /** Raw operator paste — a complete HTML document OR a bare fragment. */
  rawHtml: string;
  /** Explicit CSS box content (H1 "advanced" split-editor mode). Combined, in order, with any <style> blocks found inside rawHtml. */
  explicitCss?: string;
  baseHtml: AnalyzeTemplateInput["baseHtml"];
  baseMappings: AnalyzeTemplateInput["baseMappings"];
  currentMappings: AnalyzeTemplateInput["currentMappings"];
}

export interface FullDocumentAnalyzeResult extends AnalyzeTemplateResult {
  /** The extracted body actually analyzed (and what Apply would write to html_body). */
  normalizedHtmlBody: string;
  /** The combined CSS actually analyzed (and what Apply would write to print_css). */
  normalizedPrintCss: string;
  /** Non-external-resource normalization notices (e.g. multiple <body> tags). */
  normalizationWarnings: NormalizationWarning[];
  /** External stylesheets the normalizer refused to fetch. */
  externalResourceWarnings: NormalizationWarning[];
  /** sha256 of normalizedHtmlBody + normalizedPrintCss — see analysis-hash.ts. */
  analysisHash: string;
}

export function analyzeFullDocument(input: FullDocumentAnalyzeInput): FullDocumentAnalyzeResult {
  const normalized = normalizeFullHtmlDocument(input.rawHtml);
  const normalizedPrintCss = [input.explicitCss, normalized.extractedCss]
    .filter((chunk): chunk is string => Boolean(chunk && chunk.trim()))
    .join("\n\n");

  const result = analyzeTemplate({
    html: normalized.htmlBody,
    printCss: normalizedPrintCss,
    baseHtml: input.baseHtml,
    baseMappings: input.baseMappings,
    currentMappings: input.currentMappings,
  });

  const externalResourceWarnings = normalized.warnings.filter((w) => w.code === "EXTERNAL_STYLESHEET_IGNORED");
  const normalizationWarnings = normalized.warnings.filter((w) => w.code !== "EXTERNAL_STYLESHEET_IGNORED");

  return {
    ...result,
    normalizedHtmlBody: normalized.htmlBody,
    normalizedPrintCss,
    normalizationWarnings,
    externalResourceWarnings,
    analysisHash: computeAnalysisHash(normalized.htmlBody, normalizedPrintCss),
  };
}
