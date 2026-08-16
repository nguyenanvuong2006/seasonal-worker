/**
 * POST /api/document-merge/templates/[id]/scan
 * Quét placeholders <<...>> từ Google Docs và đồng bộ mapping theo tài liệu hiện tại.
 */

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requirePermission, writeAudit } from "@/lib/auth";
import { db } from "@/db";
import { fieldDefinitions, formQuestions, mergeTemplateFields, mergeTemplates } from "@/db/schema";
import { extractUniquePlaceholders } from "@/lib/document-merge/placeholder-extractor";
import { createGoogleDocsService } from "@/lib/document-merge/google-docs-service";
import { autoMapAllPlaceholders } from "@/lib/document-merge/auto-mapping";
import { extractGoogleDocId } from "@/lib/document-merge/template-routing";

type RouteContext = { params: Promise<{ id: string }> };

type ScanDiagnostic = {
  code: string;
  error: string;
  action: string;
  details?: string;
};

function diagnoseScanError(error: unknown): ScanDiagnostic {
  const message = error instanceof Error ? error.message : String(error ?? "Unknown scan error");
  const lower = message.toLowerCase();

  if (
    lower.includes("chưa kết nối google docs") ||
    lower.includes("missing google oauth credentials") ||
    lower.includes("google_service_account") ||
    lower.includes("google_refresh_token")
  ) {
    return {
      code: "GOOGLE_AUTH_MISSING",
      error: "Document Merge chưa được kết nối với Google Docs/Drive.",
      action:
        "Cấu hình GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY (khuyến nghị) hoặc OAuth Refresh Token trên Vercel, sau đó redeploy.",
      details: message,
    };
  }

  if (lower.includes("401") || lower.includes("unauthorized") || lower.includes("invalid_grant")) {
    return {
      code: "GOOGLE_AUTH_INVALID",
      error: "Thông tin xác thực Google Docs/Drive không còn hợp lệ.",
      action:
        "Kiểm tra Service Account private key/OAuth refresh token trên Vercel. Nếu còn GOOGLE_ACCESS_TOKEN cũ dùng để debug, hãy xoá biến đó và redeploy.",
      details: message,
    };
  }

  if (lower.includes("403") || lower.includes("forbidden") || lower.includes("permission")) {
    return {
      code: "GOOGLE_TEMPLATE_FORBIDDEN",
      error: "Hệ thống không có quyền đọc Google Docs template này.",
      action:
        "Share Google Docs template cho đúng GOOGLE_SERVICE_ACCOUNT_EMAIL với quyền Editor; đồng thời kiểm tra Google Drive API và Google Docs API đã được bật.",
      details: message,
    };
  }

  if (lower.includes("404") || lower.includes("not found")) {
    return {
      code: "GOOGLE_TEMPLATE_NOT_FOUND",
      error: "Không tìm thấy Google Docs template hoặc Google Doc ID không còn hợp lệ.",
      action: "Kiểm tra lại Google Docs URL/ID trong Template rồi thử quét lại.",
      details: message,
    };
  }

  if (lower.includes("không đọc được google docs") || lower.includes("google api")) {
    return {
      code: "GOOGLE_API_ERROR",
      error: "Google Drive/Docs API trả về lỗi khi đọc template.",
      action:
        "Kiểm tra credential, quyền share tài liệu, Google Drive API/Docs API và deployment Vercel rồi thử lại.",
      details: message,
    };
  }

  return {
    code: "PLACEHOLDER_SCAN_FAILED",
    error: "Không thể quét placeholder từ Google Docs template.",
    action: "Kiểm tra cấu hình Google Docs/Drive và thử lại. Chi tiết kỹ thuật đã được ghi trong server log.",
    details: message,
  };
}

