/**
 * CANONICAL DOCUMENT PIPELINE — single source of document body for every
 * runtime render path (Preview + Cloud Run HTML_PDF worker).
 *
 * Architecture (there is exactly ONE document definition):
 *
 *   merge_template_versions (explicitly PUBLISHED canonical version)
 *          ↓  buildCanonicalSnapshot()
 *   immutable CanonicalDocumentSnapshot
 *   { templateId, templateVersion, htmlBody, printCss, mappings, formatting }
 *          ↓  resolve values
 *   renderCanonicalDocument()
 *          ├── Preview
 *          └── Cloud Run HTML_PDF worker
 *
 * FAIL CLOSED. When no valid PUBLISHED canonical version exists, this module
 * throws CANONICAL_TEMPLATE_NOT_PUBLISHED. It NEVER falls back to:
 *   - Google Docs content
 *   - static TypeScript HTML (registry / generated modules)
 *   - a legacy generated body
 *   - an older/archived version
 *
 * The static catalog (src/document-templates/**) is metadata ONLY — labels,
 * placeholder/validation metadata and format definitions. It contains no
 * document body and can never supply one.
 */

import type { MergeTemplateField } from "../../db/schema";
import type { MergeContext, RecordData } from "./data-resolver.ts";
import type { TemplateContract } from "./template-contract.ts";
import { DEFAULT_PAGE_MARGINS, type PageMargins } from "./html-renderer.ts";
import {
  renderApplicantDocumentFromParts,
  type RenderApplicantDocumentResult,
} from "./html-pipeline.ts";

/** Clamp/normalize a raw margin value (mm) to a safe, sane range. Never negative,
 * never large enough to make the printable area unusable. See PAGE_MARGIN_LIMITS_MM. */
export const PAGE_MARGIN_LIMITS_MM = { min: 0, max: 60 } as const;

export function normalizePageMargins(raw: Partial<PageMargins> | null | undefined): PageMargins {
  const clamp = (value: number | undefined, fallback: number): number => {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    return Math.min(PAGE_MARGIN_LIMITS_MM.max, Math.max(PAGE_MARGIN_LIMITS_MM.min, Math.round(value)));
  };
  return {
    topMm: clamp(raw?.topMm, DEFAULT_PAGE_MARGINS.topMm),
    bottomMm: clamp(raw?.bottomMm, DEFAULT_PAGE_MARGINS.bottomMm),
    leftMm: clamp(raw?.leftMm, DEFAULT_PAGE_MARGINS.leftMm),
    rightMm: clamp(raw?.rightMm, DEFAULT_PAGE_MARGINS.rightMm),
  };
}

/** Machine-readable configuration error codes for the canonical pipeline. */
export const CANONICAL_ERROR = {
  /** No explicitly PUBLISHED canonical version exists for the template. */
  NOT_PUBLISHED: "CANONICAL_TEMPLATE_NOT_PUBLISHED",
  /** A snapshot exists but carries no usable document body. */
  SNAPSHOT_EMPTY: "CANONICAL_SNAPSHOT_EMPTY",
} as const;

export type CanonicalErrorCode = (typeof CANONICAL_ERROR)[keyof typeof CANONICAL_ERROR];

/** Safe Vietnamese operator messages — no candidate data, no secrets. */
export const CANONICAL_ERROR_MESSAGE_VI: Record<CanonicalErrorCode, string> = {
  [CANONICAL_ERROR.NOT_PUBLISHED]:
    "Chưa có phiên bản HTML chuẩn (canonical) được XUẤT BẢN cho mẫu tài liệu này. " +
    "Vào Template Builder → Đồng bộ Google Doc → Xem trước bản nháp → Xuất bản phiên bản, rồi thử lại. " +
    "Hệ thống KHÔNG tự động dùng Google Docs hay mẫu HTML cũ để thay thế.",
  [CANONICAL_ERROR.SNAPSHOT_EMPTY]:
    "Bản chụp (snapshot) của phiên bản tài liệu không có nội dung HTML hợp lệ. " +
    "Hãy Xuất bản lại một phiên bản canonical hợp lệ rồi tạo job mới. " +
    "Hệ thống KHÔNG tự động dùng phiên bản cũ để thay thế.",
};

export const CANONICAL_ACTION_VI =
  "Yêu cầu bắt buộc: phải có một phiên bản canonical được Xuất bản (PUBLISHED) rõ ràng. Không có fallback.";

/**
 * Configuration failure for the canonical pipeline. This is deliberately NOT a
 * transient/retryable error — retrying cannot publish a template.
 */
export class CanonicalTemplateError extends Error {
  readonly code: CanonicalErrorCode;
  readonly operatorMessage: string;
  readonly action: string;
  /** Configuration errors must never be auto-retried by the queue. */
  readonly retryable = false;
  readonly templateId: string | null;

