/**
 * POST /api/document-merge/templates/[id]/import-docx
 * Import DOCX → HTML → version DRAFT (KHÔNG tự publish — Admin phải Preview
 * trước khi Publish vì conversion không giữ layout 100%, đúng spec D).
 *
 * Body: multipart/form-data, field "file" (DOCX).
 * Response: { version, placeholders: string[], warnings: string[] }
 */

import { NextResponse } from "next/server";
import { requirePermission, writeAudit } from "@/lib/auth";
import { convertDocxToHtml, DocxImportError } from "@/lib/document-merge/docx-import";
import {
  createTemplateVersion,
  TemplateVersionError,
  scanPlaceholdersInVersionHtml,
} from "@/lib/document-merge/template-versions";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

const MAX_FILE_BYTES = 10 * 1024 * 1024;

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
      return NextResponse.json({ error: "Cần upload file DOCX (field 'file')." }, { status: 400 });
    }
    if (!file.name.toLowerCase().endsWith(".docx")) {
      return NextResponse.json({ error: "Chỉ hỗ trợ file .docx." }, { status: 400 });
    }
    if (file.size > MAX_FILE_BYTES) {
      return NextResponse.json({ error: "File DOCX quá lớn (tối đa 10 MB)." }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const converted = await convertDocxToHtml(buffer);
    const placeholders = scanPlaceholdersInVersionHtml(converted.html);

    const version = await createTemplateVersion(id, guard.session.username, {
      htmlBody: converted.html,
      sourceDocxName: file.name,
    });

    await writeAudit(guard.session, "IMPORT_DOCX_TEMPLATE_VERSION", "merge_template_versions", {
      templateId: id,
      version: version.version,
      sourceDocxName: file.name,
      placeholderCount: placeholders.length,
      hasWarnings: converted.hasWarnings,
    });

    return NextResponse.json(
      {
        version,
        placeholders,
        placeholderCount: placeholders.length,
        warnings: converted.messages,
        hasWarnings: converted.hasWarnings,
        note: "Import tạo version DRAFT — conversion DOCX không giữ layout 100%, hãy Preview và kiểm tra trước khi Publish.",
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof DocxImportError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof TemplateVersionError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[document-merge/templates/[id]/import-docx] error:", error);
    return NextResponse.json({ error: "Không import được file DOCX." }, { status: 500 });
  }
}
