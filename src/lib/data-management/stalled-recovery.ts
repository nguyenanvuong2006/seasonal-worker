import "server-only";
import { and, sql } from "drizzle-orm";
import { db } from "@/db";
import { workforceDataImportBatches } from "@/db/schema";
import { mergeWorkforceMasterChunk, type MergeChunkResult as WorkforceMergeResult } from "./import-workforce-master";
import { mergeFingerprintChunk, type MergeChunkResult as FingerprintMergeResult } from "./import-fingerprint";
import { sanitizeJobError } from "@/lib/scheduler-utils";

/**
 * WORKFORCE DATA IMPORT BATCH WATCHDOG & RECOVERY (F-04)
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * workforce_data_import_batches imports are client-driven via chunked HTTP calls.
 * If the browser, tab, or network closes mid-import, a batch can remain incomplete
 * in status IMPORTING (or STAGED) with pending rows.
 *
 * This module provides the server-side recovery watchdog:
 *   1. Identifies stalled batches (no progress within safe stale threshold).
 *   2. Bounded execution sweep (1 chunk per batch per sweep, 45s execution budget).
 *   3. Relies on single-batch transaction-level advisory locks for concurrency exclusion.
 *   4. Emits structured observability metadata (zero PII).
 */

export const WORKFORCE_IMPORT_STALE_MS = 90_000;

export type StalledBatchInfo = {
  id: string;
  importType: string;
  status: string;
  totalRows: number;
  processedRows: number;
  createdAt: Date;
  validatedAt: Date | null;
  staleMs: number;
};

export async function findStalledBatches(opts?: {
  now?: Date;
  staleMs?: number;
  limit?: number;
}): Promise<StalledBatchInfo[]> {
  const now = opts?.now ?? new Date();
  const staleMs = opts?.staleMs ?? WORKFORCE_IMPORT_STALE_MS;
  const cutoff = new Date(now.getTime() - staleMs);
  const limit = opts?.limit ?? 10;

  const rows = await db
    .select({
      id: workforceDataImportBatches.id,
      importType: workforceDataImportBatches.importType,
      status: workforceDataImportBatches.status,
      totalRows: workforceDataImportBatches.totalRows,
      processedRows: workforceDataImportBatches.processedRows,
      createdAt: workforceDataImportBatches.createdAt,
      validatedAt: workforceDataImportBatches.validatedAt,
    })
    .from(workforceDataImportBatches)
    .where(
      and(
        sql`${workforceDataImportBatches.status} NOT IN ('COMPLETED', 'FAILED', 'REPLACED')`,
        sql`COALESCE(${workforceDataImportBatches.validatedAt}, ${workforceDataImportBatches.createdAt}) < ${cutoff}`,
      ),
    )
    .orderBy(workforceDataImportBatches.createdAt)
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    importType: r.importType,
    status: r.status,
    totalRows: r.totalRows,
    processedRows: r.processedRows,
    createdAt: r.createdAt,
    validatedAt: r.validatedAt,
    staleMs: now.getTime() - (r.validatedAt?.getTime() ?? r.createdAt.getTime()),
  }));
}

export async function resumeStalledBatch(
  batch: { id: string; importType: string },
  actor: string = "system:watchdog",
): Promise<WorkforceMergeResult | FingerprintMergeResult> {
  if (batch.importType === "WORKFORCE_MASTER") {
    return mergeWorkforceMasterChunk(batch.id);
  }
  if (batch.importType === "IT_CODE") {
    return mergeFingerprintChunk(batch.id, actor);
  }
  return {
    processed: 0,
    inserted: 0,
    updated: 0,
    invalid: 0,
    done: true,
    skipped: true,
    reason: "UNKNOWN_IMPORT_TYPE",
  };
}

export type WorkforceImportWatchdogOutcome = {
  batchesFound: number;
  batchesResumed: number;
  batchesCompleted: number;
  rowsAttempted: number;
  rowsCompleted: number;
  durationMs: number;
  batches: {
    batchId: string;
    importType: string;
    processed: number;
    done: boolean;
    skipped?: boolean;
    reason?: string;
    error?: string;
  }[];
};

export async function resumeStalledWorkforceImportBatches(opts?: {
  deadline?: number;
  maxBatches?: number;
  maxChunksPerBatch?: number;
  now?: Date;
  staleMs?: number;
}): Promise<WorkforceImportWatchdogOutcome> {
  const startedAt = Date.now();
  const deadline = opts?.deadline ?? startedAt + 45_000;
  const maxChunksPerBatch = opts?.maxChunksPerBatch ?? 1;

  const stalled = await findStalledBatches({
    now: opts?.now,
    staleMs: opts?.staleMs,
    limit: opts?.maxBatches ?? 10,
  });

  let batchesResumed = 0;
  let batchesCompleted = 0;
  let rowsAttempted = 0;
  let rowsCompleted = 0;
  const batchSummaries: WorkforceImportWatchdogOutcome["batches"] = [];

  for (const batch of stalled) {
    if (Date.now() > deadline) break;

    let chunksRun = 0;
    let lastResult: (WorkforceMergeResult | FingerprintMergeResult) | null = null;
    let batchError: string | undefined = undefined;

    try {
      while (chunksRun < maxChunksPerBatch && Date.now() < deadline) {
        const res = await resumeStalledBatch(batch);
        lastResult = res;
        if (res.skipped) {
          break;
        }
        chunksRun++;
        rowsAttempted += res.processed;
        if ("inserted" in res) {
          rowsCompleted += res.inserted + res.updated;
        } else if ("matched" in res) {
          rowsCompleted += res.matched;
        }
        if (res.done) {
          batchesCompleted++;
          break;
        }
      }
    } catch (err) {
      batchError = sanitizeJobError(err);
    }

    if (chunksRun > 0 || (lastResult && !lastResult.skipped)) {
      batchesResumed++;
    }

    batchSummaries.push({
      batchId: batch.id,
      importType: batch.importType,
      processed: lastResult?.processed ?? 0,
      done: lastResult?.done ?? false,
      skipped: lastResult?.skipped,
      reason: lastResult?.reason,
      error: batchError,
    });
  }

  const durationMs = Date.now() - startedAt;
  const outcome: WorkforceImportWatchdogOutcome = {
    batchesFound: stalled.length,
    batchesResumed,
    batchesCompleted,
    rowsAttempted,
    rowsCompleted,
    durationMs,
    batches: batchSummaries,
  };

  // Structured log for Vercel Logs / log aggregators (zero PII)
  console.log(
    JSON.stringify({
      event: "stalled_workforce_batches_resumed",
      batchesFound: outcome.batchesFound,
      batchesResumed: outcome.batchesResumed,
      batchesCompleted: outcome.batchesCompleted,
      rowsAttempted: outcome.rowsAttempted,
      rowsCompleted: outcome.rowsCompleted,
      durationMs: outcome.durationMs,
    }),
  );

  return outcome;
}
