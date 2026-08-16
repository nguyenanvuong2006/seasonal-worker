export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { installFormatPreservingBatchPatch } = await import("@/lib/document-merge/batch-format-preserver");
    installFormatPreservingBatchPatch();
  }
}
