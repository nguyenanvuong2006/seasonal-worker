import "server-only";
import { createHash } from "crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, pool } from "@/db";
import { workforceDataImportBatches, workforceDataImportRows, type FieldDefinition } from "@/db/schema";
import { getFieldDefinitions, makeFieldPicker } from "@/lib/metadata";
import { normalizePersonName } from "@/lib/person-name";
import { CCCD_ERROR_MESSAGE, isValidCccd, normalizeCccd } from "@/lib/validators";
import type { DataManagementEnvironment } from "./environment";

/**
 * WORKFORCE DATA MANAGEMENT — repeatable Master DW (dw_data) UPSERT import
 * (mission sections 4/14-18). Deliberately a NEW code path, NOT a change to
 * the existing dw_data import in import-engine.ts (jobType "dw_data" there
 * stays INSERT-ONLY-DEDUP — ON CONFLICT DO NOTHING — because it is fed by
 * ongoing daily recruiting operations where a repeated CCCD is expected/
 * ignorable; that behavior must not change). This one is UPSERT: an
 * existing cccd updates its master fields, a new cccd is created, and a
 * cccd simply absent from the file is left completely alone — never
 * inferred as resigned/deleted (mission section 17's explicit invariant).
 *
 * Reuses the SAME field_definitions("dw_data") catalog/alias matching the
 * old importer already uses (getFieldDefinitions/makeFieldPicker) so a file
 * that works with the old importer's headers works here unchanged — one
 * column-mapping source of truth, not two.
 *
 * cccd (12-digit citizen ID) is this system's real natural key — see
 * scopes.ts's docblock and the earlier AI Organization mission's audit
 * trail; there is no "workerCode" field like the mission's illustrative
 * "DR0001-D" example in this schema. dw_data.cccd already carries a unique
 * partial index (dw_cccd_uq, WHERE deleted_at IS NULL) — worker identity
 * uniqueness was already a solved problem here, not something this mission
 * needed to newly enforce.
 */

const CHUNK_SIZE = 300;
const STAGE_CHUNK_SIZE = 3000;

