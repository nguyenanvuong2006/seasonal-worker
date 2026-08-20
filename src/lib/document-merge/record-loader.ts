/**
 * Shared record loader — load daily application records (with dept / dw / worker
 * joins) into flattened merge records cho Data Resolver.
 *
 * Dùng chung cho:
 *   - Next.js route (merge/execute, preview) — đã có bản copy inline (legacy).
 *   - Cloud Run worker (Phase 3) — cần load record theo item.sourceRecordId.
 *
 * KHÔNG import server-only → worker (plain Node) import được.
 */

import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../../db";
import { dailyApplications, departments, dwData, workerProfiles } from "../../db/schema";
import { buildApplicantMergeRecord } from "./applicant-record.ts";

export async function loadDailyApplicationRecords(recordIds: string[]): Promise<Map<string, Record<string, unknown>>> {
  const dataMap = new Map<string, Record<string, unknown>>();
  if (recordIds.length === 0) return dataMap;

  const rows = await db
    .select({
      application: dailyApplications,
      deptName: departments.deptName,
      groupName: departments.groupName,
      vnName: departments.vnName,
      location: departments.location,
      division: departments.division,
      section: departments.section,
      supervisor: departments.supervisor,
      supervisorPhone: departments.supervisorPhone,
      dw: dwData,
      worker: workerProfiles,
    })
    .from(dailyApplications)
    .leftJoin(departments, eq(dailyApplications.deptId, departments.id))
    .leftJoin(dwData, eq(dailyApplications.dwId, dwData.id))
    .leftJoin(
      workerProfiles,
      and(eq(dailyApplications.cccd, workerProfiles.cccd), isNull(workerProfiles.deletedAt)),
    )
    .where(and(inArray(dailyApplications.id, recordIds), isNull(dailyApplications.deletedAt)));

  for (const row of rows) {
    dataMap.set(
      row.application.id,
      buildApplicantMergeRecord({
        application: {
          id: row.application.id,
          cccd: row.application.cccd,
          fullName: row.application.fullName,
          gender: row.application.gender,
          dob: row.application.dob,
          phone: row.application.phone,
          ethnicity: row.application.ethnicity,
          permanentAddress: row.application.permanentAddress,
          residentialAddress: row.application.residentialAddress,
          declaredType: row.application.declaredType,
          dwMatch: row.application.dwMatch,
          dwCode: row.application.dwCode,
          itCode: row.application.itCode,
          workDuration: row.application.workDuration,
          referralChannel: row.application.referralChannel,
          status: row.application.status,
          regDate: row.application.regDate,
          startingDate: row.application.startingDate,
          customAnswers: row.application.customAnswers,
        },
        department: {
          deptName: row.deptName,
          groupName: row.groupName,
          vnName: row.vnName,
          location: row.location,
          division: row.division,
          section: row.section,
          supervisor: row.supervisor,
          supervisorPhone: row.supervisorPhone,
        },
        dw: row.dw,
        worker: row.worker,
      }),
    );
  }

  return dataMap;
}
