/**
 * Document Merge — Template Versions API (Phase 3).
 *
 * GET  /api/document-merge/templates/[id]/versions   → list
 * POST /api/document-merge/templates/[id]/versions   → create DRAFT version
 */

import { NextResponse } from "next/server";
import { requirePermission, writeAudit } from "@/lib/auth";
import {
  createTemplateVersion,
  listTemplateVersions,
  TemplateVersionError,
} from "@/lib/document-merge/template-versions";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "document_merge.templates.manage");
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  try {
    const { id } = await context.params;
    const versions = await listTemplateVersions(id);
    return NextResponse.json(versions);
  } catch (error) {
    console.error("[document-merge/templates/[id]/versions] GET error:", error);
    return NextResponse.json({ error: "Failed to fetch template versions" }, { status: 500 });
  }
}

export async function POST(request: Request, context: RouteContext) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "document_merge.templates.manage");
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  try {
    const { id } = await context.params;
    const body = await request.json();
    const version = await createTemplateVersion(id, guard.session.username, {
      htmlBody: body.htmlBody ?? null,
      printCss: body.printCss ?? null,
      sourceDocxName: body.sourceDocxName ?? null,
      retentionYears: body.retentionYears ?? null,
    });

    await writeAudit(guard.session, "CREATE_TEMPLATE_VERSION", "merge_template_versions", {
      templateId: id,
      version: version.version,
      status: version.status,
    });

    return NextResponse.json(version, { status: 201 });
  } catch (error) {
    if (error instanceof TemplateVersionError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[document-merge/templates/[id]/versions] POST error:", error);
    return NextResponse.json({ error: "Failed to create template version" }, { status: 500 });
  }
}
