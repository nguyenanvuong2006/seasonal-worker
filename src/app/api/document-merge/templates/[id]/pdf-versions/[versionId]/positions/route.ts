/**
 * Document Merge — PDF Overlay field positions API (PR2, management layer).
 *
 * GET  /api/document-merge/templates/[id]/pdf-versions/[versionId]/positions → list
 * POST /api/document-merge/templates/[id]/pdf-versions/[versionId]/positions → create
 * PUT  /api/document-merge/templates/[id]/pdf-versions/[versionId]/positions → bulk upsert
 *
 * Chỉ thao tác trên version DRAFT (PUBLISHED/ARCHIVED immutable). RBAC:
 * document_merge.templates.manage.
 */

import { NextResponse } from "next/server";
import { requirePermission, writeAudit } from "@/lib/auth";
import {
  createPdfFieldPosition,
  listPdfFieldPositions,
  upsertPdfFieldPositions,
  PdfFieldPositionError,
  type NewPdfFieldPositionInput,
} from "@/lib/document-merge/pdf-overlay/position-service";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string; versionId: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "document_merge.templates.manage");
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  try {
    const { versionId } = await context.params;
    const positions = await listPdfFieldPositions(versionId);
    return NextResponse.json(positions);
  } catch (error) {
    if (error instanceof PdfFieldPositionError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[.../pdf-versions/[vId]/positions] GET error:", error);
    return NextResponse.json({ error: "Failed to fetch positions" }, { status: 500 });
  }
}

export async function POST(request: Request, context: RouteContext) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "document_merge.templates.manage");
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  try {
    const { versionId } = await context.params;
    const body = (await request.json()) as NewPdfFieldPositionInput;
    const position = await createPdfFieldPosition(versionId, body);

    await writeAudit(guard.session, "CREATE_PDF_FIELD_POSITION", "pdf_field_positions", {
      versionId,
      positionId: position.id,
      placeholder: position.placeholder,
      pageNumber: position.pageNumber,
    });

    return NextResponse.json(position, { status: 201 });
  } catch (error) {
    if (error instanceof PdfFieldPositionError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[.../pdf-versions/[vId]/positions] POST error:", error);
    return NextResponse.json({ error: "Failed to create position" }, { status: 500 });
  }
}

export async function PUT(request: Request, context: RouteContext) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "document_merge.templates.manage");
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  try {
    const { versionId } = await context.params;
    const body = (await request.json()) as { positions: NewPdfFieldPositionInput[] };
    const inputs = Array.isArray(body) ? body : body.positions;
    if (!Array.isArray(inputs)) {
      return NextResponse.json({ error: "Thiếu mảng positions." }, { status: 400 });
    }
    const positions = await upsertPdfFieldPositions(versionId, inputs);

    await writeAudit(guard.session, "UPSERT_PDF_FIELD_POSITIONS", "pdf_field_positions", {
      versionId,
      count: positions.length,
    });

    return NextResponse.json(positions);
  } catch (error) {
    if (error instanceof PdfFieldPositionError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[.../pdf-versions/[vId]/positions] PUT error:", error);
    return NextResponse.json({ error: "Failed to upsert positions" }, { status: 500 });
  }
}