export async function POST(request: Request, context: RouteContext) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "document_merge.templates.manage");
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  const { id } = await context.params;

  try {
    let googleDocIdFromBody = "";
    try {
      const body = await request.json();
      googleDocIdFromBody = String(body.googleDocId ?? "").trim();
    } catch {
      googleDocIdFromBody = "";
    }

    const [template] = await db.select().from(mergeTemplates).where(eq(mergeTemplates.id, id)).limit(1);
    if (!template) {
      return NextResponse.json(
        {
          code: "TEMPLATE_NOT_FOUND",
          error: "Không tìm thấy Template trong hệ thống.",
          action: "Tải lại trang Document Merge Center và chọn lại Template.",
        },
        { status: 404 },
      );
    }

    const extracted = extractGoogleDocId(googleDocIdFromBody || template.googleDocId);
    const docId = (extracted || template.googleDocId || "").trim();
    if (!docId) {
      return NextResponse.json(
        {
          code: "GOOGLE_DOC_ID_REQUIRED",
          error: "Template chưa có Google Docs ID hợp lệ.",
          action: "Dán Google Docs URL/ID vào Template, lưu thông tin mẫu rồi quét lại.",
        },
        { status: 400 },
      );
    }

    // Không dùng GOOGLE_ACCESS_TOKEN tĩnh cho production scan. Service tự lấy
    // credential bền vững (Service Account / OAuth Refresh Token) và refresh token.
    const docsService = createGoogleDocsService();
    const content = await docsService.getDocumentContent(docId);
    const placeholders = extractUniquePlaceholders(content);

    const existingFields = await db
      .select()
      .from(mergeTemplateFields)
      .where(eq(mergeTemplateFields.templateId, id));
    const existingMap = new Map(existingFields.map((field) => [field.placeholder, field]));

    const definitions = await db.select().from(fieldDefinitions);
    const questions = await db.select().from(formQuestions).where(eq(formQuestions.isActive, true));
    const suggestions = autoMapAllPlaceholders(placeholders, definitions, questions);
    const suggestionMap = new Map(suggestions.map((item) => [item.placeholder, item]));

    // Google Docs hiện tại là source-of-truth cho danh sách placeholder.
    // Row cũ không còn trong tài liệu được giữ lại để audit/history nhưng đánh dấu
    // orphaned và sẽ không được trả về trong GET fields mặc định.
    const currentPlaceholderSet = new Set(placeholders);
    const orphanedFields = existingFields.filter((field) => !currentPlaceholderSet.has(field.placeholder));
    for (const field of orphanedFields) {
      if (field.isOrphaned) continue;
      await db
        .update(mergeTemplateFields)
        .set({ isOrphaned: true, updatedAt: new Date() })
        .where(eq(mergeTemplateFields.id, field.id));
    }

    const newFields = [];
    const reactivatedFields: string[] = [];
    for (const placeholder of placeholders) {
      const existing = existingMap.get(placeholder);
      if (existing) {
        // Nếu placeholder từng bị xoá rồi được đưa trở lại Google Docs, kích hoạt
        // lại mapping cũ nhưng KHÔNG ghi đè cấu hình mapping thủ công của người dùng.
        if (existing.isOrphaned) {
          await db
            .update(mergeTemplateFields)
            .set({ isOrphaned: false, updatedAt: new Date() })
            .where(eq(mergeTemplateFields.id, existing.id));
          reactivatedFields.push(placeholder);
        }
        continue;
      }

      const suggestion = suggestionMap.get(placeholder);
      const [created] = await db
        .insert(mergeTemplateFields)
        .values({
          templateId: id,
          placeholder,
          sourceType: suggestion?.sourceType ?? "CORE_FIELD",
          isSuggested: Boolean(suggestion),
          isOrphaned: false,
          isRequired: false,
          sourceField: suggestion?.sourceField ?? null,
          sourcePath: suggestion ? `${suggestion.sourceEntity}.${suggestion.sourceField}` : null,
          sourceEntity: suggestion?.sourceEntity ?? null,
        })
        .returning();
      newFields.push(created);
    }

    const allFields = await db.select().from(mergeTemplateFields).where(eq(mergeTemplateFields.templateId, id));
    const activeFields = allFields.filter((field) => !field.isOrphaned);

    await writeAudit(guard.session, "SCAN_MERGE_TEMPLATE", "merge_templates", {
      templateId: id,
      googleDocId: docId,
      placeholderCount: placeholders.length,
      newPlaceholderCount: newFields.length,
      hiddenPlaceholderCount: orphanedFields.length,
      reactivatedPlaceholderCount: reactivatedFields.length,
    });

    return NextResponse.json({
      placeholders,
      newFields,
      hiddenFields: orphanedFields.map((field) => field.placeholder),
      reactivatedFields,
      suggestions: suggestions.filter((item) => item.confidence >= 0.7),
      // totalFields/activeFields đều phản ánh tài liệu Google Docs hiện tại để UI
      // không tiếp tục hiển thị các placeholder đã bị xoá khỏi mẫu merge.
      totalFields: activeFields.length,
      activeFields: activeFields.length,
    });
  } catch (error) {
    console.error("[document-merge/templates/scan] error:", error);
    const diagnostic = diagnoseScanError(error);
    return NextResponse.json(diagnostic, { status: 500 });
  }
}
