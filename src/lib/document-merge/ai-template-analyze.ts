/**
 * AI TEMPLATE ANALYZE — pure orchestrator for the H1 read-only Analyze
 * workflow. Combines:
 *   - html-scanner.ts / css-scanner.ts structural validation,
 *   - the EXISTING PR #102 Template Diff Engine (template-diff.ts,
 *     buildTemplateDiff — imported and reused verbatim, never duplicated),
 *   - ai-template-security.ts,
 *   - ai-template-layout.ts,
 *   - a conservative, deterministic visible-text diff ("content changes").
 *
 * This module touches no database and performs no I/O — the caller (the
 * ai-analyze API route) is responsible for loading the base version's
 * placeholders/mappings and passing them in as plain data.
 */

import { tokenizeHtml, checkWellFormedness, decodeBasicEntities, type WellFormednessIssue } from "./html-scanner.ts";
import { parseCss, type CssValidationIssue } from "./css-scanner.ts";
import { PLACEHOLDER_PATTERN, extractUniquePlaceholders } from "./placeholder-extractor.ts";
import {
  buildTemplateDiff,
  extractPlaceholderSet,
  type MappingSemantics,
  type TemplateDiffResult,
} from "./template-diff.ts";
import { analyzeTemplateSecurity, type SecurityAnalysis } from "./ai-template-security.ts";
import { analyzeTemplateLayout, type LayoutWarning } from "./ai-template-layout.ts";

export interface AnalyzeTemplateInput {
  html: string;
  printCss: string;
  /** Base version's HTML body — used for the placeholder diff and content-change diff. */
  baseHtml: string;
  /** Base version's effective mapping set (frozen snapshot for PUBLISHED, live fields for DRAFT). */
  baseMappings: MappingSemantics[];
  /** Current live mapping set (mappings are never mutated by Analyze — same set regardless of pasted HTML). */
  currentMappings: MappingSemantics[];
}

export interface PlaceholderCounts {
  total: number;
  unchanged: number;
  added: number;
  removed: number;
}

export interface ContentChanges {
  added: string[];
  removed: string[];
}

export interface AnalyzeTemplateResult {
  htmlValid: boolean;
  htmlIssues: WellFormednessIssue[];
  cssValid: boolean;
  cssIssues: CssValidationIssue[];
  placeholders: PlaceholderCounts;
  mappingsAffected: number;
  security: SecurityAnalysis;
  layoutWarnings: LayoutWarning[];
  /** Best-effort, deterministic visible-text diff. Never a legal-wording verifier. */
  contentChanges: ContentChanges;
  /** Full PR #102 diff result, for a detailed per-placeholder UI breakdown. */
  diff: TemplateDiffResult;
}

/** Extract normalized, de-duplicated visible text segments (no placeholders, no raw-text bodies). */
export function extractVisibleTextSegments(html: string): Set<string> {
  const segments = new Set<string>();
  for (const token of tokenizeHtml(html ?? "")) {
    if (token.type !== "text") continue;
    const withoutPlaceholders = token.content.replace(PLACEHOLDER_PATTERN, " ");
    const normalized = decodeBasicEntities(withoutPlaceholders).replace(/\s+/g, " ").trim();
    if (normalized.length >= 2) segments.add(normalized);
  }
  return segments;
}

/** Deterministic, sorted added/removed visible-text diff between two HTML bodies. */
export function diffVisibleText(baseHtml: string, currentHtml: string): ContentChanges {
  const base = extractVisibleTextSegments(baseHtml);
  const current = extractVisibleTextSegments(currentHtml);
  const added = [...current].filter((s) => !base.has(s)).sort();
  const removed = [...base].filter((s) => !current.has(s)).sort();
  return { added, removed };
}

export function analyzeTemplate(input: AnalyzeTemplateInput): AnalyzeTemplateResult {
  const htmlIssues = checkWellFormedness(tokenizeHtml(input.html ?? ""));
  const { issues: cssIssues } = parseCss(input.printCss ?? "");

  const basePlaceholders = extractPlaceholderSet(input.baseHtml ?? "");
  const currentPlaceholders = extractUniquePlaceholders(input.html ?? "");

  const diff = buildTemplateDiff({
    basePlaceholders,
    baseMappings: input.baseMappings,
    currentPlaceholders,
    currentMappings: input.currentMappings,
  });

  const security = analyzeTemplateSecurity(input.html ?? "", input.printCss ?? "");
  const layoutWarnings = analyzeTemplateLayout(input.html ?? "", input.printCss ?? "");
  const contentChanges = diffVisibleText(input.baseHtml ?? "", input.html ?? "");

  return {
    htmlValid: htmlIssues.length === 0,
    htmlIssues,
    cssValid: cssIssues.length === 0,
    cssIssues,
    placeholders: {
      total: diff.summary.total,
      unchanged: diff.summary.unchanged,
      added: diff.summary.added,
      removed: diff.summary.removed,
    },
    mappingsAffected: diff.summary.mappingChanged + diff.summary.requiredChanged,
    security,
    layoutWarnings,
    contentChanges,
    diff,
  };
}
