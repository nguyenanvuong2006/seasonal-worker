/**
 * POST /api/document-merge/templates/[id]/versions/[versionId]/clone
 *
 * "Tạo bản nháp từ phiên bản này" — server load version nguồn (theo
 * templateId + versionId từ URL, cross-check trong SQL) và CREATE một
 * version DRAFT mới copy html_body/print_css/retention_years. Xem
 * cloneTemplateVersion() cho đầy đủ invariants:
 *
 *   - KHÔNG UPDATE version nguồn (PUBLISHED immutable);
 *   - KHÔNG đổi merge_templates.current_published_version;
 *   - DRAFT mới mapping_snapshot = [] (freeze chỉ xảy ra lúc publish);
 *   - KHÔNG tạo merge job / document_history / KHÔNG dispatch worker;
 *   - version number do server tính trong transaction (retry khi xung đột);
 *     client KHÔNG gửi HTML nguồn hay version number.
 */

import { NextResponse } from "next/server";
import { requirePermission, writeAudit } from "@/lib/auth";
import {
  cloneTemplateVersion,
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
    const cloned = await cloneTemplateVersion(id, versionId, guard.session.username);

    await writeAudit(guard.session, "CLONE_TEMPLATE_VERSION", "merge_template_versions", {
      templateId: id,
      sourceVersionId: versionId,
      sourceVersion: cloned.sourceVersionNumber,
      version: cloned.version,
      versionId: cloned.id,
      status: cloned.status,
      published: false,
    });

    return NextResponse.json(
      {
        success: true,
        templateId: id,
        sourceVersionId: versionId,
        sourceVersion: cloned.sourceVersionNumber,
        versionId: cloned.id,
        version: cloned.version,
        status: cloned.status,
        published: false,
        note:
          `Đã tạo phiên bản ${cloned.version} (${cloned.status}) từ ${cloned.sourceVersionNumber}. ` +
          "Phiên bản nguồn không bị thay đổi. Hãy Sửa HTML/CSS, Xem trước bằng ứng viên thật rồi Xuất bản.",
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof TemplateVersionError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[document-merge/templates/[id]/versions/[vId]/clone] error:", error);
    return NextResponse.json({ error: "Failed to clone template version" }, { status: 500 });
  }
}
