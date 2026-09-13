import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db, pool } from "@/db";
import { workforceDataImportBatches, workforceDataImportRows } from "@/db/schema";
import { CCCD_ERROR_MESSAGE, isValidCccd, normalizeCccd } from "@/lib/validators";
import type { DataManagementEnvironment } from "./environment";

/**
 * WORKFORCE DATA MANAGEMENT — bulk IT Code (mã số công nhật) reconciliation
 * import (mission sections 5/19-23; corrected terminology per the identity &
 * IT Code contract review, 2026-09-13). This system has no biometric
 * fingerprint table — "IT Code" is an operational attendance/day-worker
 * assignment code string (dw_data.it_code, varchar(40)) a FINGERPRINT_STAFF
 * operator types in one row at a time today via PATCH /api/fingerprint/it-code
 * (route/UI path names are legacy and intentionally left as-is — renaming a
 * live route is a separate, out-of-scope change). This module adds the
 * missing BULK path (an exported file from the attendance/IT-Code device),
 * reusing the EXACT SAME source-of-truth/mirror contract that route already
 * enforces — dw_data.it_code is the source of truth, mirrored to
 * worker_profiles.fingerprint_code/fingerprint_status and
 * daily_applications.it_code (mirror only) — so results are identical
 * whether an operator types one row or imports a file of thousands.
 *
 * IDENTITY CONTRACT (locked): CCCD is the person identity used to resolve
 * WHO an IT Code row belongs to. IT Code itself is never identity — it is
 * the operational payload/assignment being reconciled FOR that person. This
 * import flow is exactly: row → CCCD → resolve person/DW → assign/reconcile
 * IT Code. That is correct and unchanged by the terminology review; only
 * labels/comments referring to it as "fingerprint"/biometric data have been
 * corrected.
 *
 * Reconciliation key is cccd (this system's real natural key — see
 * import-workforce-master.ts's docblock), matched against dw_data — NEVER
 * by name/row-number/phone (mission section 20's explicit prohibition). A
 * match additionally requires the dw_data row to already carry a
 * "Mã số công nhật" (dw_data.code) — the exact same precondition the manual
 * PATCH route enforces ("Chưa có Mã số công nhật — không thể nhập IT CODE.")
 * — never a laxer bulk-only rule.
 *
 * IT Code content safety (mission section 19): it_code is a short
 * device-assigned string, not raw biometric data — but this module still
 * never logs/echoes it anywhere except the per-row result the importing
 * admin already has (their own uploaded file).
 */

const CHUNK_SIZE = 300;
const STAGE_CHUNK_SIZE = 3000;

export type FingerprintRowStatus = "MATCHED" | "UNMATCHED" | "DUPLICATE_WORKER" | "DUPLICATE_FINGERPRINT" | "INVALID_CODE";

export type ParsedFingerprintRow = { rowNumber: number; cccd: string | null; itCode: string | null; status: FingerprintRowStatus | null; reason: string | null };

const clean = (v: unknown): string | null => {
  const s = String(v ?? "").trim();
  return s === "" ? null : s;
};

function pickCccd(raw: Record<string, string>): string | null {
  for (const key of Object.keys(raw)) {
    const normalized = key.trim().toLowerCase();
    if (normalized === "cccd" || normalized === "id no" || normalized === "so cccd" || normalized === "số cccd") return raw[key];
  }
  return raw["cccd"] ?? raw["CCCD"] ?? null;
}
function pickItCode(raw: Record<string, string>): string | null {
  for (const key of Object.keys(raw)) {
    const normalized = key.trim().toLowerCase();
    if (normalized === "it code" || normalized === "itcode" || normalized === "ma van tay" || normalized === "mã vân tay") return raw[key];
  }
  return raw["itCode"] ?? raw["IT CODE"] ?? null;
}

function parseRow(rowNumber: number, raw: Record<string, string>): { cccd: string | null; itCode: string | null; invalidReason: string | null } {
  const cccd = normalizeCccd(pickCccd(raw));
  const itCode = clean(pickItCode(raw));
  if (!isValidCccd(cccd)) return { cccd: cccd || null, itCode, invalidReason: CCCD_ERROR_MESSAGE };
  if (!itCode) return { cccd, itCode: null, invalidReason: "Thiếu IT Code" };
  return { cccd, itCode, invalidReason: null };
}

