/**
 * POST /api/document-merge/preview
 * Xem trước nội dung tài liệu merge của từng ứng viên với dữ liệu thật.
 * Không tạo file Google Docs — chỉ trả content + field values.
 */

import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { requirePermission } from "@/lib/auth";
import { db } from "@/db";
import {
  dailyApplications,
  departments,
  dwData,
  mergeTemplateFields,
  mergeTemplates,
  mergeTemplateVersions,
  workerProfiles,
} from "@/db/schema";
import { createGoogleDocsService } from "@/lib/document-merge/google-docs-service";
import { resolveAllFields, validateRequiredFields, type MergeContext } from "@/lib/document-merge/data-resolver";
import { applyFallbackPlaceholders, buildPreviewContent } from "@/lib/document-merge/preview-merge";
import { buildApplicantMergeRecord } from "@/lib/document-merge/applicant-record";
import { renderApplicantDocumentFromVersion } from "@/lib/document-merge/html-pipeline";
import { loadDailyApplicationRecords } from "@/lib/document-merge/record-loader";
import {
  documentKindLabel,
  resolveDocumentKind,
  resolveDwClassification,
  selectTemplateForApplicant,
} from "@/lib/document-merge/template-routing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Diagnostic = {
  code: string;
  error: string;
  action: string;
  details?: string;
};

function diagnosePreviewError(error: unknown): Diagnostic {
  const message = error instanceof Error ? error.message : String(error ?? "Unknown preview error");
  const lower = message.toLowerCase();

  if (
    lower.includes("chưa kết nối google docs") ||
    lower.includes("missing google oauth credentials") ||
    lower.includes("google_service_account") ||
    lower.includes("google_refresh_token")
  ) {
    return {
      code: "GOOGLE_AUTH_MISSING",
      error: "Document Merge chưa được kết nối với Google Docs/Drive.",
      action: "Cấu hình Service Account hoặc OAuth Refresh Token trong Vercel rồi deploy lại.",
      details: message,
    };
  }

  if (lower.includes("403") || lower.includes("forbidden") || lower.includes("permission")) {
    return {
      code: "GOOGLE_TEMPLATE_FORBIDDEN",
      error: "Hệ thống không có quyền đọc Google Docs template này.",
      action: "Share template cho Service Account/OAuth account đang dùng bởi Seasonal Worker và thử Preview lại.",
      details: message,
    };
  }

  if (lower.includes("404") || lower.includes("not found")) {
    return {
      code: "GOOGLE_TEMPLATE_NOT_FOUND",
      error: "Không tìm thấy Google Docs template hoặc Google Doc ID không còn hợp lệ.",
      action: "Kiểm tra Google Doc ID/URL trong Template Configuration, sau đó Scan Placeholders lại.",
      details: message,
    };
  }

  if (lower.includes("google api") || lower.includes("không đọc được google docs")) {
    return {
      code: "GOOGLE_API_ERROR",
      error: "Google Docs API trả về lỗi khi đọc template.",
      action: "Kiểm tra credential, quyền chia sẻ template và trạng thái Google Docs/Drive API.",
      details: message,
    };
  }

  return {
    code: "PREVIEW_FAILED",
    error: "Không thể xem trước tài liệu merge.",
    action: "Mở chi tiết kỹ thuật bên dưới hoặc kiểm tra Mapping Inspector của template trước khi thử lại.",
    details: message,
  };
}

/**
 * HTML VERSION PREVIEW — nhánh CHỈ ĐỌC, ADMIN-only, không dùng cho production job.
 *
 * Đây là đường an toàn DUY NHẤT để xem trước trực quan một template version
 * (kể cả DRAFT) qua ĐÚNG renderer HTML mà worker HTML_PDF dùng:
 *   `renderApplicantDocumentFromVersion` → `renderApplicantDocumentFromParts`
 *   → `renderApplicantHtmlFromParts` (cùng module mà worker import).
 *
 * KHÔNG publish, KHÔNG tạo merge_jobs / merge_job_records / document_history,
 * KHÔNG gọi Google Docs/Drive/Cloud Run, KHÔNG tạo PDF, KHÔNG email/dispatch,
 * KHÔNG UPDATE daily_applications / merge_templates / versions.
 */
