/**
 * PATCH  /api/document-merge/templates/[id]/versions/[versionId]
 * DELETE /api/document-merge/templates/[id]/versions/[versionId]
 *
 * PATCH — Sửa HTML/CSS của một version DRAFT (editor "Sửa HTML/CSS" trong
 * Template Library). Server-side guard trong updateTemplateVersionDraft():
 *
 *   - Version phải thuộc template (id + templateId từ URL, cross-check SQL);
 *   - CHỈ DRAFT được UPDATE — PUBLISHED/ARCHIVED → 409, kể cả khi editor
 *     đã mở từ trước và version vừa chuyển trạng thái (guard nằm cả trong
 *     WHERE của câu UPDATE, không chỉ disable nút ở UI);
 *   - KHÔNG đổi status/mapping_snapshot/publishedAt/archivedAt.
 *
 * DELETE — XOÁ VĨNH VIỄN một version DRAFT ("Xóa bản nháp" trong Template
 * Library). Server-side guard trong deleteTemplateDraftVersion():
 *
 *   - CHỈ DRAFT được DELETE: version được re-read trong transaction ngay
 *     trước DELETE + điều kiện status='DRAFT' nằm trong WHERE của câu DELETE
 *     → race DRAFT→PUBLISHED fail closed (409), PUBLISHED/ARCHIVED bị từ
 *     chối kể cả khi gọi API trực tiếp;
 *   - Chặn xoá (409) nếu version đã xuất hiện trong document_history;
 *   - KHÔNG đổi current_published_version, KHÔNG đụng merge_template_fields
 *     (mapping template-global dùng chung), KHÔNG đụng snapshot/PDF/job/
 *     history của version khác, KHÔNG publish/archive bất kỳ version nào.
 *
 * Audit "DELETE_TEMPLATE_DRAFT_VERSION" chỉ ghi templateId/versionId/
 * versionNumber — KHÔNG ghi HTML/CSS, KHÔNG ghi PII ứng viên.
 *
 * Không có endpoint nào trùng chức năng: GET list /versions đã trả đủ row
 * (kể cả htmlBody/printCss); đây là route detail ĐẦU TIÊN của version.
 */

import { NextResponse } from "next/server";
import { requirePermission, writeAudit } from "@/lib/auth";
import {
  deleteTemplateDraftVersion,
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

    const marginFields = ["marginTopMm", "marginBottomMm", "marginLeftMm", "marginRightMm"] as const;
    for (const field of marginFields) {
      const value = (body as Record<string, unknown>)[field];
      if (value !== undefined && typeof value !== "number") {
        return NextResponse.json({ error: `${field} phải là số (mm).` }, { status: 400 });
      }
    }

    const updated = await updateTemplateVersionDraft(id, versionId, {
      htmlBody,
      printCss: typeof printCss === "string" ? printCss : null,
      marginTopMm: typeof (body as Record<string, unknown>).marginTopMm === "number" ? ((body as Record<string, unknown>).marginTopMm as number) : undefined,
      marginBottomMm: typeof (body as Record<string, unknown>).marginBottomMm === "number" ? ((body as Record<string, unknown>).marginBottomMm as number) : undefined,
      marginLeftMm: typeof (body as Record<string, unknown>).marginLeftMm === "number" ? ((body as Record<string, unknown>).marginLeftMm as number) : undefined,
      marginRightMm: typeof (body as Record<string, unknown>).marginRightMm === "number" ? ((body as Record<string, unknown>).marginRightMm as number) : undefined,
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

export async function DELETE(_request: Request, context: RouteContext) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "document_merge.templates.manage");
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  try {
    const { id, versionId } = await context.params;
    const deleted = await deleteTemplateDraftVersion(id, versionId);

    // Audit chỉ chứa identity (templateId/versionId/versionNumber) — tuyệt
    // đối KHÔNG ghi htmlBody/printCss của version, KHÔNG ghi PII ứng viên.
    await writeAudit(guard.session, "DELETE_TEMPLATE_DRAFT_VERSION", "merge_template_versions", {
      templateId: id,
      versionId: deleted.id,
      version: deleted.version,
    });

    return NextResponse.json({
      success: true,
      deleted: true,
      templateId: id,
      versionId: deleted.id,
      version: deleted.version,
      published: false,
      note:
        `Đã xoá vĩnh viễn bản nháp v${deleted.version}. Phiên bản đang xuất bản KHÔNG thay đổi; ` +
        "mapping của template và các phiên bản khác không bị ảnh hưởng.",
    });
  } catch (error) {
    if (error instanceof TemplateVersionError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[document-merge/templates/[id]/versions/[vId]] DELETE error:", error);
    return NextResponse.json({ error: "Failed to delete template draft version" }, { status: 500 });
  }
}
