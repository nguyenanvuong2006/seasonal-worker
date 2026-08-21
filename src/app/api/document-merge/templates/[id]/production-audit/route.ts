/**
 * GET /api/document-merge/templates/[id]/production-audit
 *
 * READ-ONLY audit cho engine GOOGLE_DOCS (KHÁC HẲN merge_template_versions
 * DRAFT/PUBLISHED — bảng đó chỉ engine HTML_PDF dùng, xem
 * src/lib/document-merge/template-field-audit.ts để biết lý do). An toàn để
 * chạy trên PRODUCTION thật:
 *   - KHÔNG insert/update merge_template_fields (khác hẳn
 *     POST .../scan — route đó SẼ ghi isOrphaned + field mới, KHÔNG dùng ở đây).
 *   - KHÔNG tạo Google Doc nào, KHÔNG replace placeholder nào.
 *   - getDocumentContent() là Drive export (GET, đọc), documentExists() +
 *     getDocumentPermissions() cũng thuần đọc.
 *
 * Chỉ ADMIN. Không giới hạn non-production (đây là audit hạ tầng thật, giống
 * production-readiness — không phải Verification).
 */

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requirePermission } from "@/lib/auth";
import { db } from "@/db";
import { mergeTemplates, mergeTemplateFields } from "@/db/schema";
import { createGoogleDocsService } from "@/lib/document-merge/google-docs-service";
import { extractUniquePlaceholders } from "@/lib/document-merge/placeholder-extractor";
import { auditTemplateFields } from "@/lib/document-merge/template-field-audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const guard = await requirePermission(["ADMIN"], "document_merge.view");
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  const { id } = await context.params;
  const startedAt = Date.now();

  const [template] = await db.select().from(mergeTemplates).where(eq(mergeTemplates.id, id)).limit(1);
  if (!template) {
    return NextResponse.json({ error: "Template not found" }, { status: 404 });
  }

  const fields = await db.select().from(mergeTemplateFields).where(eq(mergeTemplateFields.templateId, id));

  let liveDocPlaceholders: string[] | null = null;
  let docReachable = false;
  let docPermissionTypes: string[] | null = null;
  let docError: string | null = null;

  try {
    const docsService = createGoogleDocsService(process.env.GOOGLE_ACCESS_TOKEN);
    docReachable = await docsService.documentExists(template.googleDocId);
    if (docReachable) {
      const content = await docsService.getDocumentContent(template.googleDocId);
      liveDocPlaceholders = extractUniquePlaceholders(content);
      docPermissionTypes = await docsService.getDocumentPermissions(template.googleDocId);
    }
  } catch (error) {
    docError = error instanceof Error ? error.message.slice(0, 500) : String(error);
  }

  const audit =
    liveDocPlaceholders !== null
      ? auditTemplateFields(
          liveDocPlaceholders,
          fields.map((f) => ({
            placeholder: f.placeholder,
            isRequired: f.isRequired,
            isOrphaned: f.isOrphaned,
            fallbackValue: f.fallbackValue,
          })),
        )
      : null;

  const warnings: string[] = [];
  if (!template.isActive) warnings.push("Template is_active=false — merge/execute sẽ từ chối tạo job cho template này (403/422 tuỳ nhánh gọi).");
  if (!template.outputFolderId) warnings.push("output_folder_id trống — Google Doc mới sẽ tạo ở My Drive gốc của tài khoản OAuth, KHÔNG nằm trong Production Drive root đã xác nhận.");
  if (!docReachable) warnings.push(`Không đọc được Google Doc nguồn (${docError ?? "documentExists=false"}) — kiểm tra quyền chia sẻ / OAuth scope (cần scope Docs, không chỉ Drive).`);
  if (audit) {
    if (audit.danglingInDoc.length > 0) warnings.push(`${audit.danglingInDoc.length} placeholder trong Google Doc CHƯA có field mapping — sẽ còn lại literal <<...>> trong output nếu không map trước khi merge thật.`);
    if (audit.staleInFields.length > 0) warnings.push(`${audit.staleInFields.length} field mapping không còn khớp placeholder nào trong doc hiện tại (chưa đánh dấu isOrphaned).`);
    if (audit.markedOrphanedButPresentInDoc.length > 0) warnings.push(`${audit.markedOrphanedButPresentInDoc.length} field đang đánh dấu isOrphaned nhưng placeholder đã có lại trong doc — dữ liệu isOrphaned có thể lỗi thời.`);
    if (audit.requiredWithoutFallback.length > 0) warnings.push(`${audit.requiredWithoutFallback.length} field required nhưng không có fallbackValue — record thiếu dữ liệu nguồn tương ứng sẽ bị preflight từ chối (không phải lỗi cấu hình, cần xác nhận bằng preflight với record thật).`);
  }

  return NextResponse.json({
    template: {
      id: template.id,
      name: template.name,
      isActive: template.isActive,
      googleDocId: template.googleDocId,
      outputFolderId: template.outputFolderId,
      documentKind: template.documentKind,
      defaultMergeMode: template.defaultMergeMode,
      htmlEnabled: template.htmlEnabled,
      currentPublishedVersion: template.currentPublishedVersion,
    },
    fieldCount: fields.length,
    fields: fields.map((f) => ({
      placeholder: f.placeholder,
      sourceType: f.sourceType,
      sourceEntity: f.sourceEntity,
      sourceField: f.sourceField,
      sourcePath: f.sourcePath,
      formatType: f.formatType,
      isRequired: f.isRequired,
      isOrphaned: f.isOrphaned,
      hasFallback: Boolean(f.fallbackValue?.trim()),
    })),
    googleDocs: {
      docReachable,
      docError,
      permissionTypes: docPermissionTypes,
      livePlaceholderCount: liveDocPlaceholders?.length ?? null,
    },
    audit,
    warnings,
    // GOOGLE_DOCS engine (merge/execute) KHÔNG BAO GIỜ đọc merge_template_versions
    // — publishedVersionCount/hasPublishedVersion không ảnh hưởng gì tới audit này.
    note: "Engine GOOGLE_DOCS đọc trực tiếp Google Doc sống qua google_doc_id — merge_template_versions (DRAFT/PUBLISHED) chỉ dùng cho engine HTML_PDF, không liên quan tới kết quả audit này.",
    durationMs: Date.now() - startedAt,
  });
}
