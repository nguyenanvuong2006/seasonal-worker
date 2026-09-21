import "server-only";
import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { dwCodeLocations, dwCodes, organizationUnits } from "@/db/schema";
import { previewDwCode } from "@/lib/dw-code-pool";
import { parseDwCodeFormat } from "@/lib/operational-code-activation";

/**
 * MISSION E section 4-7, 52 — admin config for the Internal DW Code namespace
 * per operational location. Reuses `organization_units` (unit_type = LOCATION)
 * as the location master — no duplicate location table (section 52). Prefix/
 * digits/separator/suffix/startNumber are configurable per location; changing
 * them after codes have been issued NEVER rewrites already-formatted codes
 * (those are stored as literal strings in `dw_codes.code`, never re-derived —
 * see dw-code-pool.ts's docblock).
 */

export type DwCodeLocationRow = {
  id: string;
  organizationUnitId: string;
  organizationUnitName: string | null;
  name: string;
  prefix: string;
  sequenceDigits: number;
  separator: string;
  suffix: string;
  startNumber: number;
  nextSequence: number;
  isActive: boolean;
  preview: string;
  pool: { available: number; assigned: number; retired: number };
};

async function poolCounts(
  locationId: string,
  executor: { select: typeof db.select } = db,
): Promise<{ available: number; assigned: number; retired: number }> {
  const rows = await executor.select({ status: dwCodes.status }).from(dwCodes).where(eq(dwCodes.locationId, locationId));
  const counts = { available: 0, assigned: 0, retired: 0 };
  for (const r of rows) {
    if (r.status === "AVAILABLE") counts.available += 1;
    else if (r.status === "ASSIGNED") counts.assigned += 1;
    else if (r.status === "RETIRED") counts.retired += 1;
  }
  return counts;
}

export async function listDwCodeLocations(): Promise<DwCodeLocationRow[]> {
  const rows = await db
    .select({ loc: dwCodeLocations, orgUnitName: organizationUnits.name })
    .from(dwCodeLocations)
    .leftJoin(organizationUnits, eq(dwCodeLocations.organizationUnitId, organizationUnits.id));

  return Promise.all(
    rows.map(async (r) => ({
      id: r.loc.id,
      organizationUnitId: r.loc.organizationUnitId,
      organizationUnitName: r.orgUnitName,
      name: r.loc.name,
      prefix: r.loc.prefix,
      sequenceDigits: r.loc.sequenceDigits,
      separator: r.loc.separator,
      suffix: r.loc.suffix,
      startNumber: r.loc.startNumber,
      nextSequence: r.loc.nextSequence,
      isActive: r.loc.isActive,
      preview: previewDwCode(r.loc, r.loc.nextSequence),
      pool: await poolCounts(r.loc.id),
    })),
  );
}

export async function getDwCodeLocation(
  id: string,
  executor: { select: typeof db.select } = db,
): Promise<DwCodeLocationRow | null> {
  const [loc] = await executor
    .select()
    .from(dwCodeLocations)
    .where(eq(dwCodeLocations.id, id))
    .limit(1);

  if (!loc) return null;

  const [orgUnit] = await executor
    .select({ name: organizationUnits.name })
    .from(organizationUnits)
    .where(eq(organizationUnits.id, loc.organizationUnitId))
    .limit(1);

  return {
    id: loc.id,
    organizationUnitId: loc.organizationUnitId,
    organizationUnitName: orgUnit?.name ?? null,
    name: loc.name,
    prefix: loc.prefix,
    sequenceDigits: loc.sequenceDigits,
    separator: loc.separator,
    suffix: loc.suffix,
    startNumber: loc.startNumber,
    nextSequence: loc.nextSequence,
    isActive: loc.isActive,
    preview: previewDwCode(loc, loc.nextSequence),
    pool: await poolCounts(loc.id, executor),
  };
}

export type CreateDwCodeLocationInput = {
  organizationUnitId: string;
  name: string;
  prefix: string;
  sequenceDigits: number;
  separator: string;
  suffix: string;
  startNumber: number;
  createdBy: string;
};

