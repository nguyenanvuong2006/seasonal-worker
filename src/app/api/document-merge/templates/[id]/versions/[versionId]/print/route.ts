/**
 * GET /api/document-merge/templates/[id]/versions/[versionId]/print
 *
 * PRINT-ONLY PREVIEW VIEW — the deterministic, mobile-safe way an operator gets
 * the native browser print dialog for the document they have already verified in
 * the Preview modal ("In / Lưu PDF TEST" / "Mở bản in").
 *
 * WHY THIS EXISTS
 * ---------------
 * `iframe.contentWindow.print()` on a `<iframe sandbox="allow-modals">` cannot
 * work: the sandboxed iframe is an OPAQUE origin, so the parent page is
 * cross-origin relative to it and `print()` is not a cross-origin-allowed
 * member — the call throws a SecurityError and the button "does nothing".
 * Chrome Android also does not reliably open the native dialog for a nested
 * iframe. So the modal opens THIS top-level document in a new tab; a top-level
 * `window.print()` opens the dialog for the Preview document on desktop Chrome
 * AND Chrome Android, and never prints the admin page.
 *
 * WHAT THIS ROUTE PROVABLY DOES (mirrors the read-only Preview route):
 *   - SELECT-only; never writes to any table;
 *   - never publishes (`publishTemplateVersion` is not imported);
 *   - never changes `merge_templates.current_published_version`;
 *   - never populates `merge_template_versions.mapping_snapshot`;
 *   - never creates a merge job / job record / document_history row;
 *   - never calls Google Docs/Drive, the Cloud Run worker, email or any side
 *     effect. It issues SELECTs only and returns an HTML string.
 *
 * VERSION SEMANTICS & SECURITY are IDENTICAL to the Preview route:
 *   - the version is loaded by its OWN id AND template id from the path, never
 *     by `current_published_version`, so an explicit DRAFT/PUBLISHED version is
 *     rendered exactly;
 *   - `selectPreviewMappings` keeps a PUBLISHED version on its frozen
 *     `mapping_snapshot` and lets a DRAFT resolve the CURRENT non-orphaned
 *     `merge_template_fields`;
 *   - ADMIN + `document_merge.templates.manage` permission;
 *   - the candidate is re-loaded server-side and filtered by the caller's Data
 *     Scope (`isCandidateInScope`), so no candidate data leaks to anyone out of
 *     scope;
 *   - the SAME shared canonical renderer (`renderCanonicalDocument`) that the
 *     Cloud Run HTML_PDF worker uses produces the printed document, so the
 *     print view is byte-identical to the Preview and to production.
 *
 * `autoprint=1` (set by the "In / Lưu PDF TEST" button) makes the opened page
 * call `window.print()` on load; without it (the "Mở bản in" fallback) the page
 * shows the A4 document with an in-page "In / Lưu PDF" button.
 */

import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { getUserScope, requirePermission } from "@/lib/auth";
import { db } from "@/db";
import {
  dailyApplications,
  mergeTemplateFields,
  mergeTemplates,
  mergeTemplateVersions,
} from "@/db/schema";
import {
  buildCanonicalSnapshot,
  CANONICAL_ACTION_VI,
  countCanonicalPages,
  isCanonicalTemplateError,
  renderCanonicalDocument,
} from "@/lib/document-merge/canonical-document";
import { loadDailyApplicationRecords } from "@/lib/document-merge/record-loader";
import { getHtmlTemplateContractByGoogleDocId } from "@/document-templates/registry";
import type { MergeContext } from "@/lib/document-merge/data-resolver";
import {
  isCandidateInScope,
  selectPreviewMappings,
  isUnpublishedPreview,
} from "@/lib/document-merge/draft-preview";
import { injectPrintTooling } from "@/lib/document-merge/print-preview";
import { parseSigningContext } from "@/lib/document-merge/signing-context";

const SIGNING_CONTEXT_QUERY_PARAMS = [
  "signingDate",
  "signingLocation",
  "documentDate",
  "receivedDate",
  "receivedBy",
  "signingLatitude",
  "signingLongitude",
  "signingLocationCapturedAt",
] as const;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string; versionId: string }> };

