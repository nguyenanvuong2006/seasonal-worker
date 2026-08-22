/**
 * POST /api/document-merge/templates/[id]/pdf-versions/[versionId]/preview
 * PREVIEW KHÔNG-PRODUCTION cho mapper (PR3): render blank PDF + positions bằng
 * renderer pdf-lib với fieldValues do operator cung cấp (mock/không dữ liệu thật).
 *
 * KHÔNG gọi Production /run, KHÔNG tạo merge job, KHÔNG đụng dữ liệu nghiệp vụ.
 * Chỉ đọc blank PDF + positions của version và trả PDF bytes để mapper xem thử.
 *
 * RBAC: document_merge.templates.manage (giống mọi route quản lý PDF Overlay).
 */

import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { getPdfTemplateVersion } from "@/lib/document-merge/pdf-overlay/version-service";
import { retrieveBlankPdf } from "@/lib/document-merge/pdf-overlay/pdf-storage";
import { listPdfFieldPositions } from "@/lib/document-merge/pdf-overlay/position-service";
import { toPositionSpec } from "@/lib/document-merge/pdf-overlay/positions";
import { renderPdfOverlay } from "@/lib/document-merge/pdf-overlay/renderer";
import { PdfOverlayError } from "@/lib/document-merge/pdf-overlay/types";
import { readEmbeddedFontBytes } from "@/lib/document-merge/pdf-overlay/vietnamese-font";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string; versionId: string }> };

export async function POST(request: Request, context: RouteContext) {
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

    let body: { fieldValues?: Record<string, string> } = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }
    const fieldValues = body.fieldValues && typeof body.fieldValues === "object" ? body.fieldValues : {};

    const templatePdf = await retrieveBlankPdf(version.pdfStorageKey);
    const positions = await listPdfFieldPositions(versionId);
    if (positions.length === 0) {
      return NextResponse.json(
        { error: "Version chưa có field position nào — hãy đặt ít nhất 1 box trước khi preview." },
        { status: 400 },
      );
    }

    const specs = positions.map((p) => toPositionSpec(p));

    const result = await renderPdfOverlay(templatePdf, specs, fieldValues, {
      fontBytes: readEmbeddedFontBytes(),
      expectedPageCount: version.pageCount,
      subsetFont: true,
    });

    return new NextResponse(new Uint8Array(result.bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(result.bytes.byteLength),
        "Content-Disposition": `inline; filename="preview-v${version.version}.pdf"`,
        "Cache-Control": "no-store",
        "X-Preview-Sha256": result.sha256,
        "X-Preview-Positions-Drawn": String(result.positionsDrawn),
      },
    });
  } catch (error) {
    if (error instanceof PdfOverlayError) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          detail: error.detail,
        },
        { status: 422 },
      );
    }
    console.error("[document-merge/templates/[id]/pdf-versions/[vId]/preview] error:", error);
    return NextResponse.json({ error: "Không render được preview PDF." }, { status: 500 });
  }
}