async function handleHtmlVersionPreview(input: {
  applicationId: string;
  templateId: string;
  htmlVersion: unknown;
  autoRoute: boolean;
}): Promise<Response> {
  // Lớp bảo mật thứ hai: chỉ ADMIN được xem HTML DRAFT trực quan.
  const adminGuard = await requirePermission(["ADMIN"], "document_merge.history.view");
  if (!adminGuard.ok) {
    return NextResponse.json({ error: adminGuard.error }, { status: adminGuard.status });
  }

  const versionNumber = typeof input.htmlVersion === "number" ? input.htmlVersion : Number.NaN;
  if (!Number.isInteger(versionNumber) || versionNumber <= 0) {
    return NextResponse.json(
      {
        code: "HTML_VERSION_INVALID",
        error: "htmlVersion phải là số nguyên > 0.",
        action: "Truyền htmlVersion (vd 3) cùng templateId/applicationId/autoRoute:false khi muốn xem trước HTML của một version cụ thể.",
      },
      { status: 400 },
    );
  }

  if (!input.applicationId) {
    return NextResponse.json(
      {
        code: "APPLICATION_REQUIRED",
        error: "Thiếu applicationId để xem trước HTML version.",
        action: "Truyền applicationId của ứng viên thật.",
      },
      { status: 400 },
    );
  }

  if (!input.templateId) {
    return NextResponse.json(
      {
        code: "TEMPLATE_REQUIRED",
        error: "Thiếu templateId để xem trước HTML version.",
        action: "Truyền templateId cố định (không auto-route) khi dùng htmlVersion.",
      },
      { status: 400 },
    );
  }

  if (input.autoRoute !== false) {
    return NextResponse.json(
      {
        code: "HTML_VERSION_AUTO_ROUTE_FORBIDDEN",
        error: "htmlVersion preview yêu cầu autoRoute:false (template cố định).",
        action: "Truyền autoRoute:false để xem đúng templateId + htmlVersion đã chọn.",
      },
      { status: 400 },
    );
  }

  const [template] = await db
    .select()
    .from(mergeTemplates)
    .where(eq(mergeTemplates.id, input.templateId))
    .limit(1);
  if (!template) {
    return NextResponse.json(
      {
        code: "TEMPLATE_NOT_FOUND",
        error: "Không tìm thấy template.",
        action: "Kiểm tra templateId.",
        templateId: input.templateId,
      },
      { status: 404 },
    );
  }

  // Load ĐÚNG version được yêu cầu (DRAFT / PUBLISHED / ARCHIVED đều đọc được —
  // đây là nhánh preview chỉ-đọc; KHÔNG yêu cầu currentPublishedVersion).
  const [version] = await db
    .select()
    .from(mergeTemplateVersions)
    .where(
      and(
        eq(mergeTemplateVersions.templateId, input.templateId),
        eq(mergeTemplateVersions.version, versionNumber),
      ),
    )
    .limit(1);
  if (!version) {
    return NextResponse.json(
      {
        code: "VERSION_NOT_FOUND",
        error: `Template chưa có version ${String(input.htmlVersion)}.`,
        action: "Kiểm tra danh sách version trong Template Builder.",
        templateId: input.templateId,
        htmlVersion: input.htmlVersion,
      },
      { status: 404 },
    );
  }

  const fields = await db
    .select()
    .from(mergeTemplateFields)
    .where(and(eq(mergeTemplateFields.templateId, template.id), eq(mergeTemplateFields.isOrphaned, false)));
  if (fields.length === 0) {
    return NextResponse.json(
      {
        code: "MAPPING_MISSING",
        error: `Template “${template.name}” chưa có placeholder mapping đang hoạt động.`,
        action: "Mở Mapping Inspector và kiểm tra mapping trước khi Preview.",
        templateId: template.id,
        templateName: template.name,
      },
      { status: 422 },
    );
  }

  // CÙNG record loader mà HTML_PDF worker dùng (loadDailyApplicationRecords).
  const records = await loadDailyApplicationRecords([input.applicationId]);
  const recordData = records.get(input.applicationId);
  if (!recordData) {
    return NextResponse.json(
      {
        code: "APPLICATION_NOT_FOUND",
        error: "Không tìm thấy hồ sơ ứng viên.",
        action: "Tải lại danh sách và chọn lại ứng viên.",
      },
      { status: 404 },
    );
  }

  const context: MergeContext = {
    currentUserId: adminGuard.session.id,
    currentUserName: adminGuard.session.fullName,
    currentDate: new Date(),
    mergeIndex: 1,
    mergeCount: 1,
  };

  const rendered = renderApplicantDocumentFromVersion(version, fields, recordData, context);
  const pageCount = (rendered.html.match(/class="[^"]*\bpage\b[^"]*"/g) ?? []).length;
  const sectionCount = (rendered.html.match(/<section\b/gi) ?? []).length;

  return NextResponse.json({
    mode: "HTML_VERSION_PREVIEW",
    renderedHtml: rendered.html,
    version: version.version,
    versionStatus: version.status,
    templateId: template.id,
    templateName: template.name,
    templateKind: template.documentKind,
    recordId: input.applicationId,
    applicationId: input.applicationId,
    fullName: typeof recordData.fullName === "string" ? recordData.fullName : undefined,
    unresolved: rendered.unreplaced,
    missingFields: rendered.missingFields,
    valid: rendered.valid,
    pageCount,
    sectionCount,
    renderer: "renderApplicantDocumentFromVersion (shared HTML_PDF renderer)",
  });
}

