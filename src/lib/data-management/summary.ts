import "server-only";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { workforceDataImportBatches, dwData, workerProfiles, employmentSessions } from "@/db/schema";
import { checkDataResetAllowed } from "./environment";
import { RESET_SCOPES, RESET_SCOPE_LABELS, expandResetScopes, type ResetScope } from "./scopes";

/**
 * WORKFORCE DATA MANAGEMENT — "Tổng quan" summary (mission sections 30/40).
 * Read-only aggregation: environment/reset-lock status + the latest
 * completed import batch per type ("current dataset" — mission section 40)
 * + a quick current-size snapshot so an admin can sanity-check before
 * opening Reset/Import. Never the source of Current Workforce truth itself
 * (that stays Employment — see countActiveDepartmentWorkforce et al.).
 */

export type DatasetStateEntry = {
  importType: "WORKFORCE_MASTER" | "IT_CODE";
  datasetMode: "TEST" | "OFFICIAL" | null;
  batchId: string | null;
  sourceFilename: string | null;
  importedAt: string | null;
  rowCount: number | null;
  sourceChecksum: string | null;
};

export type DataManagementSummary = {
  environment: string;
  resetAllowed: boolean;
  resetBlockedReason: string | null;
  currentDatasets: DatasetStateEntry[];
  quickCounts: { dwDataRows: number; workerProfileRows: number; activeEmploymentSessions: number };
  scopes: { scope: ResetScope; label: string; domainCount: number }[];
};

export async function getDataManagementSummary(): Promise<DataManagementSummary> {
  const guard = checkDataResetAllowed();

  const currentDatasets: DatasetStateEntry[] = [];
  for (const importType of ["WORKFORCE_MASTER", "IT_CODE"] as const) {
    const [latest] = await db
      .select()
      .from(workforceDataImportBatches)
      .where(eq(workforceDataImportBatches.importType, importType))
      .orderBy(desc(workforceDataImportBatches.createdAt))
      .limit(1);
    if (!latest || latest.status !== "COMPLETED") {
      currentDatasets.push({ importType, datasetMode: null, batchId: null, sourceFilename: null, importedAt: null, rowCount: null, sourceChecksum: null });
      continue;
    }
    currentDatasets.push({
      importType,
      datasetMode: latest.datasetMode as "TEST" | "OFFICIAL",
      batchId: latest.id,
      sourceFilename: latest.sourceFilename,
      importedAt: latest.completedAt?.toISOString() ?? latest.createdAt.toISOString(),
      rowCount: latest.totalRows,
      sourceChecksum: latest.sourceChecksum,
    });
  }

  const [dwCountRow] = await db.select({ c: sql<number>`count(*)` }).from(dwData);
  const [workerCountRow] = await db.select({ c: sql<number>`count(*)` }).from(workerProfiles);
  const [activeSessionsRow] = await db
    .select({ c: sql<number>`count(*)` })
    .from(employmentSessions)
    .where(sql`status = 'APPROVED' AND end_date IS NULL`);

  const scopes = RESET_SCOPES.map((scope) => ({ scope, label: RESET_SCOPE_LABELS[scope], domainCount: expandResetScopes([scope]).domains.length }));

  return {
    environment: guard.environment,
    resetAllowed: guard.allowed,
    resetBlockedReason: guard.allowed ? null : guard.reason,
    currentDatasets,
    quickCounts: {
      dwDataRows: Number(dwCountRow?.c ?? 0),
      workerProfileRows: Number(workerCountRow?.c ?? 0),
      activeEmploymentSessions: Number(activeSessionsRow?.c ?? 0),
    },
    scopes,
  };
}
