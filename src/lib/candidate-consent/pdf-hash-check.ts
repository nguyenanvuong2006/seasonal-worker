/**
 * "Kiểm tra file PDF" — entirely CLIENT-SIDE SHA-256 via the standard
 * WebCrypto SubtleCrypto API (`crypto.subtle`, available in every modern
 * browser AND in Node ≥19, so this same module is directly unit-testable
 * under `node --test` with zero mocking). The candidate/employer's PDF
 * bytes are hashed locally and NEVER uploaded anywhere — only the resulting
 * hex digest is compared, in the browser, against the `pdfSha256` already
 * present in the page's own verification DTO.
 */

export async function computeFileSha256Hex(file: Blob): Promise<string> {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export type PdfHashCheckResult = "MATCH" | "MISMATCH";

export function comparePdfHash(computedHex: string, expectedHex: string): PdfHashCheckResult {
  return computedHex.trim().toLowerCase() === expectedHex.trim().toLowerCase() ? "MATCH" : "MISMATCH";
}
