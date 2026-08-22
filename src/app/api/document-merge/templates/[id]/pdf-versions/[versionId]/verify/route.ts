/**
 * GET /api/document-merge/templates/[id]/pdf-versions/[versionId]/verify
 * Verify integrity blank PDF (SHA-256 + page_count) so với metadata đã lưu.
 */

import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { getPdfTemplateVersion } from "@/lib/document-merge/pdf-overlay/version-service";
import { verifyBlankPdfIntegrity } from "@/lib/document-merge/pdf-overlay/pdf-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

    const result = await verifyBlankPdfIntegrity(version.pdfStorageKey, version.sha256, {
      expectedPageCount: version.pageCount,
    });

    return NextResponse.json({
      ok: result.ok,
      sha256: result.sha256,
      expectedSha256: result.expectedSha256,
      pageCount: result.pageCount,
      expectedPageCount: result.expectedPageCount,
      pageLayout: result.pageLayout,
    }, { status: result.ok ? 200 : 409 });
  } catch (error) {
    console.error("[document-merge/templates/[id]/pdf-versions/[vId]/verify] error:", error);
    return NextResponse.json({ error: "Không verify được blank PDF (có thể thiếu/corrupt)." }, { status: 404 });
  }
}
