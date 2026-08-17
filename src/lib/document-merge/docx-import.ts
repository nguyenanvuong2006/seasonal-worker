/**
 * Document Merge — DOCX import (Phase 4).
 *
 * Workflow (mục D):
 *   Upload DOCX → convert sang HTML/CSS (mammoth) → scan placeholder
 *   → Mapping Inspector → Preview → Publish.
 *
 * QUY TẮC AN TOÀN (spec D):
 *   - DOCX conversion KHÔNG giữ layout 100% (mammoth giữ text/table/heading
 *     nhưng có thể lệch border/spacing/font) → KHÔNG tự động publish.
 *   - Import luôn tạo version DRAFT; Admin phải Preview kiểm tra trước khi Publish.
 *   - Không bao giờ thay thế version PUBLISHED đang dùng.
 */

import mammoth from "mammoth";

export class DocxImportError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
    this.name = "DocxImportError";
  }
}

export interface DocxConversionResult {
  html: string;
  messages: string[];
  /** true nếu mammoth báo lỗi layout có thể mất (image/border unsupported...). */
  hasWarnings: boolean;
}

const MAX_IMPORT_BYTES = 10 * 1024 * 1024; // 10 MB

/** Convert DOCX buffer → HTML (body fragment). Không publish tự động. */
export async function convertDocxToHtml(buffer: Buffer | Uint8Array): Promise<DocxConversionResult> {
  if (buffer.byteLength === 0) {
    throw new DocxImportError("File DOCX rỗng.");
  }
  if (buffer.byteLength > MAX_IMPORT_BYTES) {
    throw new DocxImportError("File DOCX quá lớn (tối đa 10 MB).");
  }

  let result: Awaited<ReturnType<typeof mammoth.convertToHtml>>;
  try {
    result = await mammoth.convertToHtml(
      { buffer: Buffer.from(buffer) },
      {
        // Giữ nguyên cấu trúc càng nhiều càng tốt; ảnh được nhúng data-uri
        // (giới hạn kích thước — ảnh lớn bị bỏ qua và ghi warning).
        convertImage: mammoth.images.imgElement((image) =>
          image
            .readAsArrayBuffer()
            .then((data) => {
              if (data.byteLength > 800 * 1024) return { src: "" };
              const base64 = Buffer.from(data).toString("base64");
              return { src: `data:${image.contentType};base64,${base64}` };
            }),
        ),
        styleMap: [
          "p[style-name='Heading 1'] => h1:fresh",
          "p[style-name='Heading 2'] => h2:fresh",
          "p[style-name='Heading 3'] => h3:fresh",
          "table => table:separate",
        ],
      },
    );
  } catch (error) {
    throw new DocxImportError(
      `Không đọc được file DOCX: ${error instanceof Error ? error.message : "lỗi không xác định"}`,
    );
  }

  const messages = (result.messages ?? []).map((m) => m.message);
  const hasWarnings = messages.some((m) => /image|table|border|style|page break/i.test(m));
  return { html: result.value, messages, hasWarnings };
}

/** Đếm nhanh số placeholder <<...>> trong HTML (cho UI thông báo). */
export function countPlaceholdersInHtml(html: string): number {
  const matches = html.match(/<<([^>]+)>>/g);
  return matches ? matches.length : 0;
}
