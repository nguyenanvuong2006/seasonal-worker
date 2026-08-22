/**
 * GET /api/document-merge/templates/[id]/pdf-versions/[versionId]/blank-pdf
 * Tải blank PDF nền của version (bytes) từ StorageProvider — cho mapper preview.
 */

import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { getPdfTemplateVersion } from "@/lib/document-merge/pdf-overlay/version-service";
import { retrieveBlankPdf } from "@/lib/document-merge/pdf-overlay/pdf-storage";

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

    const bytes = await retrieveBlankPdf(version.pdfStorageKey);
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": `attachment; filename="template-v${version.version}.pdf"`,
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch (error) {
    console.error("[document-merge/templates/[id]/pdf-versions/[vId]/blank-pdf] error:", error);
    return NextResponse.json({ error: "Blank PDF không tồn tại hoặc không đọc được." }, { status: 404 });
  }
}
