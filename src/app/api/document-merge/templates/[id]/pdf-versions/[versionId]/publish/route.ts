/**
 * POST /api/document-merge/templates/[id]/pdf-versions/[versionId]/publish
 * Publish version (atomic: archive PUBLISHED cũ + set mới; verify blank PDF integrity).
 */

import { NextResponse } from "next/server";
import { requirePermission, writeAudit } from "@/lib/auth";
import {
  publishPdfTemplateVersion,
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
    const published = await publishPdfTemplateVersion(id, versionId, guard.session.username);

    await writeAudit(guard.session, "PUBLISH_PDF_TEMPLATE_VERSION", "pdf_template_versions", {
      templateId: id,
      version: published.version,
    });

    return NextResponse.json(published);
  } catch (error) {
    if (error instanceof PdfTemplateVersionError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[document-merge/templates/[id]/pdf-versions/[vId]/publish] error:", error);
    return NextResponse.json({ error: "Failed to publish PDF template version" }, { status: 500 });
  }
}
