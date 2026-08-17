/**
 * POST /api/document-merge/templates/[id]/versions/[versionId]/archive
 * Archive version (từ chối version đang PUBLISHED).
 */

import { NextResponse } from "next/server";
import { requirePermission, writeAudit } from "@/lib/auth";
import {
  archiveTemplateVersion,
  TemplateVersionError,
} from "@/lib/document-merge/template-versions";

type RouteContext = { params: Promise<{ id: string; versionId: string }> };

export async function POST(_request: Request, context: RouteContext) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "document_merge.templates.manage");
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  try {
    const { id, versionId } = await context.params;
    const archived = await archiveTemplateVersion(id, versionId);

    await writeAudit(guard.session, "ARCHIVE_TEMPLATE_VERSION", "merge_template_versions", {
      templateId: id,
      version: archived.version,
    });

    return NextResponse.json(archived);
  } catch (error) {
    if (error instanceof TemplateVersionError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[document-merge/templates/[id]/versions/[vId]/archive] error:", error);
    return NextResponse.json({ error: "Failed to archive template version" }, { status: 500 });
  }
}