export type FingerprintDryRunResult = {
  total: number;
  matched: number;
  unmatched: number;
  duplicateWorker: number;
  duplicateFingerprint: number;
  invalidCode: number;
  warnings: string[];
  rows: { rowNumber: number; cccd: string | null; status: FingerprintRowStatus; reason: string | null }[];
};

/** Pure preview — NO database writes. Reconciles against dw_data (+ the code precondition) read-only. */
export async function dryRunFingerprint(rawRows: Record<string, string>[]): Promise<FingerprintDryRunResult> {
  const parsed = rawRows.map((r, i) => ({ rowNumber: i + 1, ...parseRow(i + 1, r) }));

  const cccdCounts = new Map<string, number>();
  for (const row of parsed) {
    if (!row.cccd) continue;
    cccdCounts.set(row.cccd, (cccdCounts.get(row.cccd) ?? 0) + 1);
  }
  const itCodeCounts = new Map<string, number>();
  for (const row of parsed) {
    if (!row.itCode) continue;
    itCodeCounts.set(row.itCode, (itCodeCounts.get(row.itCode) ?? 0) + 1);
  }

  const validCccds = [...new Set(parsed.filter((r) => r.cccd && !r.invalidReason).map((r) => r.cccd as string))];
  const dwRows = validCccds.length
    ? await pool.query<{ cccd: string; code: string | null; it_code: string | null }>(`SELECT cccd, code, it_code FROM dw_data WHERE cccd = ANY($1::text[]) AND deleted_at IS NULL`, [validCccds])
    : { rows: [] as { cccd: string; code: string | null; it_code: string | null }[] };
  const dwByCccd = new Map(dwRows.rows.map((r) => [r.cccd, r]));

  const results: { rowNumber: number; cccd: string | null; status: FingerprintRowStatus; reason: string | null }[] = [];
  for (const row of parsed) {
    if (row.invalidReason) {
      results.push({ rowNumber: row.rowNumber, cccd: row.cccd, status: "INVALID_CODE", reason: row.invalidReason });
      continue;
    }
    if ((cccdCounts.get(row.cccd as string) ?? 0) > 1) {
      results.push({ rowNumber: row.rowNumber, cccd: row.cccd, status: "DUPLICATE_WORKER", reason: "CCCD này xuất hiện nhiều lần trong file" });
      continue;
    }
    if ((itCodeCounts.get(row.itCode as string) ?? 0) > 1) {
      results.push({ rowNumber: row.rowNumber, cccd: row.cccd, status: "DUPLICATE_FINGERPRINT", reason: "IT Code này được gán cho nhiều CCCD khác nhau trong file" });
      continue;
    }
    const dw = dwByCccd.get(row.cccd as string);
    if (!dw) {
      results.push({ rowNumber: row.rowNumber, cccd: row.cccd, status: "UNMATCHED", reason: "Không tìm thấy CCCD trong DW Data" });
      continue;
    }
    if (!clean(dw.code)) {
      results.push({ rowNumber: row.rowNumber, cccd: row.cccd, status: "UNMATCHED", reason: "Chưa có Mã số công nhật — không thể nhập IT CODE" });
      continue;
    }
    if (dw.it_code && dw.it_code !== row.itCode) {
      results.push({ rowNumber: row.rowNumber, cccd: row.cccd, status: "DUPLICATE_FINGERPRINT", reason: `IT Code hiện tại của CCCD này trong hệ thống ("${dw.it_code}") khác với file` });
      continue;
    }
    results.push({ rowNumber: row.rowNumber, cccd: row.cccd, status: "MATCHED", reason: null });
  }

  const warnings: string[] = [];
  const duplicateWorker = results.filter((r) => r.status === "DUPLICATE_WORKER").length;
  const duplicateFingerprint = results.filter((r) => r.status === "DUPLICATE_FINGERPRINT").length;
  if (duplicateWorker > 0) warnings.push(`${duplicateWorker} dòng trùng CCCD trong file.`);
  if (duplicateFingerprint > 0) warnings.push(`${duplicateFingerprint} dòng có IT Code trùng/mâu thuẫn — cần rà soát trước khi import.`);

  return {
    total: rawRows.length,
    matched: results.filter((r) => r.status === "MATCHED").length,
    unmatched: results.filter((r) => r.status === "UNMATCHED").length,
    duplicateWorker,
    duplicateFingerprint,
    invalidCode: results.filter((r) => r.status === "INVALID_CODE").length,
    warnings,
    rows: results,
  };
}