export function computeFileChecksum(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

type MasterFields = {
  code: string | null;
  itCode: string | null;
  oldDwCode: string | null;
  idVlookup: string | null;
  gender: string | null;
  bod: string | null;
  profile: string | null;
  dktn: string | null;
  dateOfIssue: string | null;
  placeOfIssue: string | null;
  permanentAddress: string | null;
  residentialAddress: string | null;
  phone: string | null;
};

const clean = (v: unknown): string | null => {
  const s = String(v ?? "").trim();
  return s === "" || s === "0" || s === "#N/A" || s === "-" ? null : s;
};
const digits = (v: unknown): string | null => {
  const s = String(v ?? "").replace(/\D/g, "");
  return s.length ? s : null;
};

export type ParsedWorkforceMasterRow = {
  rowNumber: number;
  cccd: string | null;
  fullName: string | null;
  fields: MasterFields;
  valid: boolean;
  invalidReason: string | null;
};

function parseRow(rowNumber: number, raw: Record<string, string>, defs: FieldDefinition[]): ParsedWorkforceMasterRow {
  const pick = makeFieldPicker(raw, defs);
  const fullName = clean(pick("dw_full_name", ["HỌ TÊN", "Full Name"]));
  const cccdRaw = pick("dw_cccd", ["ID No", "CCCD"]);
  const cccd = normalizeCccd(cccdRaw);

  const fields: MasterFields = {
    code: clean(pick("dw_code", ["CODE"])),
    itCode: clean(pick("dw_it_code", ["IT CODE"])),
    oldDwCode: clean(pick("dw_old_code", ["OldDW_VLOOKUP"])),
    idVlookup: clean(pick("dw_id_vlookup", ["ID_VLOOKUP"])),
    gender: clean(pick("dw_gender", ["GENDER"])),
    bod: clean(pick("dw_bod", ["BOD"])),
    profile: clean(pick("dw_profile", ["PROFILE"])),
    dktn: clean(pick("dw_dktn", ["ĐKTN"])),
    dateOfIssue: clean(pick("dw_date_of_issue", ["Date of issue"])),
    placeOfIssue: clean(pick("dw_place_of_issue", ["Place of issue"])),
    permanentAddress: clean(pick("dw_permanent_address", ["Permanent address"])),
    residentialAddress: clean(pick("dw_residential_address", ["Residential address"])),
    phone: digits(pick("dw_phone", ["Phone number"])),
  };

  if (!fullName) return { rowNumber, cccd: cccd || null, fullName: null, fields, valid: false, invalidReason: "Thiếu Họ tên" };
  if (!isValidCccd(cccd)) return { rowNumber, cccd: cccd || null, fullName, fields, valid: false, invalidReason: CCCD_ERROR_MESSAGE };
  return { rowNumber, cccd, fullName: normalizePersonName(fullName), fields, valid: true, invalidReason: null };
}

export type WorkforceMasterDryRunResult = {
  total: number;
  valid: number;
  invalid: number;
  newCount: number;
  existingCount: number;
  duplicatesInFile: number;
  duplicatesInDatabase: number;
  warnings: string[];
  invalidRows: { rowNumber: number; reason: string }[];
};

/** Pure preview — NO database writes (mission section 33). Existing-cccd classification is the one read-only DB lookup it needs. */
export async function dryRunWorkforceMaster(rawRows: Record<string, string>[]): Promise<WorkforceMasterDryRunResult> {
  const defs = await getFieldDefinitions("dw_data");
  const parsed = rawRows.map((r, i) => parseRow(i + 1, r, defs));

  const seenInFile = new Map<string, number>();
  let duplicatesInFile = 0;
  for (const row of parsed) {
    if (!row.valid || !row.cccd) continue;
    const seenCount = (seenInFile.get(row.cccd) ?? 0) + 1;
    seenInFile.set(row.cccd, seenCount);
    if (seenCount > 1) duplicatesInFile++;
  }

  const validCccds = [...new Set(parsed.filter((r) => r.valid && r.cccd).map((r) => r.cccd as string))];
  const existing = validCccds.length
    ? await pool.query<{ cccd: string; dup: string }>(
        `SELECT cccd, count(*)::text AS dup FROM dw_data WHERE cccd = ANY($1::text[]) AND deleted_at IS NULL GROUP BY cccd`,
        [validCccds],
      )
    : { rows: [] as { cccd: string; dup: string }[] };
  const existingSet = new Set(existing.rows.map((r) => r.cccd));
  const duplicatesInDatabase = existing.rows.filter((r) => Number(r.dup) > 1).length;

  const invalidRows = parsed.filter((r) => !r.valid).map((r) => ({ rowNumber: r.rowNumber, reason: r.invalidReason as string }));
  const warnings: string[] = [];
  if (duplicatesInFile > 0) warnings.push(`${duplicatesInFile} dòng trùng CCCD trong file — dòng sau cùng sẽ thắng khi import.`);
  if (rawRows.length > 20000) warnings.push("File lớn hơn 20,000 dòng — import sẽ chạy theo nhiều lô, không timeout nhưng có thể mất vài phút.");

  return {
    total: rawRows.length,
    valid: parsed.filter((r) => r.valid).length,
    invalid: invalidRows.length,
    newCount: parsed.filter((r) => r.valid && r.cccd && !existingSet.has(r.cccd)).length,
    existingCount: parsed.filter((r) => r.valid && r.cccd && existingSet.has(r.cccd)).length,
    duplicatesInFile,
    duplicatesInDatabase,
    warnings,
    invalidRows: invalidRows.slice(0, 500),
  };
}

export type CreateBatchInput = {
  fileName: string;
  checksum: string;
  rows: Record<string, string>[];
  createdBy: string;
  environment: DataManagementEnvironment;
  datasetMode: "TEST" | "OFFICIAL";
};

export type CreateBatchResult = { ok: true; batchId: string } | { ok: false; error: "DUPLICATE_CHECKSUM"; message: string };

/** Idempotency guard (mission section 35): the DB's partial unique index on (import_type, source_checksum) is the real enforcement — this just turns the constraint violation into a clear error instead of a raw 500. */
export async function createWorkforceMasterBatch(input: CreateBatchInput): Promise<CreateBatchResult> {
  try {
    const [batch] = await db
      .insert(workforceDataImportBatches)
      .values({
        importType: "WORKFORCE_MASTER",
        datasetMode: input.datasetMode,
        environment: input.environment,
        sourceFilename: input.fileName,
        sourceChecksum: input.checksum,
        status: "IMPORTING",
        totalRows: input.rows.length,
        createdBy: input.createdBy,
      })
      .returning({ id: workforceDataImportBatches.id });

    for (let i = 0; i < input.rows.length; i += STAGE_CHUNK_SIZE) {
      const chunk = input.rows.slice(i, i + STAGE_CHUNK_SIZE);
      const rowNumbers = chunk.map((_, idx) => i + idx + 1);
      const rawJson = chunk.map((r) => JSON.stringify(r));
      await pool.query(
        `INSERT INTO workforce_data_import_rows (batch_id, row_number, raw_data, status)
         SELECT $1::uuid, x.rn, x.rd, 'PENDING'
         FROM unnest($2::int[], $3::jsonb[]) AS x(rn, rd)`,
        [batch.id, rowNumbers, rawJson],
      );
    }

    return { ok: true, batchId: batch.id };
  } catch (error) {
    const message = (error as Error).message ?? "";
    if (message.includes("workforce_data_import_batch_checksum_uq")) {
      return { ok: false, error: "DUPLICATE_CHECKSUM", message: "File này (theo checksum) đã được import trước đó và chưa bị đánh dấu FAILED/REPLACED — không import trùng." };
    }
    throw error;
  }
}

export type MergeChunkResult = { processed: number; inserted: number; updated: number; invalid: number; done: boolean };

/** One bounded chunk per call (mission section 38) — the caller (route) loops until done=true. Never one giant transaction for the whole file. */
export async function mergeWorkforceMasterChunk(batchId: string): Promise<MergeChunkResult> {
  const defs = await getFieldDefinitions("dw_data");
  const pending = await db
    .select()
    .from(workforceDataImportRows)
    .where(and(eq(workforceDataImportRows.batchId, batchId), eq(workforceDataImportRows.status, "PENDING")))
    .limit(CHUNK_SIZE);

  if (pending.length === 0) {
    await db
      .update(workforceDataImportBatches)
      .set({ status: "COMPLETED", completedAt: new Date() })
      .where(eq(workforceDataImportBatches.id, batchId));
    return { processed: 0, inserted: 0, updated: 0, invalid: 0, done: true };
  }

  let inserted = 0;
  let updated = 0;
  let invalid = 0;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const row of pending) {
      const parsed = parseRow(row.rowNumber, row.rawData, defs);
      if (!parsed.valid || !parsed.cccd) {
        await client.query(`UPDATE workforce_data_import_rows SET status = 'INVALID', message = $2 WHERE id = $1`, [row.id, parsed.invalidReason]);
        invalid++;
        continue;
      }
      const res = await client.query(
        `INSERT INTO dw_data (code, it_code, old_dw_code, id_vlookup, full_name, gender, bod, profile, dktn,
           cccd, date_of_issue, place_of_issue, permanent_address, residential_address, phone)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (cccd) WHERE deleted_at IS NULL DO UPDATE SET
           code = EXCLUDED.code, it_code = COALESCE(EXCLUDED.it_code, dw_data.it_code), old_dw_code = EXCLUDED.old_dw_code,
           id_vlookup = EXCLUDED.id_vlookup, full_name = EXCLUDED.full_name, gender = EXCLUDED.gender, bod = EXCLUDED.bod,
           profile = EXCLUDED.profile, dktn = EXCLUDED.dktn, date_of_issue = EXCLUDED.date_of_issue,
           place_of_issue = EXCLUDED.place_of_issue, permanent_address = EXCLUDED.permanent_address,
           residential_address = EXCLUDED.residential_address, phone = EXCLUDED.phone
         RETURNING (xmax = 0) AS inserted`,
        [
          parsed.fields.code,
          parsed.fields.itCode,
          parsed.fields.oldDwCode,
          parsed.fields.idVlookup,
          parsed.fullName,
          parsed.fields.gender,
          parsed.fields.bod,
          parsed.fields.profile,
          parsed.fields.dktn,
          parsed.cccd,
          parsed.fields.dateOfIssue,
          parsed.fields.placeOfIssue,
          parsed.fields.permanentAddress,
          parsed.fields.residentialAddress,
          parsed.fields.phone,
        ],
      );
      const wasInserted = res.rows[0]?.inserted === true;
      if (wasInserted) inserted++;
      else updated++;
      await client.query(`UPDATE workforce_data_import_rows SET status = $2 WHERE id = $1`, [row.id, wasInserted ? "INSERTED" : "UPDATED"]);
    }

    await client.query(
      `UPDATE workforce_data_import_batches SET processed_rows = processed_rows + $2, new_rows = new_rows + $3, existing_rows = existing_rows + $4, invalid_rows = invalid_rows + $5, validated_at = COALESCE(validated_at, now()) WHERE id = $1`,
      [batchId, pending.length, inserted, updated, invalid],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    await db.update(workforceDataImportBatches).set({ status: "FAILED", notes: (error as Error).message }).where(eq(workforceDataImportBatches.id, batchId));
    throw error;
  } finally {
    client.release();
  }

  const remaining = await db
    .select({ c: sql<number>`count(*)` })
    .from(workforceDataImportRows)
    .where(and(eq(workforceDataImportRows.batchId, batchId), eq(workforceDataImportRows.status, "PENDING")));
  const done = Number(remaining[0]?.c ?? 0) === 0;
  if (done) {
    await db.update(workforceDataImportBatches).set({ status: "COMPLETED", completedAt: new Date() }).where(eq(workforceDataImportBatches.id, batchId));
  }

  return { processed: pending.length, inserted, updated, invalid, done };
}
