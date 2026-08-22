/**
 * PDF Overlay Engine — field-position management (PR2, management layer).
 *
 * CRUD + bulk upsert cho pdf_field_positions. Một placeholder có thể có NHIỀU
 * position (cùng/khác page). Tọa độ = PDF points, gốc bottom-left (xem geometry.ts).
 *
 * Bất biến:
 *   - Chỉ được sửa positions trên version DRAFT. PUBLISHED/ARCHIVED là immutable
 *     (đảm bảo mapping đã publish không bao giờ đổi ngầm sau khi có PDF được sinh).
 *   - Duplicate bị chặn theo khoá tự nhiên (version, placeholder, page, x, y) —
 *     đồng bộ với UNIQUE index trong DB.
 *   - Mọi input đều qua validatePositionInput (geometry/page/type/rules).
 */

import { and, asc, eq, ne } from "drizzle-orm";

import { db } from "@/db";
import {
  pdfFieldPositions,
  pdfTemplateVersions,
  type PdfFieldPosition,
  type PdfTemplateVersion,
} from "@/db/schema";
import {
  findDuplicateKeys,
  positionKeyOf,
  validatePositionInput,
  type PositionValidationInput,
} from "./validation.ts";

export class PdfFieldPositionError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = "PdfFieldPositionError";
  }
}

export type NewPdfFieldPositionInput = PositionValidationInput & {
  fontFamily?: string | null;
  multiline?: boolean;
  renderOrder?: number;
  whiteout?: boolean;
  metadata?: Record<string, unknown>;
};

export type UpdatePdfFieldPositionInput = Partial<NewPdfFieldPositionInput>;

/** Lấy version theo id + verify tồn tại. */
async function loadVersion(versionId: string): Promise<PdfTemplateVersion> {
  const [version] = await db
    .select()
    .from(pdfTemplateVersions)
    .where(eq(pdfTemplateVersions.id, versionId))
    .limit(1);
  if (!version) throw new PdfFieldPositionError("PDF template version not found", 404);
  return version;
}

/** Version phải ở DRAFT thì mới được sửa positions (immutability guarantee). */
async function loadEditableVersion(versionId: string): Promise<PdfTemplateVersion> {
  const version = await loadVersion(versionId);
  if (version.status !== "DRAFT") {
    throw new PdfFieldPositionError(
      `Chỉ được sửa positions trên version DRAFT (hiện tại: ${version.status}).`,
      409,
    );
  }
  return version;
}

type PositionInsertValues = Omit<
  typeof pdfFieldPositions.$inferInsert,
  "id" | "pdfTemplateVersionId" | "createdAt" | "updatedAt"
>;

/** Chuẩn hoá input → values đầy đủ (defaults theo schema). */
function normalizeInput(input: NewPdfFieldPositionInput): PositionInsertValues {
  return {
    placeholder: input.placeholder,
    pageNumber: input.pageNumber,
    x: input.x,
    y: input.y,
    width: input.width,
    height: input.height,
    type: input.type ?? "TEXT",
    fontSize: input.fontSize ?? 10,
    minFontSize: input.minFontSize ?? null,
    fontFamily: input.fontFamily ?? null,
    align: input.align ?? "left",
    valign: input.valign ?? "top",
    multiline: input.multiline ?? false,
    maxLines: input.maxLines ?? null,
    rotation: input.rotation ?? 0,
    renderOrder: input.renderOrder ?? 0,
    isRequired: input.isRequired ?? false,
    whiteout: input.whiteout ?? false,
    checkboxStyle: input.checkboxStyle ?? null,
    optionValue: input.optionValue ?? null,
    sourceKey: input.sourceKey ?? null,
    overflowPolicy: input.overflowPolicy ?? "FAIL",
    staticText: input.staticText ?? null,
    metadata: input.metadata ?? {},
  };
}

/** Validate + throw nếu có lỗi (status 400, liệt kê đủ lỗi). */
function assertValidInput(input: NewPdfFieldPositionInput, version: PdfTemplateVersion): void {
  const errors = validatePositionInput(input, version.pageLayout);
  if (errors.length > 0) {
    throw new PdfFieldPositionError(errors.join(" "), 400);
  }
}

/** Kiểm tra duplicate (khoá tự nhiên), loại trừ id hiện tại (khi update). */
async function assertNoDuplicate(
  versionId: string,
  input: { placeholder: string; pageNumber: number; x: number; y: number },
  excludeId?: string,
): Promise<void> {
  const cond = and(
    eq(pdfFieldPositions.pdfTemplateVersionId, versionId),
    eq(pdfFieldPositions.placeholder, input.placeholder),
    eq(pdfFieldPositions.pageNumber, input.pageNumber),
    eq(pdfFieldPositions.x, input.x),
    eq(pdfFieldPositions.y, input.y),
    ...(excludeId ? [ne(pdfFieldPositions.id, excludeId)] : []),
  );
  const rows = await db.select({ id: pdfFieldPositions.id }).from(pdfFieldPositions).where(cond).limit(1);
  if (rows.length > 0) {
    throw new PdfFieldPositionError(
      `Position trùng: placeholder=${input.placeholder} page=${input.pageNumber} (${input.x},${input.y}).`,
      409,
    );
  }
}

/** Tạo 1 position (version phải DRAFT). */
export async function createPdfFieldPosition(
  versionId: string,
  input: NewPdfFieldPositionInput,
): Promise<PdfFieldPosition> {
  const version = await loadEditableVersion(versionId);
  assertValidInput(input, version);
  await assertNoDuplicate(versionId, input);

  const [row] = await db.insert(pdfFieldPositions).values({
    pdfTemplateVersionId: versionId,
    ...normalizeInput(input),
  }).returning();
  return row;
}

