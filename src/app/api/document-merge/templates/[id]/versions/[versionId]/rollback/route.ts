/**
 * POST /api/document-merge/templates/[id]/versions/[versionId]/rollback
 * Rollback: publish lại version cũ (ARCHIVED/DRAFT) làm version hiện hành.
 */

import { NextResponse } from "next/server";
import { requirePermission, writeAudit } from "@/lib/auth";
import {
  rollbackTemplateVersion,
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
    const restored = await rollbackTemplateVersion(id, versionId, guard.session.username);

    await writeAudit(guard.session, "ROLLBACK_TEMPLATE_VERSION", "merge_template_versions", {
      templateId: id,
      version: restored.version,
    });

    return NextResponse.json(restored);
  } catch (error) {
    if (error instanceof TemplateVersionError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[document-merge/templates/[id]/versions/[vId]/rollback] error:", error);
    return NextResponse.json({ error: "Failed to rollback template version" }, { status: 500 });
  }
}
