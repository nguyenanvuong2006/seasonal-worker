/**
 * Document Merge Engine — Execute Merge API
 *
 * POST /api/document-merge/merge/execute
 *
 * Hỗ trợ:
 * - Dual-template auto-route (Tài liệu A = DW Cũ, Tài liệu B = DW Mới)
 * - dispatchToApplicant: ghi link vào daily_applications để /lookup hiển thị
 * - Batch print: mỗi hồ sơ = 1 Google Doc giữ nguyên format, sau đó export + gộp PDF để in
 */

import { NextResponse } from "next/server";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { requirePermission, writeAudit, type Session } from "@/lib/auth";
import { db } from "@/db";
import {
  dailyApplications,
  departments,
  dwData,
  mergeJobs,
  mergeJobRecords,
  mergeTemplateFields,
  mergeTemplates,
  workerProfiles,
  type MergeTemplate,
  type MergeTemplateField,
} from "@/db/schema";
import { createGoogleDocsService } from "@/lib/document-merge/google-docs-service";
import { resolveAllFields, validateRequiredFields, type MergeContext } from "@/lib/document-merge/data-resolver";
import { applyFallbackPlaceholders, buildPreviewContent } from "@/lib/document-merge/preview-merge";
import { buildApplicantMergeRecord } from "@/lib/document-merge/applicant-record";
import { mergePdfBuffers } from "@/lib/document-merge/batch-pdf";
import { exportGoogleDocAsPdf, uploadPdfToDrive } from "@/lib/document-merge/google-drive-pdf";
import {
  documentKindLabel,
  googleDocEditUrl,
  googleDocPdfUrl,
  selectTemplateForApplicant,
} from "@/lib/document-merge/template-routing";

type MergeMode = "ONE_DOCUMENT" | "INDIVIDUAL_DOCUMENTS";

interface RecordSelection {
  entityType: "worker_profiles" | "employment_sessions" | "daily_applications";
  recordIds: string[];
}

type CreatedDocument = {
  outputDocId: string;
  outputUrl: string;
  outputPdfUrl: string;
};

function buildMergeContext(session: Session, index = 1, count = 1): MergeContext {
  return {
    currentUserId: session.id,
    currentUserName: session.fullName,
    currentDate: new Date(),
    mergeIndex: index,
    mergeCount: count,
  };
}

async function loadDailyApplicationRecords(recordIds: string[]): Promise<Map<string, Record<string, unknown>>> {
  const dataMap = new Map<string, Record<string, unknown>>();
  if (recordIds.length === 0) return dataMap;

  const rows = await db
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
    .where(and(inArray(dailyApplications.id, recordIds), isNull(dailyApplications.deletedAt)));

  for (const row of rows) {
    dataMap.set(
      row.application.id,
      buildApplicantMergeRecord({
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
          assignedBy: row.application.assignedBy,
          assignedByDisplayName: row.application.assignedByDisplayName,
          assignedAt: row.application.assignedAt,
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
      }),
    );
  }

  return dataMap;
}

async function loadWorkerProfileRecords(recordIds: string[]): Promise<Map<string, Record<string, unknown>>> {
  const dataMap = new Map<string, Record<string, unknown>>();
  const records = await db.select().from(workerProfiles).where(inArray(workerProfiles.id, recordIds));
  for (const record of records) {
    dataMap.set(record.id, { ...record });
  }
  return dataMap;
}

async function getRecordData(
  entityType: string,
  recordIds: string[],
): Promise<Map<string, Record<string, unknown>>> {
  if (entityType === "daily_applications") return loadDailyApplicationRecords(recordIds);
  if (entityType === "worker_profiles") return loadWorkerProfileRecords(recordIds);
  return new Map();
}

function resolveRecordContent(
  templateContent: string,
  fields: MergeTemplateField[],
  recordData: Record<string, unknown>,
  context: MergeContext,
): { content: string; fieldValues: Record<string, string>; missingFields: string[] } {
  const mapped = resolveAllFields(fields, recordData, context);
  const fieldValues = applyFallbackPlaceholders(recordData, mapped);
  const preview = buildPreviewContent(templateContent, fieldValues);
  const validation = validateRequiredFields(fields, fieldValues);
  return { content: preview.content, fieldValues, missingFields: validation.missingFields };
}

