import { NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { dailyApplications, employmentSessions } from "@/db/schema";
import { requireRoleAndPermission, writeAudit } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EDITABLE = [
  "cccd",
  "fullName",
  "gender",
  "dob",
  "phone",
  "ethnicity",
  "permanentAddress",
  "residentialAddress",
  "deptId",
  "status",
  "startingDate",
  "appointmentList",
  "noteWorker",
  "vaccine",
  "workDuration",
  "referralChannel",
  "declaredType",
] as const;

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireRoleAndPermission(["ADMIN", "HR_RECRUITER"], "registrations.edit");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  try {
    const { id } = await ctx.params;
    const body = (await req.json()) as Record<string, unknown>;
    const reason = typeof body.reason === "string" ? body.reason : null;

    const [existing] = await db.select().from(dailyApplications).where(eq(dailyApplications.id, id));
    if (!existing) return NextResponse.json({ error: "Không tìm thấy hồ sơ." }, { status: 404 });

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    for (const key of EDITABLE) {
      if (key in body) {
        const v = body[key];
        patch[key] = v === "" || v === "ALL" ? null : v;
      }
    }
    if (Object.keys(patch).length === 1) {
      return NextResponse.json({ error: "Không có dữ liệu cập nhật." }, { status: 400 });
    }
    if (typeof patch.cccd === "string" && !/^\d{9,12}$/.test(patch.cccd)) {
      return NextResponse.json({ error: "CCCD phải từ 9-12 chữ số." }, { status: 400 });
    }

    const [updated] = await db
      .update(dailyApplications)
      .set(patch)
      .where(eq(dailyApplications.id, id))
      .returning();

    if (!updated) return NextResponse.json({ error: "Không tìm thấy hồ sơ." }, { status: 404 });

    // DIGITAL WORKER FILE (#10) — đồng bộ trạng thái/bộ phận/ngày bắt đầu sang employment_sessions
    // tương ứng, để hồ sơ điện tử của người lao động luôn phản ánh đúng đợt làm việc hiện tại.
    const sessionPatch: Record<string, unknown> = {};
    if ("status" in patch) sessionPatch.status = patch.status;
    if ("deptId" in patch) sessionPatch.deptId = patch.deptId;
    if ("startingDate" in patch) sessionPatch.startingDate = patch.startingDate;
    if (Object.keys(sessionPatch).length > 0) {
      await db.update(employmentSessions).set(sessionPatch).where(eq(employmentSessions.dailyApplicationId, id));
    }

    // VERSIONING: lưu snapshot trước/sau (chỉ các trường có thay đổi) để xem lịch sử & khôi phục.
    const beforeSnapshot = Object.fromEntries(
      Object.keys(patch)
        .filter((k) => k !== "updatedAt")
        .map((k) => [k, (existing as Record<string, unknown>)[k]]),
    );
    await writeAudit(guard.session, "INLINE_EDIT", "daily_applications", {
      id,
      before: beforeSnapshot,
      after: patch,
      reason,
    });
    return NextResponse.json({ success: true, row: updated });
  } catch (error) {
    return NextResponse.json(
      { error: "Lỗi hệ thống: " + (error as Error).message },
      { status: 500 },
    );
  }
}

/** Xoá mềm — hồ sơ ẩn khỏi Daily Application nhưng vẫn còn trong database, khôi phục tại /admin/recycle-bin. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireRoleAndPermission(["ADMIN", "HR_RECRUITER"], "registrations.edit");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const { id } = await ctx.params;
  await db
    .update(dailyApplications)
    .set({ deletedAt: new Date(), deletedBy: guard.session.username })
    .where(and(eq(dailyApplications.id, id), isNull(dailyApplications.deletedAt)));
  await writeAudit(guard.session, "SOFT_DELETE_APPLICATION", "daily_applications", { id });
  return NextResponse.json({ success: true });
}
