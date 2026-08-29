/**
 * Document Merge Engine — Execute Merge API
 *
 * POST /api/document-merge/merge/execute
 *
 * GOOGLE_DOCS engine — ASYNC since the 28–29/08 zombie incident:
 *   create durable QUEUED job + items → freeze the template/field snapshot
 *   into job.metadata → trigger the Cloud Run worker (after()) → return 202
 *   immediately. The worker claims items (FOR UPDATE SKIP LOCKED), heartbeats
 *   its lease through every Google stage, performs the Docs/Drive work and
 *   CAS-commits COMPLETED/FAILED (see worker/src/index.ts runGoogleDocsItem).
 *
 * WHY: the previous synchronous model performed 5+ sequential Google/Drive
 * calls inside ONE Vercel request; its bounded worst case (~6 min with retry
 * amplification) exceeds the platform maxDuration (300s Hobby default/max),
 * so a slow run could be hard-killed mid-flight — leaving a zombie
 * RUNNING/PENDING job that only a later recovery actor could close.
 *
 * Hỗ trợ:
 * - Dual-template auto-route (Tài liệu A = DW Cũ, Tài liệu B = DW Mới)
 * - dispatchToApplicant: ghi link vào daily_applications để /lookup hiển thị
 * - Batch print: mỗi hồ sơ = 1 Google Doc giữ nguyên format, sau đó export
 *   + gộp PDF để in (worker thực hiện)
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
import { resolveAllFields, validateRequiredFields, type MergeContext } from "@/lib/document-merge/data-resolver";
import { applyFallbackPlaceholders, buildPreviewContent } from "@/lib/document-merge/preview-merge";
import { buildApplicantMergeRecord } from "@/lib/document-merge/applicant-record";
import { documentKindLabel, selectTemplateForApplicant } from "@/lib/document-merge/template-routing";
import { ITEM_STATUS } from "@/lib/document-merge/queue-types";
import { runPreMergeStaleRecovery } from "@/lib/document-merge/pre-merge-recovery";
import { triggerPdfWorker } from "@/lib/document-merge/worker-trigger";

type MergeMode = "ONE_DOCUMENT" | "INDIVIDUAL_DOCUMENTS";

interface RecordSelection {
  entityType: "worker_profiles" | "employment_sessions" | "daily_applications";
  recordIds: string[];
}

/**
 * Field snapshot frozen into job.metadata.googleDocs.templates[tid].fields —
 * the worker resolves mapping deterministically from THIS snapshot, never from
 * the live merge_template_fields table (same immutability guarantee as the
 * HTML_PDF canonical snapshot).
 */
type GoogleDocsFieldSnapshot = {
  id: string;
  placeholder: string;
  sourceType: string;
  sourceEntity: string | null;
  sourceField: string | null;
  sourcePath: string | null;
  optionValue: string | null;
  formatType: string | null;
  fallbackValue: string | null;
  isRequired: boolean;
};