async function createMergedDocument(
  title: string,
  content: string,
  folderId?: string | null,
): Promise<CreatedDocument> {
  // Single-record production merge is intentionally simple and fast:
  // copy the original Google Docs template and replace all placeholders in one
  // batchUpdate. This preserves the original formatting and avoids rebuilding
  // paragraphs/tables for every candidate.
  const docsService = createGoogleDocsService(process.env.GOOGLE_ACCESS_TOKEN);
  const outputDocId = await docsService.createDocument(title, content, folderId || undefined);
  await docsService.updateDocumentContent(outputDocId, content);
  return {
    outputDocId,
    outputUrl: googleDocEditUrl(outputDocId),
    outputPdfUrl: googleDocPdfUrl(outputDocId),
  };
}

export async function POST(request: Request) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER", "HR_SUPPORT"], "document_merge.execute");
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  try {
    const body = await request.json();
    const {
      templateId,
      mergeMode,
      records,
      preflight,
      dispatchToApplicant,
      batchPrint,
      autoRoute,
    } = body as {
      templateId?: string;
      mergeMode?: MergeMode;
      records?: RecordSelection;
      preflight?: boolean;
      dispatchToApplicant?: boolean;
      batchPrint?: boolean;
      autoRoute?: boolean;
    };

    if (!records?.recordIds?.length) {
      return NextResponse.json({ error: "Cần chọn ít nhất 1 hồ sơ để merge." }, { status: 400 });
    }

    const entityType = records.entityType || "daily_applications";
    const shouldAutoRoute = autoRoute !== false && entityType === "daily_applications";
    const shouldDispatch = Boolean(dispatchToApplicant) && entityType === "daily_applications";
    const mode: MergeMode =
      batchPrint || mergeMode === "ONE_DOCUMENT" || (!mergeMode && batchPrint !== false && !shouldDispatch)
        ? "ONE_DOCUMENT"
        : mergeMode || "INDIVIDUAL_DOCUMENTS";
    const shouldBatchPrint = Boolean(batchPrint) || mode === "ONE_DOCUMENT";

    const allTemplates = await db.select().from(mergeTemplates);
    const activeTemplates = allTemplates.filter((item) => item.isActive);

    let forcedTemplate: MergeTemplate | null = null;
    if (templateId && !shouldAutoRoute) {
      forcedTemplate = allTemplates.find((item) => item.id === templateId) ?? null;
      if (!forcedTemplate) {
        return NextResponse.json({ error: "Template not found" }, { status: 404 });
      }
      if (!forcedTemplate.isActive) {
        return NextResponse.json({ error: "Template is inactive" }, { status: 400 });
      }
    }

    const dataMap = await getRecordData(entityType, records.recordIds);
    const contextBase = buildMergeContext(guard.session, 1, records.recordIds.length);

    type Planned = {
      recordId: string;
      recordData: Record<string, unknown>;
      template: MergeTemplate;
      kind: string;
    };
    const planned: Planned[] = [];
    const missingTemplateKinds = new Set<string>();

    for (const recordId of records.recordIds) {
      const recordData = dataMap.get(recordId);
      if (!recordData) continue;

      if (forcedTemplate) {
        planned.push({ recordId, recordData, template: forcedTemplate, kind: forcedTemplate.documentKind });
        continue;
      }

      const routed = selectTemplateForApplicant(activeTemplates, {
        declaredType: String(recordData.declaredType ?? ""),
        dwMatch: String(recordData.dwMatch ?? ""),
      });
      if (!routed.template) {
        missingTemplateKinds.add(routed.kind);
        continue;
      }
      planned.push({
        recordId,
        recordData,
        template: routed.template,
        kind: routed.kind,
      });
    }

    if (planned.length === 0) {
      return NextResponse.json(
        {
          error:
            missingTemplateKinds.size > 0
              ? `Chưa có mẫu đang hoạt động cho: ${[...missingTemplateKinds].map((k) => documentKindLabel(k)).join(", ")}.`
              : "Không tìm thấy hồ sơ hợp lệ để merge.",
        },
        { status: 422 },
      );
    }

    const templateIds = [...new Set(planned.map((item) => item.template.id))];
    const allFields = await db
      .select()
      .from(mergeTemplateFields)
      .where(and(inArray(mergeTemplateFields.templateId, templateIds), eq(mergeTemplateFields.isOrphaned, false)));
    const fieldsByTemplate = new Map<string, MergeTemplateField[]>();
    for (const field of allFields) {
      const list = fieldsByTemplate.get(field.templateId) ?? [];
      list.push(field);
      fieldsByTemplate.set(field.templateId, list);
    }

    if (preflight) {
      const validationResults: { recordId: string; missingFields: string[]; documentKind: string }[] = [];
      for (const item of planned) {
        const fields = fieldsByTemplate.get(item.template.id) ?? [];
        const resolved = resolveRecordContent("<<probe>>", fields, item.recordData, contextBase);
        if (resolved.missingFields.length > 0) {
          validationResults.push({
            recordId: item.recordId,
            missingFields: resolved.missingFields,
            documentKind: item.kind,
          });
        }
      }
      return NextResponse.json({
        preflight: true,
        valid: validationResults.length === 0,
        totalRecords: planned.length,
        totalPlaceholders: allFields.length,
        mappedPlaceholders: allFields.filter((field) => field.sourceField).length,
        autoRoute: shouldAutoRoute,
        validationResults,
      });
    }

    const primaryTemplate = planned[0].template;
    const [job] = await db
      .insert(mergeJobs)
      .values({
        templateId: primaryTemplate.id,
        templateNameSnapshot: shouldAutoRoute
          ? `Auto-route A/B (${planned.length} hồ sơ)`
          : primaryTemplate.name,
        mergeMode: shouldBatchPrint ? "ONE_DOCUMENT" : "INDIVIDUAL_DOCUMENTS",
        status: "RUNNING",
        recordCount: planned.length,
        createdBy: guard.session.username,
        startedAt: new Date(),
        metadata: {
          autoRoute: shouldAutoRoute,
          dispatchToApplicant: shouldDispatch,
          batchPrint: shouldBatchPrint,
          outputStrategy: shouldBatchPrint ? "INDIVIDUAL_DOCS_PLUS_BATCH_PDF" : "INDIVIDUAL_DOCS",
        },
      })
      .returning();

    await db.insert(mergeJobRecords).values(
      planned.map((item, index) => ({
        mergeJobId: job.id,
        sourceEntity: entityType,
        sourceRecordId: item.recordId,
        sortOrder: index,
        status: "PENDING",
      })),
    );

    try {
      const docsService = createGoogleDocsService(process.env.GOOGLE_ACCESS_TOKEN);
      const templateContentCache = new Map<string, string>();
      const getTemplateContent = async (googleDocId: string) => {
        const cached = templateContentCache.get(googleDocId);
        if (cached !== undefined) return cached;
        const content = await docsService.getDocumentContent(googleDocId);
        templateContentCache.set(googleDocId, content);
        return content;
      };

      const rendered: { recordId: string; content: string; kind: string; template: MergeTemplate; fullName: string }[] =
        [];

      for (let index = 0; index < planned.length; index++) {
        const item = planned[index];
        const templateContent = await getTemplateContent(item.template.googleDocId);
        const fields = fieldsByTemplate.get(item.template.id) ?? [];
        const context = buildMergeContext(guard.session, index + 1, planned.length);
        const resolved = resolveRecordContent(templateContent, fields, item.recordData, context);
        rendered.push({
          recordId: item.recordId,
          content: resolved.content,
          kind: item.kind,
          template: item.template,
          fullName: String(item.recordData.fullName ?? "ung-vien"),
        });
      }

      const createdByRecord = new Map<string, CreatedDocument>();
      const ensureCreated = async (item: (typeof rendered)[number]): Promise<CreatedDocument> => {
        const existing = createdByRecord.get(item.recordId);
        if (existing) return existing;
        const created = await createMergedDocument(
          `${item.kind}_${item.fullName}_${Date.now()}`,
          item.content,
          item.template.outputFolderId,
        );
        createdByRecord.set(item.recordId, created);
        return created;
      };

      const dispatched: {
        applicationId: string;
        docUrl: string;
        pdfUrl: string;
        documentKind: string;
        templateId: string;
      }[] = [];

      if (shouldDispatch) {
        const sentAt = new Date();
        for (const item of rendered) {
          const created = await ensureCreated(item);
          await db
            .update(dailyApplications)
            .set({
              mergedDocUrl: created.outputUrl,
              mergedDocPdfUrl: created.outputPdfUrl,
              mergedTemplateId: item.template.id,
              documentSentAt: sentAt,
              signatureDataUrl: null,
              signatureConfirmedAt: null,
              confirmedAnswers: {},
              updatedAt: sentAt,
            })
            .where(eq(dailyApplications.id, item.recordId));
          dispatched.push({
            applicationId: item.recordId,
            docUrl: created.outputUrl,
            pdfUrl: created.outputPdfUrl,
            documentKind: item.kind,
            templateId: item.template.id,
          });
        }
      }

      let printUrl: string | null = null;
      let printDocId: string | null = null;
      let outputUrl = dispatched[0]?.docUrl ?? "";
      let outputDocId = "";

      if (shouldBatchPrint) {
        // Fast path selected for this project:
        // 1 candidate = 1 exact copy of the source Google Docs template.
        // Only placeholder replacement writes to Docs. PDF export is read-only.
        // The PDFs are then merged server-side and uploaded once to Drive.
        const individualDocs: CreatedDocument[] = [];
        for (const item of rendered) individualDocs.push(await ensureCreated(item));

        const pdfBuffers: Uint8Array[] = [];
        for (const created of individualDocs) {
          pdfBuffers.push(await exportGoogleDocAsPdf(created.outputDocId));
        }
        const mergedPdf = await mergePdfBuffers(pdfBuffers);
        const uploadedPdf = await uploadPdfToDrive(
          `In_hang_loat_${planned.length}_${Date.now()}.pdf`,
          mergedPdf,
          primaryTemplate.outputFolderId,
        );

        printUrl = uploadedPdf.webViewLink || uploadedPdf.webContentLink;
        printDocId = uploadedPdf.id;
        outputUrl = printUrl || individualDocs[0]?.outputUrl || "";
        outputDocId = uploadedPdf.id;
      } else if (!shouldDispatch && rendered.length > 0) {
        const created = await ensureCreated(rendered[0]);
        outputUrl = created.outputUrl;
        outputDocId = created.outputDocId;
      }

      const individualDocs = rendered
        .map((item) => {
          const created = createdByRecord.get(item.recordId);
          if (!created) return null;
          return {
            recordId: item.recordId,
            fullName: item.fullName,
            templateId: item.template.id,
            documentKind: item.kind,
            docId: created.outputDocId,
            docUrl: created.outputUrl,
            pdfUrl: created.outputPdfUrl,
          };
        })
        .filter(Boolean);

      await db
        .update(mergeJobs)
        .set({
          status: "COMPLETED",
          outputDocId: outputDocId || printDocId || dispatched[0]?.docUrl || null,
          outputUrl: outputUrl || printUrl || dispatched[0]?.docUrl || null,
          completedAt: new Date(),
          metadata: {
            autoRoute: shouldAutoRoute,
            dispatchToApplicant: shouldDispatch,
            batchPrint: shouldBatchPrint,
            outputStrategy: shouldBatchPrint ? "INDIVIDUAL_DOCS_PLUS_BATCH_PDF" : "INDIVIDUAL_DOCS",
            printUrl,
            printDocId,
            dispatched,
            individualDocs,
            kinds: rendered.map((item) => item.kind),
          },
        })
        .where(eq(mergeJobs.id, job.id));

      await db
        .update(mergeJobRecords)
        .set({ status: "COMPLETED" })
        .where(eq(mergeJobRecords.mergeJobId, job.id));

      await writeAudit(guard.session, "EXECUTE_MERGE", "merge_jobs", {
        jobId: job.id,
        templateId: primaryTemplate.id,
        autoRoute: shouldAutoRoute,
        dispatchToApplicant: shouldDispatch,
        batchPrint: shouldBatchPrint,
        outputStrategy: shouldBatchPrint ? "INDIVIDUAL_DOCS_PLUS_BATCH_PDF" : "INDIVIDUAL_DOCS",
        recordCount: planned.length,
      });

      return NextResponse.json({
        success: true,
        jobId: job.id,
        outputDocId: outputDocId || printDocId,
        outputUrl: outputUrl || printUrl,
        printUrl,
        individualDocs,
        dispatched,
        dispatchedCount: dispatched.length,
        status: "COMPLETED",
      });
    } catch (mergeError) {
      const errorMessage = mergeError instanceof Error ? mergeError.message : "Unknown error";

      await db
        .update(mergeJobs)
        .set({
          status: "FAILED",
          error: errorMessage,
          completedAt: new Date(),
        })
        .where(eq(mergeJobs.id, job.id));

      await db
        .update(mergeJobRecords)
        .set({ status: "FAILED", error: errorMessage })
        .where(eq(mergeJobRecords.mergeJobId, job.id));

      await writeAudit(guard.session, "MERGE_FAILED", "merge_jobs", {
        jobId: job.id,
        error: errorMessage,
      });

      return NextResponse.json({ error: "Merge failed", details: errorMessage }, { status: 500 });
    }
  } catch (error) {
    console.error("[document-merge/merge/execute] POST error:", error);
    return NextResponse.json({ error: "Failed to execute merge" }, { status: 500 });
  }
}
