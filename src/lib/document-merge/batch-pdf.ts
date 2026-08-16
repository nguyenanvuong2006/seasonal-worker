import { PDFDocument } from "pdf-lib";

export async function mergePdfBuffers(pdfBuffers: Uint8Array[]): Promise<Uint8Array> {
  if (pdfBuffers.length === 0) {
    throw new Error("BATCH_PDF_EMPTY: Không có PDF nào để gộp.");
  }

  const output = await PDFDocument.create();
  for (const bytes of pdfBuffers) {
    const source = await PDFDocument.load(bytes, { ignoreEncryption: false });
    const pageIndices = source.getPageIndices();
    const copiedPages = await output.copyPages(source, pageIndices);
    for (const page of copiedPages) output.addPage(page);
  }

  return output.save({ useObjectStreams: true });
}
