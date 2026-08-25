/**
 * AI TEMPLATE EXPORT (H1) — builds the downloadable "AI package" for a single
 * template version: template.html, print.css, template-manifest.json,
 * README-AI.md, zipped together.
 *
 * ZERO CANDIDATE PII, ZERO SECRETS: every value in this module is sourced
 * from merge_templates / merge_template_versions / merge_template_fields
 * (template-authoring metadata) — this module never reads dailyApplications,
 * workerProfiles, or any candidate/applicant table, and never reads
 * environment variables or connection strings. See ai-template-export.test.ts
 * for an explicit scan of the produced package.
 *
 * MAPPING SEMANTICS (do not change): reuses toMappingSemantics/sourceFieldLabel
 * from template-diff.ts (PR #102) and selectPreviewMappings from
 * draft-preview.ts (PR #99) — a PUBLISHED version's inventory reflects its
 * frozen mapping_snapshot; a DRAFT's reflects the current non-orphaned
 * merge_template_fields. The caller passes the already-resolved mapping list
 * and its source; this module does not decide which one to use.
 */

import * as yazl from "yazl";
import { extractPlaceholderSet, sourceFieldLabel, type MappingSemantics } from "./template-diff.ts";

export const AI_EXPORT_CONTRACT_VERSION = "1.0";

export interface ExportPlaceholderEntry {
  key: string;
  required: boolean;
  mapped: boolean;
  label: string;
  sourceType: string;
  sourceField: string | null;
  sourcePath: string | null;
  optionValue: string | null;
  formatType: string | null;
}

export interface TemplateManifest {
  contractVersion: string;
  templateId: string;
  templateName: string;
  documentKind: string;
  version: number;
  status: string;
  mappingSource: string;
  generatedAt: string;
  placeholderCount: number;
  placeholders: ExportPlaceholderEntry[];
}

export interface BuildManifestInput {
  templateId: string;
  templateName: string;
  documentKind: string;
  version: number;
  status: string;
  htmlBody: string;
  mappings: readonly MappingSemantics[];
  mappingSource: string;
  now?: Date;
}

/** Build the non-sensitive manifest describing this version's placeholder contract. */
export function buildTemplateManifest(input: BuildManifestInput): TemplateManifest {
  const placeholderKeys = extractPlaceholderSet(input.htmlBody);
  const byKey = new Map(input.mappings.map((m) => [m.placeholder, m]));

  const placeholders: ExportPlaceholderEntry[] = placeholderKeys.map((key) => {
    const m = byKey.get(key) ?? null;
    const mapped = Boolean(m && (m.sourceField || m.sourcePath || m.fallbackValue));
    return {
      key,
      required: m?.isRequired === true,
      mapped,
      label: sourceFieldLabel(m?.sourcePath ?? m?.sourceField ?? null) ?? key,
      sourceType: m?.sourceType ?? "UNMAPPED",
      sourceField: m?.sourceField ?? null,
      sourcePath: m?.sourcePath ?? null,
      optionValue: m?.optionValue ?? null,
      formatType: m?.formatType ?? null,
    };
  });

  return {
    contractVersion: AI_EXPORT_CONTRACT_VERSION,
    templateId: input.templateId,
    templateName: input.templateName,
    documentKind: input.documentKind,
    version: input.version,
    status: input.status,
    mappingSource: input.mappingSource,
    generatedAt: (input.now ?? new Date()).toISOString(),
    placeholderCount: placeholders.length,
    placeholders,
  };
}

