/**
 * POST /api/document-merge/templates/[id]/pdf-versions/[versionId]/archive
 * Archive version DRAFT (từ chối archive version đang PUBLISHED).
 */

import { NextResponse } from "next/server";
import { requirePermission, writeAudit } from "@/lib/auth";
import {
  archivePdfTemplateVersion,
  PdfTemplateVersionError,
} from "@/lib/document-merge/pdf-overlay/version-service";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string; versionId: string }> };

export async function POST(_request: Request, context: RouteContext) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "document_merge.templates.manage");
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  try {
    const { id, versionId } = await context.params;
    const archived = await archivePdfTemplateVersion(id, versionId);

    await writeAudit(guard.session, "ARCHIVE_PDF_TEMPLATE_VERSION", "pdf_template_versions", {
      templateId: id,
      version: archived.version,
    });

    return NextResponse.json(archived);
  } catch (error) {
    if (error instanceof PdfTemplateVersionError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[document-merge/templates/[id]/pdf-versions/[vId]/archive] error:", error);
    return NextResponse.json({ error: "Failed to archive PDF template version" }, { status: 500 });
  }
}
