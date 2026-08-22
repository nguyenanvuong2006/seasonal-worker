import { NextResponse } from "next/server";
import { getUserScope, requirePermission } from "@/lib/auth";
import { scopeAllowsDepartment } from "@/lib/data-scope";
import { db } from "@/db";
import { and, eq, isNull } from "drizzle-orm";
import { recruitmentRequests } from "@/db/schema";
import { addRequestComment, listRequestComments } from "@/lib/workforce-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Bình luận trên Workforce Request (mục 11) — Dept Manager READ + comment nếu có quyền. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(
    ["ADMIN", "HR_RECRUITER", "DEPT_MANAGER", "HR_DIRECTOR"],
    "workforce_request.view",
  );
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const { id } = await ctx.params;
  const [request] = await db
    .select({ departmentId: recruitmentRequests.departmentId })
    .from(recruitmentRequests)
    .where(and(eq(recruitmentRequests.id, id), isNull(recruitmentRequests.deletedAt)));
  if (!request) return NextResponse.json({ error: "Không tìm thấy Workforce Request." }, { status: 404 });

  const scope = await getUserScope(guard.session);
  if (!scopeAllowsDepartment(scope, request.departmentId)) {
    return NextResponse.json({ error: "Không tìm thấy Workforce Request." }, { status: 404 });
  }

  return NextResponse.json({ comments: await listRequestComments(id) });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission(
    ["ADMIN", "HR_RECRUITER", "DEPT_MANAGER", "HR_DIRECTOR"],
    "workforce_request.comment",
  );
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const { id } = await ctx.params;
  const body = (await req.json()) as { body?: string };
  const text = (body.body ?? "").trim();
  if (!text) return NextResponse.json({ error: "Nội dung bình luận không được trống." }, { status: 400 });
  if (text.length > 2000) return NextResponse.json({ error: "Bình luận tối đa 2000 ký tự." }, { status: 400 });

  // Production Recovery audit (IDOR) — GET đã scope-check, POST thì không — 1 DEPT_MANAGER bị
  // giới hạn Data Scope có thể bình luận trên Workforce Request của phòng ban khác.
  const [request] = await db
    .select({ departmentId: recruitmentRequests.departmentId })
    .from(recruitmentRequests)
    .where(and(eq(recruitmentRequests.id, id), isNull(recruitmentRequests.deletedAt)));
  if (!request) return NextResponse.json({ error: "Không tìm thấy Workforce Request." }, { status: 404 });
  const scope = await getUserScope(guard.session);
  if (!scopeAllowsDepartment(scope, request.departmentId)) {
    return NextResponse.json({ error: "Không tìm thấy Workforce Request." }, { status: 404 });
  }

  try {
    const comment = await addRequestComment(id, guard.session, text);
    return NextResponse.json({ success: true, comment });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