/** README-AI.md — the self-contained contract handed to an AI along with template.html/print.css. */
export function buildReadmeAi(manifest: TemplateManifest): string {
  const placeholderList = manifest.placeholders
    .map((p) => `- \`<<${p.key}>>\`${p.required ? " (bắt buộc / required)" : ""} — ${p.label}`)
    .join("\n");

  return `# README-AI — Hợp đồng mẫu tài liệu (Template Contract)

Tài liệu này mô tả CHÍNH XÁC hợp đồng của mẫu **"${manifest.templateName}"** (phiên bản v${manifest.version}, trạng thái ${manifest.status}) để một AI (ChatGPT / Claude / Arena) có thể chỉnh sửa \`template.html\` + \`print.css\` một cách AN TOÀN và trả lại kết quả dùng được ngay.

Gói này gồm 4 file:
- \`template.html\` — nội dung HTML gốc của phiên bản.
- \`print.css\` — CSS in ấn tuỳ chỉnh của phiên bản (CSS A4 chung của hệ thống được tự động thêm khi render, KHÔNG có trong file này).
- \`template-manifest.json\` — danh sách placeholder + mapping hiện có (dữ liệu, không phải hướng dẫn).
- \`README-AI.md\` — chính là file này.

Contract version: ${manifest.contractVersion}. Tạo lúc: ${manifest.generatedAt}.

## 1. Cú pháp placeholder (BẮT BUỘC tuân thủ)

Placeholder là một trong hai dạng, PHÂN BIỆT CHỮ HOA/THƯỜNG (case-sensitive):

\`\`\`
<<Ten_placeholder>>
{{Ten_placeholder}}
\`\`\`

Cả hai dạng tương đương và có thể trộn lẫn trong cùng 1 file. Tên bên trong (\`Ten_placeholder\`) là khoá ngữ nghĩa (semantic key) — **PHẢI giữ nguyên chính xác từng ký tự, kể cả hoa/thường**, trừ khi operator CHỦ ĐỘNG yêu cầu đổi tên.

## 2. Placeholder hiện có trong phiên bản này (${manifest.placeholderCount} placeholder)

${placeholderList || "(phiên bản này chưa có placeholder nào)"}

## 3. Quy tắc BẮT BUỘC khi chỉnh sửa

1. **KHÔNG tự ý đổi tên placeholder đã có.** Nếu cần đổi tên, phải giữ placeholder CŨ VÀ MỚI cùng lúc, hoặc hỏi lại operator — không âm thầm rename, vì mỗi placeholder gắn với 1 mapping dữ liệu thật trong hệ thống (xem \`template-manifest.json\`).
2. **KHÔNG tự bịa ra mapping mới.** AI không biết nguồn dữ liệu thật (CSDL) — chỉ được thêm/giữ placeholder, KHÔNG được tự gán giá trị mẫu/giả vào vị trí đó trong HTML.
3. **KHÔNG thay đổi nội dung pháp lý** (câu chữ cam kết, điều khoản, quốc hiệu, tiêu ngữ...) trừ khi operator yêu cầu rõ ràng. Nếu chỉ được yêu cầu sửa LAYOUT, giữ nguyên 100% câu chữ.
4. Nếu THÊM placeholder mới, đặt tên rõ nghĩa, tiếng Việt không dấu, dùng \`_\` phân cách từ (vd \`Ngay_ky_hop_dong\`) — theo đúng phong cách các placeholder hiện có ở mục 2.
5. Nếu XOÁ placeholder, phải chắc chắn operator đã đồng ý — dữ liệu ứng viên gắn với placeholder đó sẽ không còn xuất hiện trong bản in.

## 4. Canonical runtime là HTML/CSS

Tài liệu cuối cùng được render bằng Chromium (Playwright) từ ĐÚNG \`template.html\` + \`print.css\` này (cộng CSS A4 chung của hệ thống) — không phải Word/PDF. Nếu operator đưa kèm 1 file Word/PDF đã sửa, hãy dùng nó CHỈ để biết nội dung/layout mới cần có, rồi thể hiện lại bằng HTML/CSS hợp lệ — không nhúng ảnh chụp màn hình Word, không copy style của Word.

## 5. Hành vi in A4 — rất quan trọng

- Khổ giấy A4 (210×297mm), margin 12mm mỗi cạnh (do hệ thống tự thêm).
- Dữ liệu ứng viên có ĐỘ DÀI THAY ĐỔI: tên/địa chỉ có thể rất ngắn hoặc rất dài tuỳ người. Bản in phải đúng với MỌI ứng viên, không chỉ ứng viên có dữ liệu ngắn.

## 6. Quy tắc CSS bắt buộc quanh dữ liệu động (placeholder)

Với BẤT KỲ phần tử nào chứa placeholder (dữ liệu ứng viên), tuyệt đối:

- **KHÔNG dùng \`height\` cố định** (px/pt/mm/cm) quanh vùng chứa placeholder — dùng \`min-height\` nếu cần, hoặc để chiều cao tự nhiên. Mô hình đúng: dữ liệu ngắn → 1 dòng; dữ liệu dài → tự xuống dòng → khối chứa tự giãn → nội dung phía sau tự đẩy xuống.
- **KHÔNG dùng \`overflow: hidden\`** quanh dữ liệu động — dữ liệu dài sẽ bị cắt mất thay vì xuống dòng.
- **KHÔNG dùng \`white-space: nowrap\`** quanh dữ liệu động — địa chỉ/tên dài cần xuống dòng tự nhiên.
- **KHÔNG dùng \`position: absolute\`/\`fixed\`** cho khối chứa dữ liệu động — dữ liệu dài có thể đè lên nội dung khác.
- **KHÔNG giả định số trang cố định.** Ứng viên có dữ liệu dài có thể tạo ra nhiều trang hơn ứng viên có dữ liệu ngắn — đây là hành vi ĐÚNG, không phải lỗi.
- Nếu cần ngắt trang có kiểm soát, dùng \`break-inside\`/\`page-break-inside\` GIỚI HẠN vào 1 class cụ thể (vd \`.signature-block { break-inside: avoid; }\`) — KHÔNG áp dụng toàn cục (vd \`td { break-inside: avoid; }\`) vì có thể ép 1 khối chứa dữ liệu dài không được ngắt trang.
- Vùng KHÔNG chứa dữ liệu động (ô ảnh 3x4, khoảng trắng chữ ký) được phép có \`height\` cố định bình thường — đây không phải vấn đề.

## 6b. Đường viền bảng (table border) — GIỮ ĐÚNG Ý ĐỊNH THIẾT KẾ

Hệ thống MẶC ĐỊNH vẽ viền 1px cho MỌI \`<td>\`/\`<th>\` trong MỌI \`<table>\` — kể cả khi \`template.html\`/\`print.css\` không khai báo border nào. Đây là hành vi có chủ đích để các bảng dữ liệu chính thức (mẫu đơn, bảng khai) luôn có lưới rõ ràng khi in.

- Nếu bạn dùng \`<table>\` CHỈ để canh layout (ví dụ đặt cạnh nhau khối "Người lao động" / "Đại diện công ty" ở phần chữ ký, hoặc canh ngày/tháng/năm) và KHÔNG muốn hiển thị đường viền, PHẢI thêm \`class="no-border"\` vào đúng thẻ \`<table>\` đó. Hệ thống đã có sẵn quy tắc \`.no-border, .no-border th, .no-border td { border: none; }\` — không cần tự viết CSS này.
- **KHÔNG** viết một quy tắc CSS toàn cục kiểu \`table, td, th { border: none; }\` hay tương tự trong \`print.css\` — quy tắc toàn cục sẽ xoá viền của MỌI bảng khác trong tài liệu, kể cả các bảng dữ liệu chính thức cần viền.
- Bảng dữ liệu chính thức (không phải bảng layout) thì GIỮ NGUYÊN không thêm class gì — viền mặc định là đúng ý định.

## 6c. Chiều rộng trang (page width) — PHÂN BIỆT KHỔ TRANG vs NỘI DUNG BÊN TRONG

Khổ giấy A4 vật lý là 210mm; sau margin 12mm mỗi bên, vùng có thể in chỉ còn khoảng 186mm.

- Khối trang ngoài cùng (thường mang class \`page\` hoặc \`paper\`) ĐƯỢC PHÉP khai báo \`width: 210mm\` — đó là khổ giấy, không phải lỗi.
- **KHÔNG** đặt \`width: 210mm\` (hay bất kỳ giá trị cố định nào ≥190mm) cho bảng/khối NẰM BÊN TRONG khối trang đó — nội dung bên trong phải dùng \`width: 100%\` (hoặc để trống, mặc định), để tự co giãn theo vùng in thực tế thay vì tràn ra ngoài khi in.

## 7. Sau khi chỉnh sửa

Trả lại ĐẦY ĐỦ \`template.html\` và \`print.css\` (không phải diff/patch từng phần) để operator dán trực tiếp vào ô "Sửa HTML/CSS" của hệ thống, sau đó bấm **"Phân tích thay đổi"** (Analyze) để xem placeholder/mapping/layout bị ảnh hưởng TRƯỚC KHI lưu — quy trình này KHÔNG tự động lưu hay xuất bản bất cứ điều gì.
`;
}

export interface AiExportFileEntry {
  name: string;
  content: string;
}

/** Build the 4 in-memory files for the AI export package (no I/O). */
export function buildAiExportFiles(manifest: TemplateManifest, htmlBody: string, printCss: string): AiExportFileEntry[] {
  return [
    { name: "template.html", content: htmlBody ?? "" },
    { name: "print.css", content: printCss ?? "" },
    { name: "template-manifest.json", content: JSON.stringify(manifest, null, 2) },
    { name: "README-AI.md", content: buildReadmeAi(manifest) },
  ];
}

/** Zip the given files (exact names, no sequence prefix) into a Buffer. */
export async function buildAiExportZip(files: AiExportFileEntry[]): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const file of files) {
    zip.addBuffer(Buffer.from(file.content, "utf-8"), file.name);
  }
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
