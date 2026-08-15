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
  workerProfiles,
} from "@/db/schema";
import { createGoogleDocsService } from "@/lib/document-merge/google-docs-service";
import { resolveAllFields, validateRequiredFields, type MergeContext } from "@/lib/document-merge/data-resolver";
import { applyFallbackPlaceholders, buildPreviewContent } from "@/lib/document-merge/preview-merge";
import { buildApplicantMergeRecord } from "@/lib/document-merge/applicant-record";
import {
  documentKindLabel,
  resolveDocumentKind,
  resolveDwClassification,
  selectTemplateForApplicant,
} from "@/lib/document-merge/template-routing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "document_merge.execute");
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  try {
    const body = await request.json();
    const applicationId = String(body.applicationId ?? body.recordId ?? "").trim();
    const requestedTemplateId = body.templateId ? String(body.templateId) : "";
    const autoRoute = body.autoRoute !== false;

    if (!applicationId) {
      return NextResponse.json({ error: "Thiếu applicationId để xem trước." }, { status: 400 });
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
      return NextResponse.json({ error: "Không tìm thấy hồ sơ ứng viên." }, { status: 404 });
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
          error: `Chưa có mẫu ${documentKindLabel(kind)} đang hoạt động. Hãy tạo Tài liệu ${kind} tại tab Templates.`,
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
      content: preview.content,
      fieldValues,
      unreplaced: preview.unreplaced,
      missingFields: validation.missingFields,
      valid: validation.valid && preview.unreplaced.length === 0,
    });
  } catch (error) {
    console.error("[document-merge/preview] POST error:", error);
    return NextResponse.json({ error: "Không thể xem trước tài liệu merge." }, { status: 500 });
  }
}
