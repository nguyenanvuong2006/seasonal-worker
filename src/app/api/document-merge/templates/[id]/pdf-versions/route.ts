/**
 * Document Merge — PDF Overlay template versions API (PR2, management layer).
 *
 * GET  /api/document-merge/templates/[id]/pdf-versions   → list versions
 * POST /api/document-merge/templates/[id]/pdf-versions   → create DRAFT version
 *        (multipart/form-data, field "file" = blank PDF nền; không tự publish)
 *
 * Đây là tầng quản lý PDF Overlay — KHÔNG kích hoạt engine. Merge vẫn chạy
 * GOOGLE_DOCS. RBAC: document_merge.templates.manage (giống template versions).
 */

import { NextResponse } from "next/server";
import { requirePermission, writeAudit } from "@/lib/auth";
import {
  createPdfTemplateVersion,
  listPdfTemplateVersions,
  PdfTemplateVersionError,
} from "@/lib/document-merge/pdf-overlay/version-service";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

const MAX_PDF_BYTES = 25 * 1024 * 1024;

export async function GET(_request: Request, context: RouteContext) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "document_merge.templates.manage");
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  try {
    const { id } = await context.params;
    const versions = await listPdfTemplateVersions(id);
    return NextResponse.json(versions);
  } catch (error) {
    console.error("[document-merge/templates/[id]/pdf-versions] GET error:", error);
    return NextResponse.json({ error: "Failed to fetch PDF template versions" }, { status: 500 });
  }
}

export async function POST(request: Request, context: RouteContext) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "document_merge.templates.manage");
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  try {
    const { id } = await context.params;
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Cần upload file PDF (field 'file')." }, { status: 400 });
    }
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      return NextResponse.json({ error: "Chỉ hỗ trợ file .pdf." }, { status: 400 });
    }
    if (file.size > MAX_PDF_BYTES) {
      return NextResponse.json({ error: "File PDF quá lớn (tối đa 25 MB)." }, { status: 400 });
    }
    const sourceNoteEntry = form.get("sourceNote");
    const sourceNote = typeof sourceNoteEntry === "string" ? sourceNoteEntry : null;

    const bytes = new Uint8Array(await file.arrayBuffer());
    const version = await createPdfTemplateVersion(id, guard.session.username, {
      blankPdfBytes: bytes,
      blankPdfFileName: file.name,
      sourceNote: sourceNote ?? null,
    });

    await writeAudit(guard.session, "CREATE_PDF_TEMPLATE_VERSION", "pdf_template_versions", {
      templateId: id,
      version: version.version,
      status: version.status,
      pageCount: version.pageCount,
      sha256: version.sha256,
    });

    return NextResponse.json(version, { status: 201 });
  } catch (error) {
    if (error instanceof PdfTemplateVersionError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[document-merge/templates/[id]/pdf-versions] POST error:", error);
    return NextResponse.json({ error: "Failed to create PDF template version" }, { status: 500 });
  }
}
