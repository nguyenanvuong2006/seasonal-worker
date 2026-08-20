/**
 * POST /api/document-merge/templates/[id]/versions/[versionId]/publish
 * Publish version (snapshot mapping, archive version cũ, cập nhật current_published_version).
 */

import { NextResponse } from "next/server";
import { requirePermission, writeAudit } from "@/lib/auth";
import {
  publishTemplateVersion,
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
    const published = await publishTemplateVersion(id, versionId, guard.session.username);

    await writeAudit(guard.session, "PUBLISH_TEMPLATE_VERSION", "merge_template_versions", {
      templateId: id,
      version: published.version,
    });

    return NextResponse.json(published);
  } catch (error) {
    if (error instanceof TemplateVersionError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[document-merge/templates/[id]/versions/[vId]/publish] error:", error);
    return NextResponse.json({ error: "Failed to publish template version" }, { status: 500 });
  }
}
