/**
 * GET /api/document-merge/templates/[id]/pdf-versions/[versionId]
 * Chi tiết 1 PDF template version (metadata + blank PDF storage + page layout).
 */

import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { getPdfTemplateVersion } from "@/lib/document-merge/pdf-overlay/version-service";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string; versionId: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "document_merge.templates.manage");
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  try {
    const { id, versionId } = await context.params;
    const version = await getPdfTemplateVersion(id, versionId);
    if (!version) {
      return NextResponse.json({ error: "PDF template version not found" }, { status: 404 });
    }
    return NextResponse.json(version);
  } catch (error) {
    console.error("[document-merge/templates/[id]/pdf-versions/[versionId]] GET error:", error);
    return NextResponse.json({ error: "Failed to fetch PDF template version" }, { status: 500 });
  }
}
