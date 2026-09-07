/**
 * Shared template-version preview resolution — the ONE place that turns
 * (templateId, versionId, applicationId, signingContext, caller session)
 * into a `renderCanonicalDocument()` result.
 *
 * Both the DOM/CSS "Quick Preview" route (preview/route.ts) and the
 * authoritative "A4 PDF Preview" route (preview-pdf/route.ts) call this
 * SAME function, so the two views can never resolve the snapshot, mapping,
 * candidate record, or render options differently — the only difference
 * between the two routes is what they do with `rendered.html` afterward
 * (return it as JSON vs. hand it to the worker's real Chromium page.pdf()).
 *
 * server-only — reads the database directly, never exposed to the client.
 */
import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { dailyApplications, mergeTemplateFields, mergeTemplates, mergeTemplateVersions } from "@/db/schema";
import {
  buildCanonicalSnapshot,
  CANONICAL_ACTION_VI,
  isCanonicalTemplateError,
  renderCanonicalDocument,
  type CanonicalRenderResult,
} from "./canonical-document";
import { loadDailyApplicationRecords } from "./record-loader";
import { getHtmlTemplateContractByGoogleDocId } from "@/document-templates/registry";
import type { MergeContext } from "./data-resolver";
import { isCandidateInScope, selectPreviewMappings, isUnpublishedPreview, summarizePreviewMappings } from "./draft-preview";
import type { Session } from "@/lib/auth";

export interface ResolvePreviewInput {
  templateId: string;
  versionId: string;
  applicationId: string;
  signingContext: MergeContext["signingContext"];
  session: Session;
  scope: readonly string[] | null;
}

export interface ResolvedPreview {
  template: typeof mergeTemplates.$inferSelect;
  version: typeof mergeTemplateVersions.$inferSelect;
  rendered: CanonicalRenderResult;
  mappingSource: string;
  mappingSnapshotCount: number;
  mappingSummary: { total: number; mapped: number; required: number };
  unpublished: boolean;
  fullName: string | undefined;
  cccd: string | undefined;
}

/** Typed failure — routes map this to their own JSON error shape/status. */
export class PreviewResolutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly action?: string,
    readonly templateId?: string | null,
  ) {
    super(message);
    this.name = "PreviewResolutionError";
  }
}

export async function resolveTemplateVersionPreview(input: ResolvePreviewInput): Promise<ResolvedPreview> {
  const { templateId, versionId, applicationId, signingContext, session, scope } = input;

  const [template] = await db.select().from(mergeTemplates).where(eq(mergeTemplates.id, templateId)).limit(1);
  if (!template) {
    throw new PreviewResolutionError("TEMPLATE_NOT_FOUND", "Không tìm thấy mẫu tài liệu.", 404, "Tải lại danh sách mẫu và thử lại.");
  }

  // Load the EXACT version requested — by id AND template id. Never by
  // merge_templates.current_published_version.
  const [version] = await db
    .select()
    .from(mergeTemplateVersions)
    .where(and(eq(mergeTemplateVersions.id, versionId), eq(mergeTemplateVersions.templateId, templateId)))
    .limit(1);
  if (!version) {
    throw new PreviewResolutionError(
      "VERSION_NOT_FOUND",
      "Không tìm thấy phiên bản này trong mẫu tài liệu đã chọn.",
      404,
      "Tải lại danh sách phiên bản của mẫu và chọn lại.",
    );
  }

  const [candidate] = await db
    .select({ id: dailyApplications.id, deptId: dailyApplications.deptId })
    .from(dailyApplications)
    .where(and(eq(dailyApplications.id, applicationId), isNull(dailyApplications.deletedAt)))
    .limit(1);
  if (!candidate || !isCandidateInScope(scope, candidate.deptId)) {
    throw new PreviewResolutionError(
      "APPLICATION_NOT_FOUND",
      "Không tìm thấy ứng viên trong phạm vi dữ liệu của bạn.",
      404,
      "Tìm lại ứng viên bằng ô tìm kiếm trong hộp thoại xem trước.",
    );
  }

  const fields = await db
    .select()
    .from(mergeTemplateFields)
    .where(and(eq(mergeTemplateFields.templateId, templateId), eq(mergeTemplateFields.isOrphaned, false)));

  const { mappings, source: mappingSource } = selectPreviewMappings(version, fields);
  if (mappings.length === 0) {
    throw new PreviewResolutionError(
      "MAPPING_MISSING",
      `Mẫu "${template.name}" chưa có placeholder mapping đang hoạt động.`,
      422,
      "Mở Mapping Inspector, kiểm tra mapping rồi tạo lại bản xem trước.",
      templateId,
    );
  }

  // Same loader the HTML_PDF worker uses — preview data cannot drift.
  const records = await loadDailyApplicationRecords([applicationId]);
  const recordData = records.get(applicationId);
  if (!recordData) {
    throw new PreviewResolutionError("APPLICATION_NOT_FOUND", "Không tìm thấy hồ sơ ứng viên.", 404, "Tìm lại ứng viên rồi thử lại.");
  }

  const previewContext: MergeContext = {
    currentUserId: session.id,
    currentUserName: session.fullName,
    currentDate: new Date(),
    mergeIndex: 1,
    mergeCount: 1,
    signingContext,
  };

  // Build the SAME immutable snapshot shape a job freezes and render it with
  // the SAME canonical renderer the worker uses — preview never reconstructs
  // the document. `allowUnpublishedForVerification` relaxes ONLY the
  // PUBLISHED status gate, and only on this read-only path.
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

  return {
    template,
    version,
    rendered,
    mappingSource,
    mappingSnapshotCount: Array.isArray(version.mappingSnapshot) ? version.mappingSnapshot.length : 0,
    mappingSummary: summarizePreviewMappings(mappings),
    unpublished: isUnpublishedPreview(version),
    fullName: typeof recordData.fullName === "string" ? recordData.fullName : undefined,
    cccd: typeof recordData.cccd === "string" ? recordData.cccd : undefined,
  };
}

export { isCanonicalTemplateError, CANONICAL_ACTION_VI };
