export async function register() {
  // Next instrumentation is executed on the server. Do not gate installation on
  // NEXT_RUNTIME because that environment variable is not guaranteed to be
  // populated when register() runs in every Vercel/Next deployment mode.
  // The batch patch must be installed before the Document Merge route creates
  // its Google Docs service; otherwise createDocument() falls back to the
  // fail-safe FORMAT_PRESERVING_BATCH_REQUIRED path.
  const { installGoogleDocsRateLimitGuard } = await import("@/lib/document-merge/docs-rate-limit-guard");
  installGoogleDocsRateLimitGuard();

  const { installFormatPreservingBatchPatch } = await import("@/lib/document-merge/batch-format-preserver");
  installFormatPreservingBatchPatch();
}