  constructor(code: CanonicalErrorCode, templateId: string | null = null) {
    super(`${code}: ${CANONICAL_ERROR_MESSAGE_VI[code]}`);
    this.name = "CanonicalTemplateError";
    this.code = code;
    this.operatorMessage = CANONICAL_ERROR_MESSAGE_VI[code];
    this.action = CANONICAL_ACTION_VI;
    this.templateId = templateId;
  }
}

export function isCanonicalTemplateError(error: unknown): error is CanonicalTemplateError {
  return error instanceof CanonicalTemplateError;
}

/** Mapping row frozen into the snapshot (mirrors merge_template_fields). */
export interface CanonicalMapping {
  placeholder: string;
  sourceType: string;
  sourceEntity: string | null;
  sourceField: string | null;
  sourcePath: string | null;
  optionValue: string | null;
  formatType: string | null;
  fallbackValue: string | null;
  isRequired: boolean;
}

/** Non-body formatting metadata frozen alongside the document body. */
export interface CanonicalFormatting {
  /** Registered first-party contract key — metadata only, never a body source. */
  contractKey: string | null;
  retentionYears: number | null;
  documentKind: string;
  templateName: string;
}

/**
 * Immutable job snapshot. Preview and worker render from exactly this object,
 * so neither side can reconstruct the document independently.
 */
export interface CanonicalDocumentSnapshot {
  templateId: string;
  templateVersion: number;
  htmlBody: string;
  printCss: string | null;
  mappings: CanonicalMapping[];
  formatting: CanonicalFormatting;
  /** A4 page margins (mm) frozen at snapshot time — see html-renderer.ts's pageGeometryCss(). */
  margins: PageMargins;
}

/** A merge_template_versions row, as far as this module needs it. */
export interface PublishedVersionRow {
  templateId?: string | null;
  version?: number | null;
  status?: string | null;
  htmlBody?: string | null;
  printCss?: string | null;
  retentionYears?: number | null;
  marginTopMm?: number | null;
  marginBottomMm?: number | null;
  marginLeftMm?: number | null;
  marginRightMm?: number | null;
}