export type CreateFingerprintBatchInput = {
  fileName: string;
  checksum: string;
  rows: Record<string, string>[];
  createdBy: string;
  environment: DataManagementEnvironment;
  datasetMode: "TEST" | "OFFICIAL";
};

export type CreateBatchResult = { ok: true; batchId: string } | { ok: false; error: "DUPLICATE_CHECKSUM"; message: string };

export async function createFingerprintBatch(input: CreateFingerprintBatchInput): Promise<CreateBatchResult> {
  try {
    const [batch] = await db
      .insert(workforceDataImportBatches)
      .values({
        importType: "IT_CODE",
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

export type MergeChunkResult = { processed: number; matched: number; unmatched: number; duplicate: number; done: boolean };

export async function mergeFingerprintChunk(batchId: string, actor: string): Promise<MergeChunkResult> {
  const pending = await db
    .select()
    .from(workforceDataImportRows)
    .where(and(eq(workforceDataImportRows.batchId, batchId), eq(workforceDataImportRows.status, "PENDING")))
    .limit(CHUNK_SIZE);

  if (pending.length === 0) {
    await db.update(workforceDataImportBatches).set({ status: "COMPLETED", completedAt: new Date() }).where(eq(workforceDataImportBatches.id, batchId));
    return { processed: 0, matched: 0, unmatched: 0, duplicate: 0, done: true };
  }

  let matched = 0;
  let unmatched = 0;
  let duplicate = 0;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const row of pending) {
      const { cccd, itCode, invalidReason } = parseRow(row.rowNumber, row.rawData);
      if (invalidReason || !cccd || !itCode) {
        await client.query(`UPDATE workforce_data_import_rows SET status = 'INVALID', message = $2 WHERE id = $1`, [row.id, invalidReason ?? "Thiếu dữ liệu"]);
        unmatched++;
        continue;
      }
      const { rows: dwRows } = await client.query<{ id: string; code: string | null; it_code: string | null }>(`SELECT id, code, it_code FROM dw_data WHERE cccd = $1 AND deleted_at IS NULL LIMIT 1`, [cccd]);
      const dw = dwRows[0];
      if (!dw || !clean(dw.code)) {
        await client.query(`UPDATE workforce_data_import_rows SET status = 'UNMATCHED', message = $2 WHERE id = $1`, [row.id, !dw ? "Không tìm thấy CCCD trong DW Data" : "Chưa có Mã số công nhật"]);
        unmatched++;
        continue;
      }
      if (dw.it_code && dw.it_code !== itCode) {
        await client.query(`UPDATE workforce_data_import_rows SET status = 'DUPLICATE', message = $2 WHERE id = $1`, [row.id, `IT Code hiện tại ("${dw.it_code}") khác với file`]);
        duplicate++;
        continue;
      }

      // SAME source-of-truth/mirror contract as PATCH /api/fingerprint/it-code — dw_data is
      // the write source, worker_profiles/daily_applications only ever mirror it.
      await client.query(`UPDATE dw_data SET it_code = $2, it_code_updated_at = now(), it_code_updated_by = $3 WHERE id = $1`, [dw.id, itCode, actor]);
      await client.query(`UPDATE worker_profiles SET fingerprint_code = $2, fingerprint_status = 'DA_CAP', updated_at = now() WHERE cccd = $1 AND deleted_at IS NULL`, [cccd, itCode]);
      await client.query(`UPDATE daily_applications SET it_code = $2, updated_at = now() WHERE cccd = $1 AND deleted_at IS NULL`, [cccd, itCode]);

      await client.query(`UPDATE workforce_data_import_rows SET status = 'MATCHED' WHERE id = $1`, [row.id]);
      matched++;
    }

    await client.query(
      `UPDATE workforce_data_import_batches SET processed_rows = processed_rows + $2, matched_rows = matched_rows + $3, unmatched_rows = unmatched_rows + $4, duplicate_rows = duplicate_rows + $5, validated_at = COALESCE(validated_at, now()) WHERE id = $1`,
      [batchId, pending.length, matched, unmatched, duplicate],
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

  return { processed: pending.length, matched, unmatched, duplicate, done };
}