const PREFIX_RE = /^[A-Z0-9]{1,8}$/;
const SEPARATOR_RE = /^[A-Z0-9_-]{0,4}$/i;
const SUFFIX_RE = /^[A-Z0-9]{0,8}$/i;

export type ValidationError = { field: string; message: string };

/** No arbitrary script/expression input — prefix/separator/suffix are plain fixed strings only (mission section 5). */
export function validateDwCodeLocationInput(input: {
  name: string;
  prefix: string;
  sequenceDigits: number;
  separator: string;
  suffix: string;
  startNumber: number;
}): ValidationError | null {
  if (!input.name.trim()) return { field: "name", message: "Thiếu tên địa điểm." };
  if (!PREFIX_RE.test(input.prefix)) return { field: "prefix", message: "Prefix chỉ gồm chữ/số in hoa, tối đa 8 ký tự." };
  if (!SEPARATOR_RE.test(input.separator)) return { field: "separator", message: "Separator không hợp lệ (tối đa 4 ký tự)." };
  if (!SUFFIX_RE.test(input.suffix)) return { field: "suffix", message: "Suffix không hợp lệ (tối đa 8 ký tự)." };
  if (!Number.isInteger(input.sequenceDigits) || input.sequenceDigits < 1 || input.sequenceDigits > 10) {
    return { field: "sequenceDigits", message: "Số chữ số phải từ 1 đến 10." };
  }
  if (!Number.isInteger(input.startNumber) || input.startNumber < 0) {
    return { field: "startNumber", message: "Số bắt đầu phải là số nguyên không âm." };
  }
  return null;
}

/**
 * MISSION F section 41 fail-closed guard — the P1 bootstrap-safety check (mission section 3)
 * enforced AT THE MOMENT a location is created, not merely reported by a separate diagnostic.
 * Scans legacy `dw_data.code` (free-text, pre-dates this pool entirely — see dw-code-pool.ts's
 * docblock) for the highest sequence number ever observed under this prefix, using the EXACT
 * same parser the go-live readiness planner uses (operational-code-activation.ts), so the two
 * never disagree about what counts as a match. ILIKE is only a server-side pre-filter for
 * efficiency — the authoritative check is the exact-prefix match after parsing.
 */
async function findLegacyMaxSequenceForPrefix(
  prefix: string,
  executor: { execute: typeof db.execute } = db,
): Promise<number | null> {
  const result = await executor.execute<{ code: string }>(
    sql`SELECT code FROM dw_data WHERE code IS NOT NULL AND deleted_at IS NULL AND code ILIKE ${prefix + "%"}`,
  );
  let max: number | null = null;
  for (const row of result.rows) {
    const parsed = parseDwCodeFormat(row.code);
    if (parsed && parsed.prefix === prefix) max = max === null ? parsed.sequence : Math.max(max, parsed.sequence);
  }
  return max;
}

export async function createDwCodeLocation(input: CreateDwCodeLocationInput) {
  const prefix = input.prefix.toUpperCase();
  const legacyMax = await findLegacyMaxSequenceForPrefix(prefix);
  if (legacyMax !== null && input.startNumber <= legacyMax) {
    throw new Error(
      `SEQUENCE_UNSAFE_STARTNUMBER: Prefix "${prefix}" đã có mã cũ (dw_data.code) với số thứ tự lớn nhất quan sát được là ${legacyMax}. ` +
        `Số bắt đầu (startNumber) phải >= ${legacyMax + 1} để không cấp trùng một mã đang/đã được dùng theo hệ thống cũ.`,
    );
  }

  const [created] = await db
    .insert(dwCodeLocations)
    .values({
      organizationUnitId: input.organizationUnitId,
      name: input.name.trim(),
      prefix,
      sequenceDigits: input.sequenceDigits,
      separator: input.separator,
      suffix: input.suffix.toUpperCase(),
      startNumber: input.startNumber,
      nextSequence: input.startNumber,
      createdBy: input.createdBy,
      updatedBy: input.createdBy,
    })
    .returning();
  return created;
}