/** Minimal, printable error page so an unauthorised driver tab is not raw JSON. */
function errorPage(status: number, context: boolean, title: string, message: string, action?: string): Response {
  const banner = context
    ? `<div class="print-toolbar" data-print-toolbar><div class="pt-info"><span class="pt-title">${title}</span></div></div>`
    : "";
  const html = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
body { font-family: system-ui, sans-serif; background: #f8fafc; color: #0f172a; padding: 32px; }
.card { max-width: 640px; margin: 4rem auto; background: #fff; border: 1px solid #e2e8f0; border-radius: 16px; padding: 24px 28px; }
h1 { font-size: 18px; margin: 0 0 8px; }
p { font-size: 14px; margin: 8px 0; }
small { display: block; margin-top: 16px; color: #64748b; }
</style>
</head>
<body>${banner}
<div class="card">
<h1>${title}</h1>
<p>${message}</p>
${action ? `<p><small>${action}</small></p>` : ""}
</div>
</body>
</html>`;
  return new NextResponse(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function GET(request: Request, context: RouteContext) {
  // Layer 1+2: authenticated session, ADMIN role, template-management permission.
  const guard = await requirePermission(["ADMIN"], "document_merge.templates.manage");
  if (!guard.ok) {
    return errorPage(
      guard.status,
      false,
      "Không có quyền mở bản in",
      guard.error,
      "Đăng nhập lại bằng tài khoản quản trị có quyền quản lý mẫu tài liệu.",
    );
  }

  try {
    const { id: templateId, versionId } = await context.params;
    const url = new URL(request.url);
    const applicationId = url.searchParams.get("applicationId")?.trim() ?? "";
    const autoPrint = url.searchParams.get("autoprint") === "1";

    const rawSigningContext: Record<string, string> = {};
    for (const name of SIGNING_CONTEXT_QUERY_PARAMS) {
      const value = url.searchParams.get(name);
      if (value !== null) rawSigningContext[name] = value;
    }
    const signingContextResult = parseSigningContext(rawSigningContext);
    if (!signingContextResult.ok) {
      return errorPage(400, true, "Ngữ cảnh ký không hợp lệ", signingContextResult.error, "Kiểm tra lại Ngày ký / Địa điểm ký rồi thử lại.");
    }
    const signingContext = signingContextResult.context;

    if (!applicationId) {
      return errorPage(
        400,
        true,
        "Thiếu ứng viên",
        "Không xác định được ứng viên để dựng bản in. Hãy quay lại bản xem trước và chọn ứng viên rồi mở lại bản in.",
        "Chọn một ứng viên trong hộp thoại Xem trước rồi bấm lại In / Lưu PDF TEST.",
      );
    }

    const [template] = await db
      .select()
      .from(mergeTemplates)
      .where(eq(mergeTemplates.id, templateId))
      .limit(1);
    if (!template) {
      return errorPage(
        404,
        true,
        "Không tìm thấy mẫu tài liệu",
        "Mẫu tài liệu này không tồn tại hoặc đã bị xoá.",
        "Tải lại danh sách mẫu và mở lại bản in.",
      );
    }

    // Load the EXACT version requested — by id AND template id. Never by
    // merge_templates.current_published_version.
    const [version] = await db
      .select()
      .from(mergeTemplateVersions)
      .where(
        and(eq(mergeTemplateVersions.id, versionId), eq(mergeTemplateVersions.templateId, templateId)),
      )
      .limit(1);
    if (!version) {
      return errorPage(
        404,
        true,
        "Không tìm thấy phiên bản",
        "Phiên bản này không tồn tại trong mẫu tài liệu đã chọn.",
        "Tải lại danh sách phiên bản của mẫu và mở lại bản in.",
      );
    }

    // DATA SCOPE — resolve the candidate through the caller's authorised
    // departments. Out-of-scope ids are indistinguishable from missing ones.
    const scope = await getUserScope(guard.session);
    const [candidate] = await db
      .select({ id: dailyApplications.id, deptId: dailyApplications.deptId })
      .from(dailyApplications)
      .where(and(eq(dailyApplications.id, applicationId), isNull(dailyApplications.deletedAt)))
      .limit(1);
    if (!candidate || !isCandidateInScope(scope, candidate.deptId)) {
      return errorPage(
        404,
        true,
        "Không tìm thấy ứng viên",
        "Không thể mở bản in cho ứng viên này trong phạm vi dữ liệu của bạn.",
        "Tìm lại ứng viên trong hộp thoại xem trước rồi mở lại bản in.",
      );
    }

    // Current non-orphaned mapping — the same set pre-publish validation reads.
    const fields = await db
      .select()
      .from(mergeTemplateFields)
      .where(and(eq(mergeTemplateFields.templateId, templateId), eq(mergeTemplateFields.isOrphaned, false)));

    const { mappings } = selectPreviewMappings(version, fields);
    if (mappings.length === 0) {
      return errorPage(
        422,
        true,
        "Chưa có placeholder mapping",
        `Mẫu “${template.name}” chưa có placeholder mapping đang hoạt động, nên không dựng được bản in.`,
        "Mở Mapping Inspector, kiểm tra mapping rồi tạo lại bản xem trước.",
      );
    }

    // Same loader the HTML_PDF worker uses — preview data cannot drift.
    const records = await loadDailyApplicationRecords([applicationId]);
    const recordData = records.get(applicationId);
    if (!recordData) {
      return errorPage(
        404,
        true,
        "Không tìm thấy hồ sơ ứng viên",
        "Không thể đọc hồ sơ ứng viên để dựng bản in.",
        "Tìm lại ứng viên rồi mở lại bản in.",
      );
    }

    const previewContext: MergeContext = {
      currentUserId: guard.session.id,
      currentUserName: guard.session.fullName,
      currentDate: new Date(),
      mergeIndex: 1,
      mergeCount: 1,
      // H3 — resolved ONCE for this print render, mirroring the preview routes.
      signingContext,
    };

    // Build the SAME immutable snapshot shape a job freezes and render it with
    // the SAME canonical renderer the worker uses — the print view is the
    // canonical Preview document, never a reconstruction.
    const snapshot = buildCanonicalSnapshot({
      templateId,
      version,
      allowUnpublishedForVerification: true,
      mappings,
      formatting: {
        contractKey: template.googleDocId,
        retentionYears: version.retentionYears ?? null,
        documentKind: template.documentKind,
        templateName: template.name,
      },
    });

    const rendered = renderCanonicalDocument(snapshot, recordData, previewContext, {
      contract: getHtmlTemplateContractByGoogleDocId(template.googleDocId),
    });

    const pageCount = countCanonicalPages(rendered.html);
    const unpublished = isUnpublishedPreview(version);
    const printHtml = injectPrintTooling(rendered.html, {
      templateName: template.name,
      version: version.version,
      versionStatus: version.status,
      fullName: typeof recordData.fullName === "string" ? recordData.fullName : undefined,
      cccd: typeof recordData.cccd === "string" ? recordData.cccd : undefined,
    }, { autoPrint });

    return new NextResponse(printHtml, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-print-view": "1",
        "x-print-document": "preview",
        "x-print-version": String(version.version),
        "x-print-status": version.status,
        "x-print-mode": unpublished ? "DRAFT_VERSION_PREVIEW" : "PUBLISHED_PREVIEW",
        "x-print-pages": String(pageCount),
      },
    });
  } catch (error) {
    if (isCanonicalTemplateError(error)) {
      return errorPage(
        422,
        true,
        "Không dựng được bản in",
        error.operatorMessage,
        error.action ?? CANONICAL_ACTION_VI,
      );
    }
    console.error("[document-merge/templates/[id]/versions/[versionId]/print] error:", error);
    return errorPage(
      500,
      true,
      "Không dựng được bản in",
      "Có lỗi khi dựng bản in. Vui lòng thử lại.",
      "Kiểm tra nội dung HTML của phiên bản và mapping của mẫu rồi thử lại.",
    );
  }
}
