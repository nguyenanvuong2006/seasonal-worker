import { NextResponse } from "next/server";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { departments, employmentSessions, workerProfiles } from "@/db/schema";
import { requireRoleAndPermission, writeAudit } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Hồ sơ điện tử (Digital Worker File) — 1 người, toàn bộ lịch sử các đợt làm việc. */
export async function GET(_req: Request, ctx: { params: Promise<{ cccd: string }> }) {
  const guard = await requireRoleAndPermission(["ADMIN", "HR_RECRUITER"], "workers.view");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const { cccd } = await ctx.params;
  const [profile] = await db
    .select()
    .from(workerProfiles)
    .where(and(eq(workerProfiles.cccd, cccd), isNull(workerProfiles.deletedAt)));
  if (!profile) return NextResponse.json({ error: "Không tìm thấy hồ sơ điện tử cho CCCD này." }, { status: 404 });

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
    .where(eq(employmentSessions.workerId, profile.id))
    .orderBy(desc(employmentSessions.regDate));

  return NextResponse.json({ profile, sessions });
}

/** Cập nhật thông tin Biometric (#16) cho 1 hồ sơ điện tử. */
export async function PATCH(req: Request, ctx: { params: Promise<{ cccd: string }> }) {
  const guard = await requireRoleAndPermission(["ADMIN"], "workers.edit");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const { cccd } = await ctx.params;
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
    .where(eq(workerProfiles.cccd, cccd))
    .returning();

  if (!row) return NextResponse.json({ error: "Không tìm thấy hồ sơ." }, { status: 404 });
  await writeAudit(guard.session, "UPDATE_FINGERPRINT", "worker_profiles", { cccd });
  return NextResponse.json({ success: true, row });
}
