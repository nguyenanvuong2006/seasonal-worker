/**
 * Dual-template routing for recruitment documents.
 *
 * Tài liệu A — Cam kết / Tái ký          → DW Cũ (MATCHED / declaredType OLD)
 * Tài liệu B — Hợp đồng đào tạo nghề     → DW Mới (NEW)
 * GENERIC                                 → fallback chung khi được cấu hình chủ đích
 *
 * IMPORTANT:
 * Không fallback sang một template A/B khác loại chỉ vì template đó đang active.
 * Nếu thiếu đúng kind (và không có GENERIC), caller phải coi là chưa cấu hình mẫu.
 */

export type DocumentKind = "A" | "B" | "GENERIC";
export type DwClassification = "OLD" | "NEW";

export const DOCUMENT_KIND_META: Record<
  DocumentKind,
  { label: string; subtitle: string; audience: "OLD" | "NEW" | "ALL" }
> = {
  A: { label: "Tài liệu A", subtitle: "Cam kết / Tái ký", audience: "OLD" },
  B: { label: "Tài liệu B", subtitle: "Hợp đồng đào tạo nghề", audience: "NEW" },
  GENERIC: { label: "Mẫu chung", subtitle: "Áp dụng mọi đối tượng", audience: "ALL" },
};

export type ApplicantClassificationInput = {
  declaredType?: string | null;
  dwMatch?: string | null;
};

export function isReturningWorker(input: ApplicantClassificationInput): boolean {
  const match = String(input.dwMatch ?? "").trim().toUpperCase();
  if (match === "MATCHED") return true;
  const declared = String(input.declaredType ?? "").trim().toUpperCase();
  return declared === "OLD" || declared === "RETURNING";
}

export function resolveDwClassification(input: ApplicantClassificationInput): DwClassification {
  return isReturningWorker(input) ? "OLD" : "NEW";
}

export function resolveDocumentKind(input: ApplicantClassificationInput): Exclude<DocumentKind, "GENERIC"> {
  return resolveDwClassification(input) === "OLD" ? "A" : "B";
}

export type RoutableTemplate = {
  id?: string;
  documentKind?: string | null;
  isActive?: boolean | null;
};

export function selectTemplateForKind<T extends RoutableTemplate>(
  templates: T[],
  kind: Exclude<DocumentKind, "GENERIC">,
): T | null {
  const active = templates.filter((template) => template.isActive !== false);

  // Ưu tiên template đúng loại. GENERIC chỉ là fallback có chủ đích.
  // Tuyệt đối không lấy active[0], vì điều đó có thể dùng Tài liệu B cho DW Cũ
  // (hoặc Tài liệu A cho DW Mới) và khiến Preview/Merge khác với cảnh báo trên UI.
  return (
    active.find((template) => template.documentKind === kind) ??
    active.find((template) => template.documentKind === "GENERIC" || !template.documentKind) ??
    null
  );
}

export function selectTemplateForApplicant<T extends RoutableTemplate>(
  templates: T[],
  input: ApplicantClassificationInput,
): { kind: Exclude<DocumentKind, "GENERIC">; template: T | null } {
  const kind = resolveDocumentKind(input);
  return { kind, template: selectTemplateForKind(templates, kind) };
}

/** Lấy Google Doc ID từ URL đầy đủ hoặc chuỗi ID thuần. */
export function extractGoogleDocId(input: string): string | null {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) return null;

  const fromUrl = trimmed.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (fromUrl?.[1]) return fromUrl[1];

  const fromOpen = trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (fromOpen?.[1]) return fromOpen[1];

  if (/^[a-zA-Z0-9_-]{20,}$/.test(trimmed)) return trimmed;
  return null;
}

export function googleDocEditUrl(docId: string): string {
  return `https://docs.google.com/document/d/${docId}/edit`;
}

export function googleDocPreviewUrl(docId: string): string {
  return `https://docs.google.com/document/d/${docId}/preview`;
}

export function googleDocPdfUrl(docId: string): string {
  return `https://docs.google.com/document/d/${docId}/export?format=pdf`;
}

export function documentKindLabel(kind: string | null | undefined): string {
  if (kind === "A") return "Tài liệu A — Cam kết / Tái ký";
  if (kind === "B") return "Tài liệu B — Hợp đồng đào tạo nghề";
  return "Mẫu chung";
}
