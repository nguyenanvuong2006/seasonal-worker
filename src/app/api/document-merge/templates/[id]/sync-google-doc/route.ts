/**
 * POST /api/document-merge/templates/[id]/sync-google-doc
 *
 * ADMIN action: "Đồng bộ Google Doc → phiên bản HTML mới".
 *
 * Reads the template's Google Doc, converts it to canonical HTML + print CSS,
 * and creates a NEW DRAFT version of merge_template_versions.
 *
 * HARD GUARANTEES:
 *   - NEVER publishes (status stays DRAFT; current_published_version untouched)
 *   - NEVER overwrites or deletes a historical version
 *   - STOPS and reports the limitation if conversion cannot faithfully
 *     preserve the approved document (no approximation is stored)
 *
 * After this call the operator must Preview the draft and then explicitly
 * Publish it before any production job can use it.
 */

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requirePermission, writeAudit } from "@/lib/auth";
import { db } from "@/db";
import { mergeTemplateFields, mergeTemplates } from "@/db/schema";
import { createGoogleDocsService } from "@/lib/document-merge/google-docs-service";
import {
  CANONICAL_SYNC_ACTION_LABEL,
  CanonicalSyncError,
  canonicalSyncSourceName,
  convertGoogleDocHtmlToCanonical,
} from "@/lib/document-merge/canonical-sync";
import {
  createTemplateVersion,
  scanPlaceholdersInVersionHtml,
  TemplateVersionError,
} from "@/lib/document-merge/template-versions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Export the Google Doc as HTML. text/plain is deliberately NOT accepted —
 * it cannot preserve the approved layout, tables or checkboxes.
 */
async function exportGoogleDocHtml(googleDocId: string): Promise<string> {
  const service = createGoogleDocsService(process.env.GOOGLE_ACCESS_TOKEN) as unknown as {
    exportDocumentHtml?: (id: string) => Promise<string>;
    getDocumentContent: (id: string) => Promise<string>;
  };
  if (typeof service.exportDocumentHtml === "function") {
    return service.exportDocumentHtml(googleDocId);
  }
  return service.getDocumentContent(googleDocId);
}

export async function POST(_request: Request, context: RouteContext) {
  const guard = await requirePermission(["ADMIN"], "document_merge.templates.manage");
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  try {
    const { id } = await context.params;

    const [template] = await db.select().from(mergeTemplates).where(eq(mergeTemplates.id, id)).limit(1);
    if (!template) {
      return NextResponse.json(
        { code: "TEMPLATE_NOT_FOUND", error: "Không tìm thấy template.", action: "Kiểm tra templateId." },
        { status: 404 },
      );
    }
    if (!template.googleDocId) {
      return NextResponse.json(
        {
          code: "GOOGLE_DOC_NOT_CONFIGURED",
          error: "Template chưa cấu hình Google Doc nguồn.",
          action: "Thêm Google Doc ID trong Template Configuration rồi đồng bộ lại.",
        },
        { status: 422 },
      );
    }

    const exported = await exportGoogleDocHtml(template.googleDocId);

    // Existing (non-orphaned) mapping tokens, used only to report drift.
    const fields = await db
      .select({ placeholder: mergeTemplateFields.placeholder })
      .from(mergeTemplateFields)
      .where(eq(mergeTemplateFields.templateId, template.id));

    const converted = convertGoogleDocHtmlToCanonical(exported, template.googleDocId, {
      expectedPlaceholders: fields.map((field) => field.placeholder),
    });

    const now = new Date();
    // Creates a NEW version. createTemplateVersion always inserts DRAFT and
    // never touches an existing row.
    const version = await createTemplateVersion(template.id, guard.session.username, {
      htmlBody: converted.htmlBody,
      printCss: converted.printCss,
      sourceDocxName: canonicalSyncSourceName(template.googleDocId, now),
      retentionYears: template.retentionYears ?? null,
    });

    await writeAudit(guard.session, "SYNC_GOOGLE_DOC_TEMPLATE_VERSION", "merge_template_versions", {
      templateId: template.id,
      googleDocId: template.googleDocId,
      version: version.version,
      status: version.status,
      logicalPageCount: converted.logicalPageCount,
      placeholderCount: converted.placeholders.length,
      warningCount: converted.warnings.length,
    });

    return NextResponse.json(
      {
        action: CANONICAL_SYNC_ACTION_LABEL,
        version,
        status: version.status,
        published: false,
        placeholders: scanPlaceholdersInVersionHtml(converted.htmlBody),
        logicalPageCount: converted.logicalPageCount,
        warnings: converted.warnings,
        note:
          `Đã tạo phiên bản ${version.version} ở trạng thái DRAFT (CHƯA xuất bản). ` +
          "Hãy Preview bản nháp này, kiểm tra kỹ bố cục/nội dung, rồi bấm Xuất bản. " +
          "Các phiên bản cũ được giữ nguyên để audit/rollback.",
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof CanonicalSyncError) {
      // STOP and report the limitation — never publish an approximation.
      return NextResponse.json(
        {
          code: error.code,
          error: error.operatorMessage,
          limitations: error.limitations,
          action:
            "Xuất Google Doc dưới dạng HTML có cấu trúc, hoặc chỉnh sửa canonical source thủ công. " +
            "Hệ thống KHÔNG tạo bản gần đúng.",
          published: false,
        },
        { status: error.status },
      );
    }
    if (error instanceof TemplateVersionError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[document-merge/templates/[id]/sync-google-doc] error:", error);
    return NextResponse.json(
      { code: "SYNC_FAILED", error: "Không đồng bộ được Google Doc sang phiên bản HTML." },
      { status: 500 },
    );
  }
}