export type UpdateDwCodeLocationInput = {
  name?: string;
  prefix?: string;
  sequenceDigits?: number;
  separator?: string;
  suffix?: string;
  startNumber?: number;
  isActive?: boolean;
  updatedBy: string;
};

export type UpdateDwCodeLocationResult =
  | { ok: true; location: DwCodeLocationRow }
  | {
      ok: false;
      error:
        | "LOCATION_NOT_FOUND"
        | "LOCATION_HAS_ISSUED_CODES"
        | "PREFIX_CONFLICT"
        | "SEQUENCE_UNSAFE_STARTNUMBER"
        | "INVALID_INPUT";
      message: string;
      field?: string;
    };

/**
 * EDITABILITY CONTRACT:
 * - SAFE MUTABLE: `name`, `isActive`.
 * - IMMUTABLE AFTER CODE ISSUANCE: If ANY dw_codes row exists for the location (whether
 *   AVAILABLE, ASSIGNED, or RETIRED), `prefix`, `sequenceDigits`, `separator`, `suffix`,
 *   and `startNumber` are strictly locked and rejected.
 * - CONDITIONALLY MUTABLE: If 0 codes exist in the pool, format fields can be modified
 *   safely, with prefix collision checks, legacy sequence floor checks, and startNumber synchronization.
 * Runs inside a transaction with FOR UPDATE row-level locking.
 */
