/**
 * Document Merge — async job service (Phase 1).
 *
 * POST /api/document-merge/jobs chỉ làm:
 *   1. validate permission (ở route)
 *   2. validate template
 *   3. validate selected records (tồn tại + data scope)
 *   4. snapshot mapping (fields) vào metadata → worker render deterministic
 *   5. tạo merge_job (QUEUED)
 *   6. tạo merge_job_records (items, QUEUED, theo sequence)
 *   7. enqueue (worker trigger — Phase 3/4)
 *   8. trả jobId ngay (KHÔNG giữ HTTP request mở).
 *
 * Neon = job state only. KHÔNG lưu PDF binary.
 */

import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { dailyApplications, mergeJobRecords, mergeJobs, mergeTemplateFields, mergeTemplates } from "@/db/schema";
import { getDocumentMergeEngine, type DocumentMergeEngine } from "./engine-config.ts";
import { selectTemplateForApplicant, documentKindLabel } from "./template-routing.ts";
import { ITEM_STATUS, JOB_STATUS } from "./queue-types.ts";

export interface AsyncJobRecordsInput {
  entityType: string;
  recordIds: string[];
}

export interface CreateAsyncJobInput {
  templateId?: string | null;
  autoRoute?: boolean;
  records: AsyncJobRecordsInput;
  createdBy: string;
  /** Department ids user được phép thao tác (null = không giới hạn). */
  scopeDeptIds: string[] | null;
  mergeMode?: "ONE_DOCUMENT" | "INDIVIDUAL_DOCUMENTS";
  dispatchToApplicant?: boolean;
  engine?: DocumentMergeEngine;
}

export interface CreateAsyncJobResult {
  jobId: string;
  status: string;
  total: number;
  engine: DocumentMergeEngine;
}

interface PlannedRecord {
  recordId: string;
  templateId: string;
  kind: string;
  sortOrder: number;
}

