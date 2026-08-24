/**
 * PATCH /api/document-merge/templates/[id]/versions/[versionId]
 *
 * Sửa HTML/CSS của một version DRAFT (editor "Sửa HTML/CSS" trong Template
 * Library). Server-side guard trong updateTemplateVersionDraft():
 *
 *   - Version phải thuộc template (id + templateId từ URL, cross-check SQL);
 *   - CHỈ DRAFT được UPDATE — PUBLISHED/ARCHIVED → 409, kể cả khi editor
 *     đã mở từ trước và version vừa chuyển trạng thái (guard nằm cả trong
 *     WHERE của câu UPDATE, không chỉ disable nút ở UI);
 *   - KHÔNG đổi status/mapping_snapshot/publishedAt/archivedAt.
 *
 * Không có endpoint nào trùng chức năng: GET list /versions đã trả đủ row
 * (kể cả htmlBody/printCss); đây là route detail ĐẦU TIÊN của version.
 */

import { NextResponse } from "next/server";
import { requirePermission, writeAudit } from "@/lib/auth";
import {
  TemplateVersionError,
  updateTemplateVersionDraft,
} from "@/lib/document-merge/template-versions";

type RouteContext = { params: Promise<{ id: string; versionId: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "document_merge.templates.manage");
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  try {
    const { id, versionId } = await context.params;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Request body phải là JSON." }, { status: 400 });
    }
    const htmlBody = (body as { htmlBody?: unknown }).htmlBody;
    const printCss = (body as { printCss?: unknown }).printCss;
    if (typeof htmlBody !== "string" || htmlBody.trim().length === 0) {
      return NextResponse.json(
        { error: "htmlBody là bắt buộc và không được để trống." },
        { status: 400 },
      );
    }
    if (printCss !== undefined && printCss !== null && typeof printCss !== "string") {
      return NextResponse.json({ error: "printCss phải là chuỗi hoặc null." }, { status: 400 });
    }

    const updated = await updateTemplateVersionDraft(id, versionId, {
      htmlBody,
      printCss: typeof printCss === "string" ? printCss : null,
    });

    await writeAudit(guard.session, "UPDATE_TEMPLATE_VERSION_DRAFT", "merge_template_versions", {
      templateId: id,
      versionId: updated.id,
      version: updated.version,
      status: updated.status,
    });

    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof TemplateVersionError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[document-merge/templates/[id]/versions/[vId]] PATCH error:", error);
    return NextResponse.json({ error: "Failed to update template version draft" }, { status: 500 });
  }
}