function hasBody(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Assert a version row is an explicitly PUBLISHED canonical version with a
 * usable body. Anything else fails closed.
 */
export function assertPublishedCanonicalVersion(
  version: PublishedVersionRow | null | undefined,
  templateId: string,
): asserts version is PublishedVersionRow {
  if (!version || version.status !== "PUBLISHED" || !hasBody(version.htmlBody)) {
    throw new CanonicalTemplateError(CANONICAL_ERROR.NOT_PUBLISHED, templateId);
  }
}

export interface BuildSnapshotInput {
  templateId: string;
  version: PublishedVersionRow | null | undefined;
  mappings: readonly CanonicalMapping[];
  formatting: CanonicalFormatting;
  /**
   * READ-ONLY DRAFT VERIFICATION ONLY (admin preview before Publish).
   *
   * When true, a DRAFT/ARCHIVED version may be rendered so an operator can
   * verify a candidate version. This NEVER applies to job creation or to the
   * worker: production rendering always requires status === "PUBLISHED".
   */
  allowUnpublishedForVerification?: boolean;
}

/**
 * Build the immutable snapshot from the explicitly PUBLISHED canonical
 * version. Fails closed — no implicit source substitution of any kind.
 */
export function buildCanonicalSnapshot(input: BuildSnapshotInput): CanonicalDocumentSnapshot {
  if (input.allowUnpublishedForVerification) {
    // Verification preview still requires a real body — it merely relaxes the
    // PUBLISHED status gate so a draft can be reviewed before publishing.
    if (!input.version || !hasBody(input.version.htmlBody)) {
      throw new CanonicalTemplateError(CANONICAL_ERROR.NOT_PUBLISHED, input.templateId);
    }
  } else {
    assertPublishedCanonicalVersion(input.version, input.templateId);
  }
  const version = input.version as PublishedVersionRow;
  const versionNumber = typeof version.version === "number" ? version.version : Number.NaN;
  if (!Number.isInteger(versionNumber) || versionNumber <= 0) {
    throw new CanonicalTemplateError(CANONICAL_ERROR.NOT_PUBLISHED, input.templateId);
  }

  return {
    templateId: input.templateId,
    templateVersion: versionNumber,
    htmlBody: version.htmlBody as string,
    printCss: version.printCss ?? null,
    mappings: input.mappings.map((mapping) => ({ ...mapping })),
    formatting: { ...input.formatting, retentionYears: version.retentionYears ?? input.formatting.retentionYears ?? null },
    margins: normalizePageMargins({
      topMm: version.marginTopMm ?? undefined,
      bottomMm: version.marginBottomMm ?? undefined,
      leftMm: version.marginLeftMm ?? undefined,
      rightMm: version.marginRightMm ?? undefined,
    }),
  };
}

/**
 * Re-hydrate a snapshot that was persisted on a job (merge_jobs.metadata).
 * A job whose stored snapshot lost its body fails closed rather than
 * re-reading the database or any static template.
 */
export interface RawCanonicalSnapshot {
  templateId?: string | null;
  templateVersion?: number | null;
  htmlBody?: string | null;
  printCss?: string | null;
  mappings?: CanonicalMapping[] | null;
  formatting?: Partial<CanonicalFormatting> | null;
  margins?: Partial<PageMargins> | null;
}

export function parseCanonicalSnapshot(
  raw: RawCanonicalSnapshot | null | undefined,
  templateId: string,
): CanonicalDocumentSnapshot {
  if (!raw || !hasBody(raw.htmlBody) || typeof raw.templateVersion !== "number") {
    throw new CanonicalTemplateError(CANONICAL_ERROR.SNAPSHOT_EMPTY, templateId);
  }
  return {
    templateId: raw.templateId ?? templateId,
    templateVersion: raw.templateVersion,
    htmlBody: raw.htmlBody,
    printCss: raw.printCss ?? null,
    mappings: Array.isArray(raw.mappings) ? raw.mappings.map((m) => ({ ...m })) : [],
    formatting: {
      contractKey: raw.formatting?.contractKey ?? null,
      retentionYears: raw.formatting?.retentionYears ?? null,
      documentKind: raw.formatting?.documentKind ?? "GENERIC",
      templateName: raw.formatting?.templateName ?? "",
    },
    // A job created before this feature has no frozen `margins` in its stored
    // metadata — normalizePageMargins() falls back to DEFAULT_PAGE_MARGINS,
    // never throwing, so an existing/in-flight job keeps rendering.
    margins: normalizePageMargins(raw.margins ?? undefined),
  };
}

/** Snapshot mappings → the shape the shared resolver expects. */
export function toRenderFields(mappings: readonly CanonicalMapping[]): MergeTemplateField[] {
  return mappings.map((m) => ({
    id: "",
    templateId: "",
    placeholder: m.placeholder,
    sourceType: m.sourceType,
    sourceEntity: m.sourceEntity,
    sourceField: m.sourceField,
    sourcePath: m.sourcePath,
    optionValue: m.optionValue,
    formatType: m.formatType,
    fallbackValue: m.fallbackValue,
    isRequired: m.isRequired,
    isOrphaned: false,
    isSuggested: false,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  })) as MergeTemplateField[];
}

export interface CanonicalRenderResult extends RenderApplicantDocumentResult {
  templateId: string;
  templateVersion: number;
  printCss: string | null;
  margins: PageMargins;
}

export interface CanonicalRenderOptions {
  /** Metadata-only contract used for validation messaging; never a body source. */
  contract?: TemplateContract | null;
}

/**
 * THE canonical render function.
 *
 * Preview and the Cloud Run HTML_PDF worker both call exactly this function
 * with the same snapshot, so for identical inputs the produced HTML/CSS are
 * byte-identical. There is no second document-assembly path.
 */
export function renderCanonicalDocument(
  snapshot: CanonicalDocumentSnapshot,
  recordData: RecordData,
  context: MergeContext,
  options: CanonicalRenderOptions = {},
): CanonicalRenderResult {
  if (!hasBody(snapshot.htmlBody)) {
    throw new CanonicalTemplateError(CANONICAL_ERROR.SNAPSHOT_EMPTY, snapshot.templateId);
  }
  const rendered = renderApplicantDocumentFromParts(
    snapshot.htmlBody,
    snapshot.printCss,
    toRenderFields(snapshot.mappings),
    recordData,
    context,
    { contract: options.contract ?? null },
    snapshot.margins,
  );
  return {
    ...rendered,
    templateId: snapshot.templateId,
    templateVersion: snapshot.templateVersion,
    printCss: snapshot.printCss,
    margins: snapshot.margins,
  };
}

/**
 * Count logical page sections in a rendered document. The page marker is
 * DERIVED from the selected canonical body — it is never asserted against a
 * hard-coded expectation anywhere in business logic. The historical canonical
 * body used `.page`; the operator-provided test(2).html body (v7) uses the
 * authoring shell's `.paper` marker. Both are recognised so that if a
 * published canonical template later has 3, 5, 7 or N pages with either
 * marker, the renderer simply follows it.
 */
export function countCanonicalPages(html: string): number {
  const classRe = /<[a-z][\w:-]*\b[^>]*\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let count = 0;
  let match: RegExpExecArray | null;
  while ((match = classRe.exec(html)) !== null) {
    const classes = (match[1] ?? match[2] ?? "").split(/\s+/);
    if (classes.includes("page") || classes.includes("paper")) count += 1;
  }
  return count;
}
