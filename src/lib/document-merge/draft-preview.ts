/**
 * DRAFT VERSION PREVIEW — pure decision logic (no db, no next, no io).
 *
 * PURPOSE
 * -------
 * An operator must be able to LOOK at a candidate template version (typically a
 * DRAFT such as v8) rendered with a real candidate BEFORE publishing it. The
 * previous workflow forced a choice between "publish and hope" and "no visual
 * verification at all". This module holds the rules that make the preview safe:
 *
 *   • it never publishes, never writes, never creates a merge job;
 *   • it renders EXACTLY the version the operator asked for (by id), never the
 *     template's current_published_version;
 *   • it decides WHICH mapping set may be used, preserving published-version
 *     immutability (see `selectPreviewMappings`).
 *
 * VERSION SEMANTICS (the important part)
 * --------------------------------------
 * A PUBLISHED version owns an immutable `mapping_snapshot` frozen at publish
 * time; production jobs and the Cloud Run worker must keep rendering from that
 * frozen snapshot — changing merge_template_fields afterwards may never alter
 * an already published document. That rule is NOT weakened here.
 *
 * A DRAFT version has `mapping_snapshot = []` by design (the snapshot is only
 * created by `publishTemplateVersion`). Therefore a DRAFT preview must resolve
 * mappings from the CURRENT non-orphaned `merge_template_fields`, which is
 * exactly the set that pre-publish validation
 * (`validatePlaceholderCoverage`) inspects. So the preview shows precisely what
 * publishing this draft would freeze — no more, no less.
 *
 * This module is intentionally dependency-free so it can be unit tested without
 * a database and reused by any caller.
 */

import type { CanonicalMapping } from "./canonical-document.ts";

/** Response `mode` discriminator for the draft/version preview branch. */
export const DRAFT_PREVIEW_MODE = "DRAFT_VERSION_PREVIEW" as const;

/** Banner the UI must show for any version that is not PUBLISHED. */
export const DRAFT_PREVIEW_BANNER_VI = "BẢN XEM TRƯỚC — CHƯA XUẤT BẢN";

/**
 * Where the preview's placeholder mappings came from.
 *
 * - PUBLISHED_MAPPING_SNAPSHOT: the immutable snapshot frozen at publish time
 *   (identical to what a production job/worker would use).
 * - CURRENT_MERGE_TEMPLATE_FIELDS: the live non-orphaned merge_template_fields,
 *   used ONLY when the version carries no snapshot yet (DRAFT).
 */
export const DRAFT_PREVIEW_MAPPING_SOURCE = {
  SNAPSHOT: "PUBLISHED_MAPPING_SNAPSHOT",
  CURRENT_FIELDS: "CURRENT_MERGE_TEMPLATE_FIELDS",
} as const;

export type DraftPreviewMappingSource =
  (typeof DRAFT_PREVIEW_MAPPING_SOURCE)[keyof typeof DRAFT_PREVIEW_MAPPING_SOURCE];

/** A merge_template_fields row, as far as preview needs it. */
export interface PreviewFieldRow {
  placeholder: string;
  sourceType: string;
  sourceEntity: string | null;
  sourceField: string | null;
  sourcePath: string | null;
  optionValue: string | null;
  formatType: string | null;
  fallbackValue: string | null;
  isRequired: boolean;
  isOrphaned?: boolean | null;
}

/** A merge_template_versions row, as far as preview needs it. */
export interface PreviewVersionRow {
  id?: string;
  version?: number | null;
  status?: string | null;
  htmlBody?: string | null;
  printCss?: string | null;
  mappingSnapshot?: unknown;
}

/** Normalise DB rows into canonical mappings, dropping orphaned placeholders. */
export function toPreviewMappings(fields: readonly PreviewFieldRow[]): CanonicalMapping[] {
  return fields
    .filter((field) => field.isOrphaned !== true)
    .map((field) => ({
      placeholder: field.placeholder,
      sourceType: field.sourceType,
      sourceEntity: field.sourceEntity ?? null,
      sourceField: field.sourceField ?? null,
      sourcePath: field.sourcePath ?? null,
      optionValue: field.optionValue ?? null,
      formatType: field.formatType ?? null,
      fallbackValue: field.fallbackValue ?? null,
      isRequired: field.isRequired === true,
    }));
}

