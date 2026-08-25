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
  getRegisteredContractKeyByGoogleDocId,
  getHtmlTemplateContractByGoogleDocId,
} from "../../document-templates/registry.ts";
import {
  buildCanonicalSnapshot,
  CANONICAL_ERROR,
  CANONICAL_ERROR_MESSAGE_VI,
  type CanonicalFormatting,
  type CanonicalMapping,
} from "./canonical-document.ts";
import {
  validateContractRequiredMappings,
  validateTemplateContract,
} from "./template-contract.ts";
import { extractUniquePlaceholders } from "./placeholder-extractor.ts";
import { loadDailyApplicationRecords } from "./record-loader.ts";
import { resolveHtmlFieldValues } from "./html-pipeline.ts";
import { validateRequiredFields, type MergeContext } from "./data-resolver.ts";
import { parseSigningContext, toJsonSigningContext } from "./signing-context.ts";
import type { MergeTemplateField } from "@/db/schema";

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
  /**
   * H3 — Signing Context (Phase 3/17): resolved ONCE by the caller and
   * frozen into this job's immutable metadata below. Every record in this
   * job — 1 or 130 — reads the SAME frozen context; the worker NEVER calls
   * `new Date()` to derive a signing date per record (see worker/src/index.ts).
   */
  signingContext?: unknown;
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

  // H3 — Signing Context is resolved and validated ONCE here, before any
  // record is planned, then frozen verbatim into job.metadata below (Phase 3).
  const signingContextResult = parseSigningContext(input.signingContext);
  if (!signingContextResult.ok) {
    throw new AsyncJobValidationError(signingContextResult.error, 400);
  }
  const signingContext = signingContextResult.context;
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
      // Selected explicitly so the canonical snapshot can re-assert that this
      // row really is the PUBLISHED version (defence in depth, fail closed).
      status: mergeTemplateVersions.status,
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

  // Fail CLOSED before queuing when there is no explicitly PUBLISHED canonical
  // version. There is no fallback to Google Docs, to static TypeScript HTML,
  // to a generated legacy body, or to an older version — the operator must
  // publish a canonical version explicitly.
  if (engine === "HTML_PDF") {
    for (const templateId of templateIds) {
      const template = allTemplates.find((item) => item.id === templateId);
      const version = versionByTemplate.get(templateId);
      if (!template || !version?.htmlBody?.trim()) {
        throw new AsyncJobValidationError(
          `${CANONICAL_ERROR.NOT_PUBLISHED}: ${CANONICAL_ERROR_MESSAGE_VI[CANONICAL_ERROR.NOT_PUBLISHED]}`,
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

      const contract = getHtmlTemplateContractByGoogleDocId(template.googleDocId);
      if (contract) {
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

    // Required-field gate for HTML_PDF. The ONLY runtime source of truth is
    // merge_template_fields.isRequired (snapshotted above). There is no
    // hard-coded per-template rule: a placeholder blocks the job when — and
    // only when — its mapping is marked required and the record resolves it
    // to an empty value. A mapping left optional queues normally even when the
    // underlying column is blank, and no placeholder silently falls back to a
    // different column (e.g. Dia_chi_thuong_tru never reads residentialAddress).
    //
    // This mirrors exactly what the worker does at render time
    // (renderApplicantDocumentFromParts → validateRequiredFields), so a job
    // that could only fail during rendering is rejected up-front with 422
    // instead of being queued and failing after an item is claimed.
    // GOOGLE_DOCS is untouched — this whole block is HTML_PDF only.
    const requiredByTemplate = new Map<string, FieldSnapshot[]>();
    for (const templateId of templateIds) {
      const required = (fieldsByTemplate.get(templateId) ?? []).filter((field) => field.isRequired);
      if (required.length > 0) requiredByTemplate.set(templateId, required);
    }

    if (requiredByTemplate.size > 0) {
      const recordsNeedingCheck = planned
        .filter((item) => requiredByTemplate.has(item.templateId))
        .map((item) => item.recordId);
      const recordData = await loadDailyApplicationRecords([...new Set(recordsNeedingCheck)]);
      const context: MergeContext = { currentUserId: input.createdBy, currentDate: new Date(), signingContext };

      const missingByPlaceholder = new Map<string, number>();
      for (const item of planned) {
        const required = requiredByTemplate.get(item.templateId);
        if (!required) continue;
        const data = recordData.get(item.recordId);
        if (!data) continue;
        const values = resolveHtmlFieldValues(required as unknown as MergeTemplateField[], data, context);
        const { missingFields } = validateRequiredFields(required as unknown as MergeTemplateField[], values);
        for (const placeholder of missingFields) {
          missingByPlaceholder.set(placeholder, (missingByPlaceholder.get(placeholder) ?? 0) + 1);
        }
      }

      if (missingByPlaceholder.size > 0) {
        const detail = [...missingByPlaceholder.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([placeholder, count]) => `${placeholder} (${count} hồ sơ)`)
          .join(", ");
        throw new AsyncJobValidationError(
          `Thiếu dữ liệu cho trường bắt buộc theo mapping: ${detail}.`,
          422,
        );
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
        // H3 — the SAME frozen Signing Context every record in this job reads
        // for COMPUTED placeholders (Ngay_ky_day/month/year, Dia_diem_ky, ...).
        // Never re-derived per record; the worker only ever consumes this.
        signingContext: toJsonSigningContext(signingContext),
        // IMMUTABLE CANONICAL SNAPSHOT — the single document definition this
        // job will ever render. Both Preview and the Cloud Run HTML_PDF worker
        // read exactly this object via renderCanonicalDocument(); neither may
        // reconstruct the document from Google Docs, static TypeScript HTML or
        // a later/earlier template version.
        templates: Object.fromEntries(
          templateIds.map((tid) => {
            const t = allTemplates.find((x) => x.id === tid);
            const version = versionByTemplate.get(tid);
            const formatting: CanonicalFormatting = {
              // Registered first-party contract key — validation metadata only,
              // never a document-body source.
              contractKey: getRegisteredContractKeyByGoogleDocId(t?.googleDocId) ?? null,
              retentionYears: version?.retentionYears ?? null,
              documentKind: t?.documentKind ?? "GENERIC",
              templateName: t?.name ?? "",
            };
            const mappings = (fieldsByTemplate.get(tid) ?? []) as CanonicalMapping[];

            // GOOGLE_DOCS keeps its legacy metadata shape untouched (it has its
            // own synchronous render path and never uses the canonical body).
            // HTML_PDF is ALWAYS a fail-closed canonical snapshot.
            if (engine !== "HTML_PDF") {
              return [
                tid,
                {
                  name: formatting.templateName,
                  documentKind: formatting.documentKind,
                  googleDocId: t?.googleDocId ?? "",
                  contractKey: formatting.contractKey,
                  version: version?.version ?? t?.currentPublishedVersion ?? null,
                  retentionYears: formatting.retentionYears,
                  fields: mappings,
                  htmlBody: version?.htmlBody ?? null,
                  printCss: version?.printCss ?? null,
                },
              ];
            }

            const snapshot = buildCanonicalSnapshot({
              templateId: tid,
              version,
              mappings,
              formatting,
            });
            return [
              tid,
              {
                // Canonical snapshot fields (read by renderCanonicalDocument).
                templateId: snapshot.templateId,
                templateVersion: snapshot.templateVersion,
                htmlBody: snapshot.htmlBody,
                printCss: snapshot.printCss,
                mappings: snapshot.mappings,
                formatting: snapshot.formatting,
                // Denormalised copies kept for existing history/filename code.
                name: formatting.templateName,
                documentKind: formatting.documentKind,
                googleDocId: t?.googleDocId ?? "",
                contractKey: formatting.contractKey,
                version: snapshot.templateVersion,
                retentionYears: formatting.retentionYears,
                fields: snapshot.mappings,
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
