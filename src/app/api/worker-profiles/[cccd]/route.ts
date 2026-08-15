import { NextResponse } from "next/server";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { departments, employmentSessions, workerProfiles } from "@/db/schema";
import { getUserScope, requirePermission, writeAudit } from "@/lib/auth";
import { normalizePersonName } from "@/lib/person-name";
import { CCCD_ERROR_MESSAGE, isValidCccd, normalizeCccd } from "@/lib/validators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function scopedProfileAndSessions(cccd: string, scope: string[] | null) {
  const [profile] = await db
    .select()
    .from(workerProfiles)
    .where(and(eq(workerProfiles.cccd, cccd), isNull(workerProfiles.deletedAt)));
  if (!profile || (scope !== null && scope.length === 0)) return null;

  const filters = [eq(employmentSessions.workerId, profile.id)];
  if (scope !== null) filters.push(inArray(employmentSessions.deptId, scope));
  const sessions = await db
    .select({
      id: employmentSessions.id,
      regDate: employmentSessions.regDate,
      status: employmentSessions.status,
      startingDate: employmentSessions.startingDate,
      endDate: employmentSessions.endDate,
      note: employmentSessions.note,
      deptId: employmentSessions.deptId,
      deptName: departments.deptName,
      groupName: departments.groupName,
    })
    .from(employmentSessions)
    .leftJoin(departments, eq(employmentSessions.deptId, departments.id))
    .where(and(...filters))
    .orderBy(desc(employmentSessions.regDate));
  // A scoped user cannot use this endpoint as a global CCCD/profile existence oracle.
  if (scope !== null && sessions.length === 0) return null;
  return { profile, sessions };
}

/** Hồ sơ điện tử — scoped users receive only employment history in their departments. */
export async function GET(_req: Request, ctx: { params: Promise<{ cccd: string }> }) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER", "HR_DIRECTOR"], "worker_profile.view");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const params = await ctx.params;
  if (!isValidCccd(params.cccd)) return NextResponse.json({ error: CCCD_ERROR_MESSAGE }, { status: 400 });
  const cccd = normalizeCccd(params.cccd);
  const scope = await getUserScope(guard.session);
  const result = await scopedProfileAndSessions(cccd, scope);
  if (!result) return NextResponse.json({ error: "Không tìm thấy hồ sơ trong phạm vi dữ liệu được cấp." }, { status: 404 });
  return NextResponse.json({ profile: { ...result.profile, fullName: normalizePersonName(result.profile.fullName) }, sessions: result.sessions });
}

/** Cập nhật thông tin Biometric (#16) cho 1 hồ sơ điện tử. */
export async function PATCH(req: Request, ctx: { params: Promise<{ cccd: string }> }) {
  const guard = await requirePermission(["ADMIN"], "worker_profile.edit");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const params = await ctx.params;
  if (!isValidCccd(params.cccd)) return NextResponse.json({ error: CCCD_ERROR_MESSAGE }, { status: 400 });
  const cccd = normalizeCccd(params.cccd);
  const scope = await getUserScope(guard.session);
  const authorized = await scopedProfileAndSessions(cccd, scope);
  if (!authorized) return NextResponse.json({ error: "Không tìm thấy hồ sơ trong phạm vi dữ liệu được cấp." }, { status: 404 });

  const body = (await req.json()) as { fingerprintCode?: string; fingerprintDevice?: string; fingerprintStatus?: string };
  const [row] = await db
    .update(workerProfiles)
    .set({
      fingerprintCode: body.fingerprintCode || null,
      fingerprintDevice: body.fingerprintDevice || null,
      fingerprintStatus: body.fingerprintStatus || "DA_CAP",
      fingerprintCreatedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(workerProfiles.cccd, cccd), isNull(workerProfiles.deletedAt)))
    .returning();
  if (!row) return NextResponse.json({ error: "Không tìm thấy hồ sơ." }, { status: 404 });
  await writeAudit(guard.session, "UPDATE_FINGERPRINT", "worker_profiles", { cccd });
  return NextResponse.json({ success: true, row });
}