type GoogleDocsTemplateSnapshot = {
  templateId: string;
  name: string;
  documentKind: string;
  googleDocId: string;
  outputFolderId: string | null;
  fields: GoogleDocsFieldSnapshot[];
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

function toFieldSnapshot(field: MergeTemplateField): GoogleDocsFieldSnapshot {
  return {
    id: field.id,
    placeholder: field.placeholder,
    sourceType: field.sourceType,
    sourceEntity: field.sourceEntity,
    sourceField: field.sourceField,
    sourcePath: field.sourcePath,
    optionValue: field.optionValue,
    formatType: field.formatType,
    fallbackValue: field.fallbackValue,
    isRequired: field.isRequired,
  };
}

export async function POST(request: Request) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER", "HR_SUPPORT"], "document_merge.execute");
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  // INTERACTIVE STALE-MERGE RECOVERY (hotfix for the 28–29/08 zombie incident):
  // before creating a new job, close any stale GOOGLE_DOCS jobs left behind by
  // a previous execution that died (legacy synchronous zombies have PENDING
  // items that only this sweep can fail). Same liveness/CAS sweep as the cron
  // watchdog. Runs BEFORE the new job is inserted, never touches live jobs,
  // and can never block this merge (helper never throws; belt-and-braces catch
  // below guards the route too). The GET job-poll endpoint stays read-only.
  try {
    await runPreMergeStaleRecovery();
  } catch (recoveryError) {
    console.error(
      "[document-merge/merge/execute] pre-merge stale recovery error (merge continues):",
      recoveryError,
    );
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

    // FREEZE the GOOGLE_DOCS snapshot onto the job. The worker resolves every
    // record from THIS immutable snapshot — template content, Google Doc id,
    // output folder and the 49-placeholder mapping — never from live tables.
    const googleDocsTemplates: Record<string, GoogleDocsTemplateSnapshot> = {};
    for (const template of planned.map((item) => item.template)) {
      if (googleDocsTemplates[template.id]) continue;
      googleDocsTemplates[template.id] = {
        templateId: template.id,
        name: template.name,
        documentKind: template.documentKind,
        googleDocId: template.googleDocId,
        outputFolderId: template.outputFolderId ?? null,
        fields: (fieldsByTemplate.get(template.id) ?? []).map(toFieldSnapshot),
      };
    }

    // DURABLE ASYNC JOB — no Google call happens inside this HTTP request.
    const [job] = await db
      .insert(mergeJobs)
      .values({
        templateId: primaryTemplate.id,
        templateNameSnapshot: shouldAutoRoute
          ? `Auto-route A/B (${planned.length} hồ sơ)`
          : primaryTemplate.name,
        mergeMode: shouldBatchPrint ? "ONE_DOCUMENT" : "INDIVIDUAL_DOCUMENTS",
        status: "QUEUED",
        engine: "GOOGLE_DOCS",
        recordCount: planned.length,
        createdBy: guard.session.username,
        metadata: {
          autoRoute: shouldAutoRoute,
          dispatchToApplicant: shouldDispatch,
          batchPrint: shouldBatchPrint,
          outputStrategy: shouldBatchPrint ? "INDIVIDUAL_DOCS_PLUS_BATCH_PDF" : "INDIVIDUAL_DOCS",
          renderedAt: new Date().toISOString(),
          googleDocs: {
            batchPrint: shouldBatchPrint,
            dispatchToApplicant: shouldDispatch,
            outputStrategy: shouldBatchPrint ? "INDIVIDUAL_DOCS_PLUS_BATCH_PDF" : "INDIVIDUAL_DOCS",
            currentUserId: guard.session.id,
            currentUserName: guard.session.fullName,
            templates: googleDocsTemplates,
          },
        },
      })
      .returning();

    await db.insert(mergeJobRecords).values(
      planned.map((item, index) => ({
        mergeJobId: job.id,
        sourceEntity: entityType,
        sourceRecordId: item.recordId,
        sortOrder: index,
        templateId: item.template.id,
        status: ITEM_STATUS.QUEUED,
      })),
    );

    // The worker is the ONLY Google Docs executor now: claim (SKIP LOCKED) →
    // heartbeat lease → template read / copy / batchUpdate / PDF export /
    // upload → CAS COMPLETED/FAILED. Fire-and-forget via after() — the HTTP
    // request ends here, well inside the Vercel platform budget.
    triggerPdfWorker(job.id, request);

    await writeAudit(guard.session, "CREATE_MERGE_JOB", "merge_jobs", {
      jobId: job.id,
      engine: "GOOGLE_DOCS",
      templateId: primaryTemplate.id,
      autoRoute: shouldAutoRoute,
      dispatchToApplicant: shouldDispatch,
      batchPrint: shouldBatchPrint,
      outputStrategy: shouldBatchPrint ? "INDIVIDUAL_DOCS_PLUS_BATCH_PDF" : "INDIVIDUAL_DOCS",
      recordCount: planned.length,
    });

    return NextResponse.json(
      {
        success: true,
        jobId: job.id,
        status: "QUEUED",
        engine: "GOOGLE_DOCS",
        total: planned.length,
      },
      { status: 202 },
    );
  } catch (error) {
    console.error("[document-merge/merge/execute] POST error:", error);
    return NextResponse.json({ error: "Failed to execute merge" }, { status: 500 });
  }
}
