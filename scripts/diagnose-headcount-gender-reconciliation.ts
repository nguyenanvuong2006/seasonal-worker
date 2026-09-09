/**
 * STRICTLY READ-ONLY Production diagnostic (2026-09) for the AI Copilot
 * drill-down gap hardening mission — investigates the real Production
 * discrepancy reported via get_current_headcount: TOTAL ACTIVE = 542,
 * MALE = 186, FEMALE = 355 (186 + 355 = 541, one worker unaccounted for).
 *
 * ZERO writes anywhere: only SELECT. Never touches worker_profiles.gender,
 * never backfills/recomputes anything, never creates/modifies any business
 * row. Uses the EXACT SAME canonical ACTIVE predicate (status='APPROVED'
 * AND end_date IS NULL AND worker_profiles.deleted_at IS NULL) and the EXACT
 * SAME isMale/isFemale/classifyGender/tallyGender functions the real
 * get_current_headcount tool and find_current_workers drill-down tool use —
 * never a reimplementation, so this diagnostic's numbers are guaranteed to
 * match what the AI Copilot itself would report right now.
 *
 * PRIVACY: only the minimum evidence needed to root-cause the discrepancy is
 * logged — worker's operational identifier (worker_profiles.id), display
 * name (via normalizePersonName, the same redaction helper movements.ts
 * already uses in the AI surface), department name, and the RAW stored
 * gender value (safely represented as NULL / EMPTY_STRING / the literal
 * string) so NULL vs empty vs an unrecognized legacy value can be told
 * apart — this is exactly the evidence the mission asks for, nothing more.
 * Never logs CCCD/phone/address/DOB/bank information/document evidence/
 * auth or session information/DATABASE_URL.
 *
 * Cách dùng:
 *   DATABASE_URL=... node --import tsx scripts/diagnose-headcount-gender-reconciliation.ts
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db, pool } from "../src/db/index.ts";
import { departments, employmentSessions, workerProfiles } from "../src/db/schema.ts";
import { normalizePersonName } from "../src/lib/person-name.ts";
import { classifyGender, tallyGender } from "../src/lib/ai-copilot/gender-classification.ts";

function log(event: string, data: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...data }));
}

function reprGender(value: string | null): string {
  if (value === null) return "NULL";
  if (value.trim() === "") return "EMPTY_STRING";
  return JSON.stringify(value);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("❌ Thiếu DATABASE_URL. KHÔNG chạy nếu không chắc chắn đây là production!");
    process.exit(1);
  }

  // ============================================================
  // 1. CÙNG predicate ACTIVE với get_current_headcount (organization.ts) —
  // không lọc theo Data Scope (script chạy ở mức hệ thống, không phải qua
  // một session cụ thể) — đây là toàn bộ workforce ACTIVE công ty.
  // ============================================================
  const rows = await db
    .select({
      workerId: workerProfiles.id,
      fullName: workerProfiles.fullName,
      gender: workerProfiles.gender,
      deptId: employmentSessions.deptId,
    })
    .from(employmentSessions)
    .innerJoin(workerProfiles, eq(employmentSessions.workerId, workerProfiles.id))
    .where(and(eq(employmentSessions.status, "APPROVED"), isNull(employmentSessions.endDate), isNull(workerProfiles.deletedAt)));

  const tally = tallyGender(rows.map((r) => r.gender));
  log("HEADCOUNT_TALLY", {
    total: tally.total,
    male: tally.male,
    female: tally.female,
    unknownGender: tally.unknownGender,
    invariantHolds: tally.male + tally.female + tally.unknownGender === tally.total,
  });

  // ============================================================
  // 2. Danh sách worker rơi vào UNKNOWN — bằng chứng tối thiểu để xác định
  // nguyên nhân (NULL / rỗng / giá trị lạ), KHÔNG có CCCD/SĐT/địa chỉ/DOB.
  // ============================================================
  const unknownRows = rows.filter((r) => classifyGender(r.gender) === "UNKNOWN");
  log("UNKNOWN_GENDER_COUNT", { value: unknownRows.length });

  if (unknownRows.length === 0) {
    log("no_unknown_gender_worker_found", { note: "male + female === total — không có discrepancy tại thời điểm chạy script này." });
    await pool.end();
    return;
  }

  const deptIds = [...new Set(unknownRows.map((r) => r.deptId).filter((id): id is string => !!id))];
  const deptRows = deptIds.length ? await db.select({ id: departments.id, deptName: departments.deptName }).from(departments).where(inArray(departments.id, deptIds)) : [];
  const deptNameById = new Map(deptRows.map((d) => [d.id, d.deptName]));

  for (const r of unknownRows) {
    log("UNKNOWN_GENDER_WORKER", {
      workerId: r.workerId,
      displayName: normalizePersonName(r.fullName) || "(chưa rõ tên)",
      departmentId: r.deptId,
      departmentName: r.deptId ? (deptNameById.get(r.deptId) ?? null) : null,
      // Bằng chứng cốt lõi để root-cause: giá trị THẬT SỰ đang lưu trong
      // worker_profiles.gender — không suy đoán, không che giấu giá trị này
      // (nó không phải CCCD/SĐT/địa chỉ/DOB nên an toàn để ghi log).
      rawGenderValue: reprGender(r.gender),
    });
  }

  await pool.end();
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ event: "fatal_error", error: message.slice(0, 500) }));
  process.exit(1);
});