/** Danh sách positions theo (page, renderOrder). */
export async function listPdfFieldPositions(versionId: string): Promise<PdfFieldPosition[]> {
  await loadVersion(versionId);
  return db
    .select()
    .from(pdfFieldPositions)
    .where(eq(pdfFieldPositions.pdfTemplateVersionId, versionId))
    .orderBy(asc(pdfFieldPositions.pageNumber), asc(pdfFieldPositions.renderOrder));
}

/** Lấy 1 position (scope theo version). */
export async function getPdfFieldPosition(
  versionId: string,
  positionId: string,
): Promise<PdfFieldPosition | null> {
  const [row] = await db
    .select()
    .from(pdfFieldPositions)
    .where(
      and(
        eq(pdfFieldPositions.id, positionId),
        eq(pdfFieldPositions.pdfTemplateVersionId, versionId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Cập nhật 1 position (version phải DRAFT, merge input + validate + duplicate check). */
export async function updatePdfFieldPosition(
  versionId: string,
  positionId: string,
  input: UpdatePdfFieldPositionInput,
): Promise<PdfFieldPosition> {
  const version = await loadEditableVersion(versionId);
  const [existing] = await db
    .select()
    .from(pdfFieldPositions)
    .where(
      and(
        eq(pdfFieldPositions.id, positionId),
        eq(pdfFieldPositions.pdfTemplateVersionId, versionId),
      ),
    )
    .limit(1);
  if (!existing) throw new PdfFieldPositionError("Position not found", 404);

  const merged: NewPdfFieldPositionInput = {
    placeholder: existing.placeholder,
    pageNumber: existing.pageNumber,
    x: existing.x,
    y: existing.y,
    width: existing.width,
    height: existing.height,
    type: existing.type as NewPdfFieldPositionInput["type"],
    fontSize: existing.fontSize,
    minFontSize: existing.minFontSize,
    fontFamily: existing.fontFamily,
    align: existing.align as NewPdfFieldPositionInput["align"],
    valign: existing.valign as NewPdfFieldPositionInput["valign"],
    multiline: existing.multiline,
    maxLines: existing.maxLines,
    rotation: existing.rotation,
    renderOrder: existing.renderOrder,
    isRequired: existing.isRequired,
    whiteout: existing.whiteout,
    checkboxStyle: existing.checkboxStyle as NewPdfFieldPositionInput["checkboxStyle"],
    optionValue: existing.optionValue,
    sourceKey: existing.sourceKey,
    overflowPolicy: existing.overflowPolicy as NewPdfFieldPositionInput["overflowPolicy"],
    staticText: existing.staticText,
    metadata: existing.metadata,
    ...input,
  };

  assertValidInput(merged, version);
  await assertNoDuplicate(versionId, merged, positionId);

  const [row] = await db
    .update(pdfFieldPositions)
    .set({ ...normalizeInput(merged), updatedAt: new Date() })
    .where(eq(pdfFieldPositions.id, positionId))
    .returning();
  return row;
}

/** Xoá 1 position (version phải DRAFT). */
export async function deletePdfFieldPosition(
  versionId: string,
  positionId: string,
): Promise<void> {
  await loadEditableVersion(versionId);
  const [existing] = await db
    .select({ id: pdfFieldPositions.id })
    .from(pdfFieldPositions)
    .where(
      and(
        eq(pdfFieldPositions.id, positionId),
        eq(pdfFieldPositions.pdfTemplateVersionId, versionId),
      ),
    )
    .limit(1);
  if (!existing) throw new PdfFieldPositionError("Position not found", 404);

  await db.delete(pdfFieldPositions).where(eq(pdfFieldPositions.id, positionId));
}

/**
 * Bulk upsert (visual mapper lưu cả bản đồ 1 lần) — version phải DRAFT.
 * Validate toàn bộ trước, chặn duplicate trong batch, rồi transaction: với mỗi
 * input upsert theo khoá tự nhiên (có → update, không → insert).
 */
export async function upsertPdfFieldPositions(
  versionId: string,
  inputs: NewPdfFieldPositionInput[],
): Promise<PdfFieldPosition[]> {
  const version = await loadEditableVersion(versionId);

  for (const input of inputs) {
    assertValidInput(input, version);
  }
  const dups = findDuplicateKeys(inputs);
  if (dups.length > 0) {
    throw new PdfFieldPositionError("Batch chứa position trùng khoá (version, placeholder, page, x, y).", 409);
  }

  return db.transaction(async (tx) => {
    const out: PdfFieldPosition[] = [];
    for (const input of inputs) {
      const [existing] = await tx
        .select()
        .from(pdfFieldPositions)
        .where(
          and(
            eq(pdfFieldPositions.pdfTemplateVersionId, versionId),
            eq(pdfFieldPositions.placeholder, input.placeholder),
            eq(pdfFieldPositions.pageNumber, input.pageNumber),
            eq(pdfFieldPositions.x, input.x),
            eq(pdfFieldPositions.y, input.y),
          ),
        )
        .limit(1);
      const values = { pdfTemplateVersionId: versionId, ...normalizeInput(input) };
      if (existing) {
        const [row] = await tx
          .update(pdfFieldPositions)
          .set({ ...normalizeInput(input), updatedAt: new Date() })
          .where(eq(pdfFieldPositions.id, existing.id))
          .returning();
        out.push(row);
      } else {
        const [row] = await tx.insert(pdfFieldPositions).values(values).returning();
        out.push(row);
      }
    }
    return out;
  });
}

/** Re-export khoá tự nhiên (dùng cho test/API log). */
export { positionKeyOf };