/** Snapshot field mapping để worker render deterministic (không phụ thuộc mapping đổi sau đó). */
type FieldSnapshot = {
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

export class AsyncJobValidationError extends Error {
  constructor(message: string, public status = 422) {
    super(message);
    this.name = "AsyncJobValidationError";
  }
}

export async function createAsyncMergeJob(input: CreateAsyncJobInput): Promise<CreateAsyncJobResult> {
  const engine = input.engine ?? getDocumentMergeEngine();
  const { entityType, recordIds } = input.records;

  if (!recordIds?.length) {
    throw new AsyncJobValidationError("Cần chọn ít nhất 1 hồ sơ để merge.", 400);
  }
  if (entityType !== "daily_applications") {
    throw new AsyncJobValidationError(
      `Async engine (Phase 1) chỉ hỗ trợ daily_applications; nhận được "${entityType}".`,
      422,
    );
  }

  const shouldAutoRoute = input.autoRoute === true;
  const mergeMode = input.mergeMode ?? "ONE_DOCUMENT";
  const shouldDispatch = Boolean(input.dispatchToApplicant) && entityType === "daily_applications";

  // 2. Validate template
  const allTemplates = await db.select().from(mergeTemplates);
  const activeTemplates = allTemplates.filter((t) => t.isActive);

  let forcedTemplateId: string | null = null;
  if (input.templateId && !shouldAutoRoute) {
    const forced = allTemplates.find((t) => t.id === input.templateId);
    if (!forced) throw new AsyncJobValidationError("Template not found", 404);
    if (!forced.isActive) throw new AsyncJobValidationError("Template is inactive", 400);
    forcedTemplateId = forced.id;
  }

  // 3. Validate selected records (tồn tại + data scope)
  const conditions = [
    inArray(dailyApplications.id, recordIds),
    isNull(dailyApplications.deletedAt),
  ];
  if (input.scopeDeptIds !== null) {
    conditions.push(inArray(dailyApplications.deptId, input.scopeDeptIds));
  }
  const existing = await db
    .select({
      id: dailyApplications.id,
      declaredType: dailyApplications.declaredType,
      dwMatch: dailyApplications.dwMatch,
    })
    .from(dailyApplications)
    .where(and(...conditions));

  const byId = new Map(existing.map((r) => [r.id, r]));
  const missing = recordIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new AsyncJobValidationError(
      `${missing.length} hồ sơ không tồn tại hoặc ngoài phạm vi dữ liệu bạn được phép truy cập.`,
      422,
    );
  }

  // Resolve template cho từng record (manual selection là nguồn quyết định duy nhất;
  // auto route là OPTIONAL).
  const planned: PlannedRecord[] = [];
  const missingKinds = new Set<string>();
  let order = 0;
  for (const id of recordIds) {
    const rec = byId.get(id)!;
    order += 1;
    if (forcedTemplateId) {
      planned.push({ recordId: id, templateId: forcedTemplateId, kind: "", sortOrder: order });
      continue;
    }
    const routed = selectTemplateForApplicant(activeTemplates, {
      declaredType: rec.declaredType ?? "",
      dwMatch: rec.dwMatch ?? "",
    });
    if (!routed.template) {
      missingKinds.add(routed.kind);
      continue;
    }
    planned.push({ recordId: id, templateId: routed.template.id, kind: routed.kind, sortOrder: order });
  }

  if (planned.length === 0) {
    throw new AsyncJobValidationError(
      missingKinds.size > 0
        ? `Chưa có mẫu đang hoạt động cho: ${[...missingKinds].map((k) => documentKindLabel(k)).join(", ")}.`
        : "Không tìm thấy hồ sơ hợp lệ để merge.",
      422,
    );
  }

  // 4. Snapshot mapping
  const templateIds = [...new Set(planned.map((p) => p.templateId))];
  const fieldRows = await db
    .select()
    .from(mergeTemplateFields)
    .where(and(inArray(mergeTemplateFields.templateId, templateIds), eq(mergeTemplateFields.isOrphaned, false)));

  const fieldsByTemplate = new Map<string, FieldSnapshot[]>();
  for (const f of fieldRows) {
    const list = fieldsByTemplate.get(f.templateId) ?? [];
    list.push({
      placeholder: f.placeholder,
      sourceType: f.sourceType,
      sourceEntity: f.sourceEntity,
      sourceField: f.sourceField,
      sourcePath: f.sourcePath,
      optionValue: f.optionValue,
      formatType: f.formatType,
      fallbackValue: f.fallbackValue,
      isRequired: f.isRequired,
    });
    fieldsByTemplate.set(f.templateId, list);
  }

  const primaryTemplate = allTemplates.find((t) => t.id === planned[0].templateId) ?? null;

  // 5+6. Tạo job + items trong 1 khối (job QUEUED, items QUEUED theo sequence)
  const [job] = await db
    .insert(mergeJobs)
    .values({
      templateId: primaryTemplate?.id ?? null,
      templateNameSnapshot: shouldAutoRoute
        ? `Auto-route A/B (${planned.length} hồ sơ)`
        : primaryTemplate?.name ?? "Template",
      mergeMode: shouldDispatch ? "INDIVIDUAL_DOCUMENTS" : mergeMode,
      status: JOB_STATUS.QUEUED,
      recordCount: planned.length,
      engine,
      queuedCount: planned.length,
      processingCount: 0,
      completedCount: 0,
      failedCount: 0,
      progressPercent: 0,
      createdBy: input.createdBy,
      startedAt: null,
      metadata: {
        engine,
        autoRoute: shouldAutoRoute,
        dispatchToApplicant: shouldDispatch,
        entityType,
        mergeMode,
        templates: Object.fromEntries(
          templateIds.map((tid) => {
            const t = allTemplates.find((x) => x.id === tid);
            return [
              tid,
              {
                name: t?.name ?? "",
                documentKind: t?.documentKind ?? "GENERIC",
                googleDocId: t?.googleDocId ?? "",
                fields: fieldsByTemplate.get(tid) ?? [],
              },
            ];
          }),
        ),
      },
    })
    .returning();

  await db.insert(mergeJobRecords).values(
    planned.map((p) => ({
      mergeJobId: job.id,
      sourceEntity: entityType,
      sourceRecordId: p.recordId,
      sortOrder: p.sortOrder,
      status: ITEM_STATUS.QUEUED,
      attemptCount: 0,
    })),
  );

  // 7. enqueue — Phase 3/4 sẽ trigger Cloud Run worker tại đây (hiện là no-op an toàn).

  return { jobId: job.id, status: JOB_STATUS.QUEUED, total: planned.length, engine };
}