export async function updateDwCodeLocation(
  id: string,
  input: UpdateDwCodeLocationInput,
): Promise<UpdateDwCodeLocationResult> {
  // Pre-validation of individual provided fields
  if (input.name !== undefined && !input.name.trim()) {
    return { ok: false, error: "INVALID_INPUT", field: "name", message: "Thiếu tên địa điểm." };
  }
  if (input.prefix !== undefined && !PREFIX_RE.test(input.prefix.toUpperCase())) {
    return { ok: false, error: "INVALID_INPUT", field: "prefix", message: "Prefix chỉ gồm chữ/số in hoa, tối đa 8 ký tự." };
  }
  if (input.separator !== undefined && !SEPARATOR_RE.test(input.separator)) {
    return { ok: false, error: "INVALID_INPUT", field: "separator", message: "Separator không hợp lệ (tối đa 4 ký tự)." };
  }
  if (input.suffix !== undefined && !SUFFIX_RE.test(input.suffix.toUpperCase())) {
    return { ok: false, error: "INVALID_INPUT", field: "suffix", message: "Suffix không hợp lệ (tối đa 8 ký tự)." };
  }
  if (
    input.sequenceDigits !== undefined &&
    (!Number.isInteger(input.sequenceDigits) || input.sequenceDigits < 1 || input.sequenceDigits > 10)
  ) {
    return { ok: false, error: "INVALID_INPUT", field: "sequenceDigits", message: "Số chữ số phải từ 1 đến 10." };
  }
  if (input.startNumber !== undefined && (!Number.isInteger(input.startNumber) || input.startNumber < 0)) {
    return { ok: false, error: "INVALID_INPUT", field: "startNumber", message: "Số bắt đầu phải là số nguyên không âm." };
  }

  return db.transaction(async (tx) => {
    // 1. Lock current row with FOR UPDATE
    const [current] = await tx
      .select()
      .from(dwCodeLocations)
      .where(eq(dwCodeLocations.id, id))
      .for("update");

    if (!current) {
      return { ok: false, error: "LOCATION_NOT_FOUND", message: "Không tìm thấy cấu hình địa điểm." };
    }

    // 2. Query code pool counts for this location
    const pool = await poolCounts(id, tx as never);
    const totalCodes = pool.available + pool.assigned + pool.retired;

    // 3. Enforce Editability Contract
    if (totalCodes > 0) {
      // Location has already issued codes! Format fields and startNumber are strictly immutable.
      const hasFormatChange =
        (input.prefix !== undefined && input.prefix.toUpperCase() !== current.prefix) ||
        (input.sequenceDigits !== undefined && input.sequenceDigits !== current.sequenceDigits) ||
        (input.separator !== undefined && input.separator !== current.separator) ||
        (input.suffix !== undefined && input.suffix.toUpperCase() !== current.suffix) ||
        (input.startNumber !== undefined && input.startNumber !== current.startNumber);

      if (hasFormatChange) {
        return {
          ok: false,
          error: "LOCATION_HAS_ISSUED_CODES",
          message: `Không thể thay đổi định dạng hoặc số bắt đầu vì địa điểm này đã phát hành mã công nhật trong hệ thống (Available: ${pool.available}, Assigned: ${pool.assigned}, Retired: ${pool.retired}).`,
        };
      }
    } else {
      // Location has 0 codes in the pool. Format fields are conditionally mutable.
      const effectivePrefix = input.prefix !== undefined ? input.prefix.toUpperCase() : current.prefix;
      const effectiveStartNumber = input.startNumber !== undefined ? input.startNumber : current.startNumber;

      // Check prefix conflict if prefix changed
      if (input.prefix !== undefined && input.prefix.toUpperCase() !== current.prefix) {
        const [conflict] = await tx
          .select({ id: dwCodeLocations.id })
          .from(dwCodeLocations)
          .where(and(eq(dwCodeLocations.prefix, effectivePrefix), ne(dwCodeLocations.id, id)))
          .limit(1);

        if (conflict) {
          return {
            ok: false,
            error: "PREFIX_CONFLICT",
            field: "prefix",
            message: `Prefix "${effectivePrefix}" đã được dùng cho địa điểm khác.`,
          };
        }
      }

      // Check legacy sequence floor if prefix or startNumber changed
      if (
        (input.prefix !== undefined && input.prefix.toUpperCase() !== current.prefix) ||
        (input.startNumber !== undefined && input.startNumber !== current.startNumber)
      ) {
        const legacyMax = await findLegacyMaxSequenceForPrefix(effectivePrefix, tx as never);
        if (legacyMax !== null && effectiveStartNumber <= legacyMax) {
          return {
            ok: false,
            error: "SEQUENCE_UNSAFE_STARTNUMBER",
            field: "startNumber",
            message: `Prefix "${effectivePrefix}" đã có mã cũ (dw_data.code) với số thứ tự lớn nhất quan sát được là ${legacyMax}. Số bắt đầu (startNumber) phải >= ${legacyMax + 1} để không cấp trùng mã.`,
          };
        }
      }
    }

    // 4. Build safe update patch
    const patch: Record<string, unknown> = {
      updatedAt: new Date(),
      updatedBy: input.updatedBy,
    };

    if (input.name !== undefined) patch.name = input.name.trim();
    if (input.isActive !== undefined) patch.isActive = input.isActive;

    if (totalCodes === 0) {
      if (input.prefix !== undefined) patch.prefix = input.prefix.toUpperCase();
      if (input.sequenceDigits !== undefined) patch.sequenceDigits = input.sequenceDigits;
      if (input.separator !== undefined) patch.separator = input.separator;
      if (input.suffix !== undefined) patch.suffix = input.suffix.toUpperCase();
      if (input.startNumber !== undefined) {
        patch.startNumber = input.startNumber;
        patch.nextSequence = input.startNumber;
      }
    }

    const [updatedLoc] = await tx
      .update(dwCodeLocations)
      .set(patch)
      .where(eq(dwCodeLocations.id, id))
      .returning();

    const [orgUnit] = await tx
      .select({ name: organizationUnits.name })
      .from(organizationUnits)
      .where(eq(organizationUnits.id, updatedLoc.organizationUnitId))
      .limit(1);

    return {
      ok: true,
      location: {
        id: updatedLoc.id,
        organizationUnitId: updatedLoc.organizationUnitId,
        organizationUnitName: orgUnit?.name ?? null,
        name: updatedLoc.name,
        prefix: updatedLoc.prefix,
        sequenceDigits: updatedLoc.sequenceDigits,
        separator: updatedLoc.separator,
        suffix: updatedLoc.suffix,
        startNumber: updatedLoc.startNumber,
        nextSequence: updatedLoc.nextSequence,
        isActive: updatedLoc.isActive,
        preview: previewDwCode(updatedLoc, updatedLoc.nextSequence),
        pool,
      },
    };
  });
}