export async function POST(request: Request) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER", "HR_SUPPORT"], "document_merge.execute");
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  try {
    const body = await request.json();
    const applicationId = String(body.applicationId ?? body.recordId ?? "").trim();
    const requestedTemplateId = body.templateId ? String(body.templateId) : "";
    const autoRoute = body.autoRoute !== false;
    const htmlVersion = body.htmlVersion;

    // Nhánh HTML VERSION PREVIEW (chỉ-đọc, ADMIN-only) — chỉ kích hoạt khi
    // client truyền RÕ `htmlVersion`. Vắng htmlVersion → giữ nguyên 100% hành
    // vi Google Docs preview cũ bên dưới.
    if (htmlVersion !== undefined && htmlVersion !== null) {
      return await handleHtmlVersionPreview({
        applicationId,
        templateId: requestedTemplateId,
        htmlVersion,
        autoRoute,
      });
    }

    if (!applicationId) {
      return NextResponse.json(
        {
          code: "APPLICATION_REQUIRED",
          error: "Thiếu applicationId để xem trước.",
          action: "Chọn một ứng viên trong danh sách đã xếp việc rồi bấm Preview.",
        },
        { status: 400 },
      );
    }

    const [row] = await db
      .select({
        application: dailyApplications,
        deptName: departments.deptName,
        groupName: departments.groupName,
        vnName: departments.vnName,
        location: departments.location,
        division: departments.division,
        section: departments.section,
        supervisor: departments.supervisor,
        supervisorPhone: departments.supervisorPhone,
        dw: dwData,
        worker: workerProfiles,
      })
      .from(dailyApplications)
      .leftJoin(departments, eq(dailyApplications.deptId, departments.id))
      .leftJoin(dwData, eq(dailyApplications.dwId, dwData.id))
      .leftJoin(
        workerProfiles,
        and(eq(dailyApplications.cccd, workerProfiles.cccd), isNull(workerProfiles.deletedAt)),
      )
      .where(and(eq(dailyApplications.id, applicationId), isNull(dailyApplications.deletedAt)))
      .limit(1);

    if (!row) {
      return NextResponse.json(
        {
          code: "APPLICATION_NOT_FOUND",
          error: "Không tìm thấy hồ sơ ứng viên.",
          action: "Tải lại danh sách và chọn lại ứng viên.",
        },
        { status: 404 },
      );
    }

    const kind = resolveDocumentKind({
      declaredType: row.application.declaredType,
      dwMatch: row.application.dwMatch,
    });
    const classification = resolveDwClassification({
      declaredType: row.application.declaredType,
      dwMatch: row.application.dwMatch,
    });

    const templates = await db.select().from(mergeTemplates).where(eq(mergeTemplates.isActive, true));

    let template = requestedTemplateId
      ? templates.find((item) => item.id === requestedTemplateId) ?? null
      : null;

    if (!template && requestedTemplateId) {
      const [explicit] = await db
        .select()
        .from(mergeTemplates)
        .where(eq(mergeTemplates.id, requestedTemplateId))
        .limit(1);
      template = explicit ?? null;
    }

    if (!template || autoRoute) {
      const routed = selectTemplateForApplicant(templates, {
        declaredType: row.application.declaredType,
        dwMatch: row.application.dwMatch,
      });
      if (!requestedTemplateId || autoRoute) {
        template = routed.template;
      }
    }

    if (!template) {
      return NextResponse.json(
        {
          code: "TEMPLATE_NOT_CONFIGURED",
          error: `Chưa có mẫu ${documentKindLabel(kind)} đang hoạt động.`,
          action: `Vào Template Configuration, tạo/kích hoạt Tài liệu ${kind} rồi Scan Placeholders trước khi Preview.`,
          documentKind: kind,
          dwClassification: classification,
        },
        { status: 422 },
      );
    }

    const fields = await db
      .select()
      .from(mergeTemplateFields)
      .where(and(eq(mergeTemplateFields.templateId, template.id), eq(mergeTemplateFields.isOrphaned, false)));

    if (fields.length === 0) {
      return NextResponse.json(
        {
          code: "MAPPING_MISSING",
          error: `Template “${template.name}” chưa có placeholder mapping đang hoạt động.`,
          action: "Mở Mapping Inspector, bấm Quét lại Google Docs và kiểm tra mapping trước khi Preview.",
          templateId: template.id,
          templateName: template.name,
        },
        { status: 422 },
      );
    }

    const recordData = buildApplicantMergeRecord({
      application: {
        id: row.application.id,
        cccd: row.application.cccd,
        fullName: row.application.fullName,
        gender: row.application.gender,
        dob: row.application.dob,
        phone: row.application.phone,
        ethnicity: row.application.ethnicity,
        permanentAddress: row.application.permanentAddress,
        residentialAddress: row.application.residentialAddress,
        declaredType: row.application.declaredType,
        dwMatch: row.application.dwMatch,
        dwCode: row.application.dwCode,
        itCode: row.application.itCode,
        workDuration: row.application.workDuration,
        referralChannel: row.application.referralChannel,
        status: row.application.status,
        regDate: row.application.regDate,
        startingDate: row.application.startingDate,
        customAnswers: row.application.customAnswers,
      },
      department: {
        deptName: row.deptName,
        groupName: row.groupName,
        vnName: row.vnName,
        location: row.location,
        division: row.division,
        section: row.section,
        supervisor: row.supervisor,
        supervisorPhone: row.supervisorPhone,
      },
      dw: row.dw,
      worker: row.worker,
    });

    const context: MergeContext = {
      currentUserId: guard.session.id,
      currentUserName: guard.session.fullName,
      currentDate: new Date(),
      mergeIndex: 1,
      mergeCount: 1,
    };

    const mapped = resolveAllFields(fields, recordData, context);
    const fieldValues = applyFallbackPlaceholders(recordData, mapped);
    const validation = validateRequiredFields(fields, fieldValues);

    const docsService = createGoogleDocsService(process.env.GOOGLE_ACCESS_TOKEN);
    const templateContent = await docsService.getDocumentContent(template.googleDocId);
    const preview = buildPreviewContent(templateContent, fieldValues);

    return NextResponse.json({
      applicationId: row.application.id,
      fullName: row.application.fullName,
      cccd: row.application.cccd,
      status: row.application.status,
      deptName: row.deptName,
      startingDate: row.application.startingDate,
      dwClassification: classification,
      documentKind: kind,
      documentKindLabel: documentKindLabel(kind),
      templateId: template.id,
      templateName: template.name,
      templateKind: template.documentKind,
      mappingSummary: {
        total: fields.length,
        mapped: fields.filter((field) => Boolean(field.sourceField || field.sourcePath || field.fallbackValue)).length,
        required: fields.filter((field) => field.isRequired).length,
        suggested: fields.filter((field) => field.isSuggested).length,
      },
      content: preview.content,
      fieldValues,
      unreplaced: preview.unreplaced,
      missingFields: validation.missingFields,
      valid: validation.valid && preview.unreplaced.length === 0,
    });
  } catch (error) {
    console.error("[document-merge/preview] POST error:", error);
    const diagnostic = diagnosePreviewError(error);
    return NextResponse.json(diagnostic, { status: 500 });
  }
}