function snapshotRows(value: unknown): PreviewFieldRow[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (row): row is PreviewFieldRow =>
      typeof row === "object" && row !== null && typeof (row as PreviewFieldRow).placeholder === "string",
  );
}

/**
 * Choose the mapping set for a preview render.
 *
 * IMMUTABILITY RULE: if the version already carries a non-empty
 * `mapping_snapshot` (i.e. it has been published at least once), that frozen
 * snapshot wins — preview then shows byte-for-byte what production renders,
 * and live mapping edits cannot retro-actively change it.
 *
 * DRAFT RULE: an empty snapshot means "not published yet". Only then may the
 * preview fall back to the current non-orphaned merge_template_fields, which is
 * the same set pre-publish coverage validation uses.
 */
export function selectPreviewMappings(
  version: PreviewVersionRow,
  currentFields: readonly PreviewFieldRow[],
): { mappings: CanonicalMapping[]; source: DraftPreviewMappingSource } {
  const frozen = snapshotRows(version.mappingSnapshot);
  if (frozen.length > 0) {
    return {
      mappings: toPreviewMappings(frozen),
      source: DRAFT_PREVIEW_MAPPING_SOURCE.SNAPSHOT,
    };
  }
  return {
    mappings: toPreviewMappings(currentFields),
    source: DRAFT_PREVIEW_MAPPING_SOURCE.CURRENT_FIELDS,
  };
}

/** True when the version is not the published canonical one (banner required). */
export function isUnpublishedPreview(version: PreviewVersionRow): boolean {
  return version.status !== "PUBLISHED";
}

/**
 * DATA SCOPE — a preview may only read a candidate the caller is allowed to
 * read. `scope === null` means unrestricted (see `getUserScope`); an empty list
 * means "nothing" (safety net), and a scoped caller can never reach a candidate
 * that has no department at all.
 */
export function isCandidateInScope(scope: readonly string[] | null, deptId: string | null | undefined): boolean {
  if (scope === null) return true;
  if (scope.length === 0) return false;
  if (!deptId) return false;
  return scope.includes(deptId);
}

/** Operator-facing counters shown next to the preview. */
export function summarizePreviewMappings(mappings: readonly CanonicalMapping[]): {
  total: number;
  mapped: number;
  required: number;
} {
  return {
    total: mappings.length,
    mapped: mappings.filter((m) => Boolean(m.sourceField || m.sourcePath || m.fallbackValue)).length,
    required: mappings.filter((m) => m.isRequired).length,
  };
}

/** Validated, server-trusted preview request. */
export interface DraftPreviewRequest {
  applicationId: string;
}

export interface DraftPreviewRequestError {
  code: "APPLICATION_REQUIRED";
  error: string;
  action: string;
}

/**
 * Validate the ONLY client-controlled input of the preview call.
 *
 * templateId / versionId are NOT taken from the body: they come from the route
 * path and are re-checked against the database (version must belong to the
 * template), so a client cannot point the preview at another template's
 * version.
 */
export function parseDraftPreviewRequest(
  body: unknown,
): { ok: true; value: DraftPreviewRequest } | { ok: false; error: DraftPreviewRequestError } {
  const raw = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const applicationId = typeof raw.applicationId === "string" ? raw.applicationId.trim() : "";
  if (!applicationId) {
    return {
      ok: false,
      error: {
        code: "APPLICATION_REQUIRED",
        error: "Thiếu ứng viên để tạo bản xem trước.",
        action: "Tìm và chọn một ứng viên có thật rồi bấm “Tạo bản xem trước”.",
      },
    };
  }
  return { ok: true, value: { applicationId } };
}
