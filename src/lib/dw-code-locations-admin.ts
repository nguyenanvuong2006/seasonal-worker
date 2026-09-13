import "server-only";
import { eq, sql } from "drizzle-orm";
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

async function poolCounts(locationId: string): Promise<{ available: number; assigned: number; retired: number }> {
  const rows = await db.select({ status: dwCodes.status }).from(dwCodes).where(eq(dwCodes.locationId, locationId));
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
async function findLegacyMaxSequenceForPrefix(prefix: string): Promise<number | null> {
  const result = await db.execute<{ code: string }>(sql`SELECT code FROM dw_data WHERE code IS NOT NULL AND deleted_at IS NULL AND code ILIKE ${prefix + "%"}`);
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
  isActive?: boolean;
  updatedBy: string;
};

/** startNumber/nextSequence are DELIBERATELY not editable here (section 51 — no casual sequence-counter editing after codes may already exist). */
export async function updateDwCodeLocation(id: string, input: UpdateDwCodeLocationInput) {
  const patch: Record<string, unknown> = { updatedAt: new Date(), updatedBy: input.updatedBy };
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.prefix !== undefined) patch.prefix = input.prefix.toUpperCase();
  if (input.sequenceDigits !== undefined) patch.sequenceDigits = input.sequenceDigits;
  if (input.separator !== undefined) patch.separator = input.separator;
  if (input.suffix !== undefined) patch.suffix = input.suffix.toUpperCase();
  if (input.isActive !== undefined) patch.isActive = input.isActive;
  const [updated] = await db.update(dwCodeLocations).set(patch).where(eq(dwCodeLocations.id, id)).returning();
  return updated ?? null;
}
