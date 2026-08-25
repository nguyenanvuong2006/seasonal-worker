/**
 * Deterministic content hash for the H2 Analyze -> Apply staleness guard
 * (Phase 5). Computed over the NORMALIZED htmlBody + printCss that Analyze
 * actually evaluated — never over the raw pasted document — so a paste that
 * re-normalizes to the identical body/CSS produces the identical hash.
 */

import { createHash } from "node:crypto";

const FIELD_SEPARATOR = "\n<<H2-ANALYSIS-HASH-SEPARATOR>>\n";

export function computeAnalysisHash(normalizedHtmlBody: string, normalizedPrintCss: string): string {
  return createHash("sha256")
    .update(normalizedHtmlBody ?? "")
    .update(FIELD_SEPARATOR)
    .update(normalizedPrintCss ?? "")
    .digest("hex");
}
