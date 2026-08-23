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
import { dailyApplications, mergeJobRecords, mergeJobs, mergeTemplateFields, mergeTemplates, mergeTemplateVersions } from "@/db/schema";
import { getDocumentMergeEngine, type DocumentMergeEngine } from "./engine-config.ts";
import { selectTemplateForApplicant, documentKindLabel } from "./template-routing.ts";
import { ITEM_STATUS, JOB_STATUS } from "./queue-types.ts";
import {
  getHtmlTemplateByGoogleDocId,
  getHtmlTemplateContractByGoogleDocId,
} from "../../document-templates/registry.ts";
import {
  validateContractRequiredMappings,
  validateTemplateContract,
} from "./template-contract.ts";
import { extractUniquePlaceholders } from "./placeholder-extractor.ts";

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

  // HTML/PDF is deliberately explicit: callers must select one concrete
  // template. Auto-routing remains available to the legacy Google Docs flow,
  // but may not silently choose an HTML template/version for a legal PDF.
  if (engine === "HTML_PDF" && (shouldAutoRoute || !input.templateId)) {
    throw new AsyncJobValidationError(
      "HTML/PDF yêu cầu chọn một template cụ thể (templateId) và tắt Auto Route.",
      400,
    );
  }

  // 2. Validate template
  const allTemplates = await db.select().from(mergeTemplates);
  const activeTemplates = allTemplates.filter((t) => t.isActive);

  let forcedTemplateId: string | null = null;
  if (input.templateId && !shouldAutoRoute) {
    const forced = allTemplates.find((t) => t.id === input.templateId);
    if (!forced) throw new AsyncJobValidationError("Template not found", 404);
    if (!forced.isActive) throw new AsyncJobValidationError("Template is inactive", 400);
    if (engine === "HTML_PDF" && !forced.htmlEnabled) {
      throw new AsyncJobValidationError("Template này chưa được bật chế độ HTML/PDF.", 422);
    }
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

  // Snapshot version + retention + HTML content từ merge_template_versions
  // (PUBLISHED) — spec E/Q: PDF snapshot template_version + retention policy
  // lúc tạo. QUAN TRỌNG: snapshot CẢ htmlBody/printCss (không chỉ version
  // number) — worker (Cloud Run) render trực tiếp từ snapshot này, KHÔNG
  // tra cứu lại merge_template_versions hay bất kỳ registry HTML cứng nào
  // lúc render, để PDF cũ không bao giờ đổi nếu version publish sau này thay đổi.
  const publishedVersions = await db
    .select({
      templateId: mergeTemplateVersions.templateId,
      version: mergeTemplateVersions.version,
      retentionYears: mergeTemplateVersions.retentionYears,
      htmlBody: mergeTemplateVersions.htmlBody,
      printCss: mergeTemplateVersions.printCss,
    })
    .from(mergeTemplateVersions)
    .where(
      and(
        inArray(mergeTemplateVersions.templateId, templateIds),
        eq(mergeTemplateVersions.status, "PUBLISHED"),
      ),
    );
  const versionByTemplate = new Map(publishedVersions.map((v) => [v.templateId, v]));

  // Fail before queuing when the requested HTML mode cannot possibly render.
  // This reuses the existing version/mapping tables rather than allowing the
  // worker to discover a missing version after an item has been claimed.
  if (engine === "HTML_PDF") {
    for (const templateId of templateIds) {
      const template = allTemplates.find((item) => item.id === templateId);
      const version = versionByTemplate.get(templateId);
      if (!template || !version?.htmlBody?.trim()) {
        throw new AsyncJobValidationError(
          "Template chưa có phiên bản HTML PUBLISHED. Hãy Preview và Xuất bản phiên bản trước khi tạo job.",
          422,
        );
      }

      const mappedTokens = new Set((fieldsByTemplate.get(templateId) ?? []).map((field) => field.placeholder));
      const unmappedTokens = extractUniquePlaceholders(version.htmlBody).filter((token) => !mappedTokens.has(token));
      if (unmappedTokens.length > 0) {
        throw new AsyncJobValidationError(
          `HTML template có placeholder chưa mapping: ${unmappedTokens.join(", ")}.`,
          422,
        );
      }

      const registered = getHtmlTemplateByGoogleDocId(template.googleDocId);
      const contract = getHtmlTemplateContractByGoogleDocId(template.googleDocId);
      if (registered && contract) {
        const contractResult = validateTemplateContract(version.htmlBody, contract);
        if (!contractResult.valid) {
          throw new AsyncJobValidationError(
            `HTML template không khớp contract: thiếu ${contractResult.missingFromHtml.join(", ") || "—"}; token lạ ${contractResult.unknownInHtml.join(", ") || "—"}; trùng ${contractResult.duplicateKeys.join(", ") || "—"}.`,
            422,
          );
        }
        const missingMappings = validateContractRequiredMappings(contract, fieldsByTemplate.get(templateId) ?? []);
        if (missingMappings.length > 0) {
          throw new AsyncJobValidationError(
            `Thiếu mapping bắt buộc theo contract: ${missingMappings.join(", ")}.`,
            422,
          );
        }
      }
    }
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
        // Freeze the merge clock as well as HTML/CSS/mappings. A retry cannot
        // change signature/computed dates or pagination after the job exists.
        renderedAt: new Date().toISOString(),
        templates: Object.fromEntries(
          templateIds.map((tid) => {
            const t = allTemplates.find((x) => x.id === tid);
            return [
              tid,
              {
                name: t?.name ?? "",
                documentKind: t?.documentKind ?? "GENERIC",
                googleDocId: t?.googleDocId ?? "",
                // First-party contracts are registered by stable key. Generic
                // customer templates have no code contract and rely on their
                // DB mapping snapshot only.
                contractKey: getHtmlTemplateByGoogleDocId(t?.googleDocId)?.key ?? null,
                // Snapshot template version lúc tạo job — PDF cũ không regenerate
                // bằng template mới (spec E: mỗi PDF snapshot template_version).
                version: versionByTemplate.get(tid)?.version ?? t?.currentPublishedVersion ?? null,
                retentionYears: versionByTemplate.get(tid)?.retentionYears ?? null,
                fields: fieldsByTemplate.get(tid) ?? [],
                // Engine HTML_PDF render TRỰC TIẾP từ đây (xem worker processItem) —
                // null khi template chưa có version PUBLISHED (worker sẽ fail rõ
                // ràng thay vì thử registry cứng không còn đồng bộ với DB).
                htmlBody: versionByTemplate.get(tid)?.htmlBody ?? null,
                printCss: versionByTemplate.get(tid)?.printCss ?? null,
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
      templateId: p.templateId,
      sortOrder: p.sortOrder,
      status: ITEM_STATUS.QUEUED,
      attemptCount: 0,
    })),
  );

  // 7. enqueue — Phase 3/4 sẽ trigger Cloud Run worker tại đây (hiện là no-op an toàn).

  return { jobId: job.id, status: JOB_STATUS.QUEUED, total: planned.length, engine };
}
