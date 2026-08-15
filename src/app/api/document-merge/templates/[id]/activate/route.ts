/**
 * POST /api/document-merge/templates/[id]/activate
 * Bật / tắt template. Nếu body không gửi isActive thì đảo trạng thái hiện tại.
 */

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requirePermission, writeAudit } from "@/lib/auth";
import { db } from "@/db";
import { mergeTemplates } from "@/db/schema";

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: RouteContext) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "document_merge.templates.manage");
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  const { id } = await context.params;

  try {
    let requested: boolean | undefined;
    try {
      const body = await request.json();
      if (typeof body.isActive === "boolean") requested = body.isActive;
    } catch {
      requested = undefined;
    }

    const [current] = await db.select().from(mergeTemplates).where(eq(mergeTemplates.id, id)).limit(1);
    if (!current) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }

    const nextActive = requested ?? !current.isActive;
    const [template] = await db
      .update(mergeTemplates)
      .set({
        isActive: nextActive,
        updatedBy: guard.session.username,
        updatedAt: new Date(),
      })
      .where(eq(mergeTemplates.id, id))
      .returning();

    await writeAudit(
      guard.session,
      nextActive ? "ACTIVATE_MERGE_TEMPLATE" : "DEACTIVATE_MERGE_TEMPLATE",
      "merge_templates",
      { templateId: id, templateName: template.name },
    );

    return NextResponse.json(template);
  } catch (error) {
    console.error("[document-merge/templates/activate] error:", error);
    return NextResponse.json({ error: "Failed to toggle template status" }, { status: 500 });
  }
}
