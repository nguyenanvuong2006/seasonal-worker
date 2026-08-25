/**
 * POST /api/document-merge/templates/[id]/versions/[versionId]/unsaved-print
 *
 * H2 — UNSAVED PRINT/PDF ACCEPTANCE VIEW (Phase 8). The saved print route
 * (../print/route.ts) is a GET with the applicant id in the query string —
 * that cannot carry the megabyte-scale HTML an operator may paste, and this
 * content has not been written anywhere yet, so there is no versionId to GET
 * it back from. This route is the SAME print architecture (injectPrintTooling
 * + the canonical renderer, top-level `window.print()`, never a sandboxed
 * `iframe.contentWindow.print()`) adapted to accept the pasted content
 * directly, via a REAL HTML <form method="post" target="_blank"> submit —
 * the operator's browser opens this response as a normal top-level document
 * in a new tab, so `window.print()` works exactly like the saved print view.
 *
 * Body: application/x-www-form-urlencoded or multipart/form-data with fields
 * applicationId, rawHtml, explicitCss (optional), autoprint ("1" optional).
 * A JSON body is also accepted for programmatic/test callers.
 *
 * WHAT THIS ROUTE PROVABLY DOES NOT DO — identical guarantees to
 * unsaved-preview/route.ts: SELECT-only, no job/version/mapping/publish
 * writes, no persistence of the pasted HTML anywhere (never persisted merely
 * to print it — Phase 8's explicit constraint).
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
import { isCandidateInScope, selectPreviewMappings } from "@/lib/document-merge/draft-preview";
import { injectPrintTooling } from "@/lib/document-merge/print-preview";
import { normalizeFullHtmlDocument } from "@/lib/document-merge/full-document-normalizer";
import { analyzeTemplateSecurity } from "@/lib/document-merge/ai-template-security";
import { buildUnresolvedPlaceholderTitle } from "@/lib/document-merge/unresolved-placeholder-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string; versionId: string }> };

const MAX_HTML_LENGTH = 2_000_000;
const MAX_CSS_LENGTH = 500_000;

function errorPage(status: number, title: string, message: string, action?: string): Response {
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
<body>
<div class="card">
<h1>${title}</h1>
<p>${message}</p>
${action ? `<p><small>${action}</small></p>` : ""}
</div>
</body>
</html>`;
  return new NextResponse(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

async function readRequestFields(request: Request): Promise<{ applicationId: string; rawHtml: string; explicitCss: string; autoPrint: boolean }> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    return {
      applicationId: typeof body.applicationId === "string" ? body.applicationId.trim() : "",
      rawHtml: typeof body.rawHtml === "string" ? body.rawHtml : "",
      explicitCss: typeof body.explicitCss === "string" ? body.explicitCss : "",
      autoPrint: body.autoprint === "1" || body.autoprint === true,
    };
  }
  const form = await request.formData();
  const get = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value : "";
  };
  return {
    applicationId: get("applicationId").trim(),
    rawHtml: get("rawHtml"),
    explicitCss: get("explicitCss"),
    autoPrint: get("autoprint") === "1",
  };
}

export async function POST(request: Request, context: RouteContext) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "document_merge.templates.manage");
  if (!guard.ok) {
    return errorPage(guard.status, "Không có quyền mở bản in", guard.error, "Đăng nhập lại bằng tài khoản có quyền quản lý mẫu tài liệu.");
  }

  try {
    const { id: templateId, versionId } = await context.params;
    const { applicationId, rawHtml, explicitCss, autoPrint } = await readRequestFields(request);

    if (!applicationId) {
      return errorPage(400, "Thiếu ứng viên", "Không xác định được ứng viên để dựng bản in.", "Quay lại bản xem trước, chọn ứng viên rồi mở lại bản in.");
    }
    if (!rawHtml.trim()) {
      return errorPage(400, "Thiếu nội dung HTML", "Không có nội dung HTML để dựng bản in.", "Dán nội dung HTML rồi thử lại.");
    }
    if (rawHtml.length > MAX_HTML_LENGTH || explicitCss.length > MAX_CSS_LENGTH) {
      return errorPage(413, "Nội dung quá lớn", "Nội dung HTML/CSS vượt quá giới hạn cho phép.");
    }

    const [template] = await db.select().from(mergeTemplates).where(eq(mergeTemplates.id, templateId)).limit(1);
    if (!template) {
      return errorPage(404, "Không tìm thấy mẫu tài liệu", "Mẫu tài liệu này không tồn tại hoặc đã bị xoá.", "Tải lại danh sách mẫu và mở lại bản in.");
    }

    const [version] = await db
      .select()
      .from(mergeTemplateVersions)
      .where(and(eq(mergeTemplateVersions.id, versionId), eq(mergeTemplateVersions.templateId, templateId)))
      .limit(1);
    if (!version) {
      return errorPage(404, "Không tìm thấy phiên bản", "Phiên bản này không tồn tại trong mẫu tài liệu đã chọn.", "Tải lại danh sách phiên bản của mẫu và mở lại bản in.");
    }

    const scope = await getUserScope(guard.session);
    const [candidate] = await db
      .select({ id: dailyApplications.id, deptId: dailyApplications.deptId })
      .from(dailyApplications)
      .where(and(eq(dailyApplications.id, applicationId), isNull(dailyApplications.deletedAt)))
      .limit(1);
    if (!candidate || !isCandidateInScope(scope, candidate.deptId)) {
      return errorPage(404, "Không tìm thấy ứng viên", "Không thể mở bản in cho ứng viên này trong phạm vi dữ liệu của bạn.", "Tìm lại ứng viên trong hộp thoại xem trước rồi mở lại bản in.");
    }

    const normalized = normalizeFullHtmlDocument(rawHtml);
    const normalizedPrintCss = [explicitCss, normalized.extractedCss]
      .filter((chunk): chunk is string => Boolean(chunk && chunk.trim()))
      .join("\n\n");

    const security = analyzeTemplateSecurity(normalized.htmlBody, normalizedPrintCss);
    if (security.errors.length > 0) {
      return errorPage(422, "Nội dung không an toàn", "Nội dung HTML/CSS chứa mã không an toàn — không thể dựng bản in.", "Xoá các thẻ/kiểu không an toàn rồi thử lại.");
    }

    const fields = await db
      .select()
      .from(mergeTemplateFields)
      .where(and(eq(mergeTemplateFields.templateId, templateId), eq(mergeTemplateFields.isOrphaned, false)));

    const { mappings } = selectPreviewMappings(version, fields);
    if (mappings.length === 0) {
      return errorPage(422, "Chưa có placeholder mapping", `Mẫu “${template.name}” chưa có placeholder mapping đang hoạt động, nên không dựng được bản in.`, "Mở Mapping Inspector, kiểm tra mapping rồi tạo lại bản xem trước.");
    }

    const records = await loadDailyApplicationRecords([applicationId]);
    const recordData = records.get(applicationId);
    if (!recordData) {
      return errorPage(404, "Không tìm thấy hồ sơ ứng viên", "Không thể đọc hồ sơ ứng viên để dựng bản in.", "Tìm lại ứng viên rồi mở lại bản in.");
    }

    const previewContext: MergeContext = {
      currentUserId: guard.session.id,
      currentUserName: guard.session.fullName,
      currentDate: new Date(),
      mergeIndex: 1,
      mergeCount: 1,
    };

    const virtualVersion = { ...version, htmlBody: normalized.htmlBody, printCss: normalizedPrintCss };

    const snapshot = buildCanonicalSnapshot({
      templateId,
      version: virtualVersion,
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
    const printHtml = injectPrintTooling(
      rendered.html,
      {
        templateName: template.name,
        version: version.version,
        versionStatus: `${version.status} · CHƯA LƯU`,
        fullName: typeof recordData.fullName === "string" ? recordData.fullName : undefined,
        cccd: typeof recordData.cccd === "string" ? recordData.cccd : undefined,
        // DEFECT A / Phase 11 (print parity): the SAME guard unsaved-preview
        // uses, so an operator can never print/save a PDF with unresolved
        // placeholders without a prominent warning here too.
        warning: buildUnresolvedPlaceholderTitle(rendered.unreplaced),
      },
      { autoPrint },
    );

    return new NextResponse(printHtml, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-print-view": "1",
        "x-print-document": "unsaved-preview",
        "x-print-version": String(version.version),
        "x-print-status": version.status,
        "x-print-mode": "UNSAVED_HTML_PREVIEW",
        "x-print-pages": String(pageCount),
      },
    });
  } catch (error) {
    if (isCanonicalTemplateError(error)) {
      return errorPage(422, "Không dựng được bản in", error.operatorMessage, error.action ?? CANONICAL_ACTION_VI);
    }
    console.error("[document-merge/templates/[id]/versions/[versionId]/unsaved-print] error:", error);
    return errorPage(500, "Không dựng được bản in", "Có lỗi khi dựng bản in. Vui lòng thử lại.", "Kiểm tra nội dung HTML/CSS đã dán rồi thử lại.");
  }
}
