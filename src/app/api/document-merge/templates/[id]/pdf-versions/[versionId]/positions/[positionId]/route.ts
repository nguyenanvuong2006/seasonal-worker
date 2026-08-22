/**
 * GET   /api/document-merge/templates/[id]/pdf-versions/[versionId]/positions/[positionId]
 * PATCH /api/document-merge/templates/[id]/pdf-versions/[versionId]/positions/[positionId]
 * DELETE/api/document-merge/templates/[id]/pdf-versions/[versionId]/positions/[positionId]
 * (PATCH/DELETE chỉ trên version DRAFT — PUBLISHED/ARCHIVED immutable.)
 */

import { NextResponse } from "next/server";
import { requirePermission, writeAudit } from "@/lib/auth";
import {
  deletePdfFieldPosition,
  getPdfFieldPosition,
  updatePdfFieldPosition,
  PdfFieldPositionError,
  type UpdatePdfFieldPositionInput,
} from "@/lib/document-merge/pdf-overlay/position-service";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string; versionId: string; positionId: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "document_merge.templates.manage");
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  try {
    const { versionId, positionId } = await context.params;
    const position = await getPdfFieldPosition(versionId, positionId);
    if (!position) {
      return NextResponse.json({ error: "Position not found" }, { status: 404 });
    }
    return NextResponse.json(position);
  } catch (error) {
    console.error("[.../positions/[positionId]] GET error:", error);
    return NextResponse.json({ error: "Failed to fetch position" }, { status: 500 });
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "document_merge.templates.manage");
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  try {
    const { versionId, positionId } = await context.params;
    const body = (await request.json()) as UpdatePdfFieldPositionInput;
    const position = await updatePdfFieldPosition(versionId, positionId, body);

    await writeAudit(guard.session, "UPDATE_PDF_FIELD_POSITION", "pdf_field_positions", {
      versionId,
      positionId,
      placeholder: position.placeholder,
    });

    return NextResponse.json(position);
  } catch (error) {
    if (error instanceof PdfFieldPositionError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[.../positions/[positionId]] PATCH error:", error);
    return NextResponse.json({ error: "Failed to update position" }, { status: 500 });
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "document_merge.templates.manage");
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  try {
    const { versionId, positionId } = await context.params;
    await deletePdfFieldPosition(versionId, positionId);

    await writeAudit(guard.session, "DELETE_PDF_FIELD_POSITION", "pdf_field_positions", {
      versionId,
      positionId,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof PdfFieldPositionError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[.../positions/[positionId]] DELETE error:", error);
    return NextResponse.json({ error: "Failed to delete position" }, { status: 500 });
  }
}
