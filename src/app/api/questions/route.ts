import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { formQuestions } from "@/db/schema";
import { requireRoleAndPermission, writeAudit } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await db.select().from(formQuestions).orderBy(asc(formQuestions.sortOrder));
  return NextResponse.json({ rows });
}

export async function POST(req: Request) {
  const guard = await requireRoleAndPermission(["ADMIN", "HR_RECRUITER"], "questions.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  try {
    const body = await req.json();
    const fieldKey = String(body.fieldKey || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_");

    if (!fieldKey || !body.questionText) {
      return NextResponse.json({ error: "Thiếu mã trường hoặc nội dung câu hỏi." }, { status: 400 });
    }

    const [row] = await db
      .insert(formQuestions)
      .values({
        fieldKey,
        questionText: String(body.questionText),
        fieldType: ["TEXT", "SELECT", "BOOLEAN", "NUMBER"].includes(body.fieldType)
          ? body.fieldType
          : "TEXT",
        options: Array.isArray(body.options)
          ? body.options.map((o: string) => String(o).trim()).filter(Boolean)
          : [],
        isRequired: Boolean(body.isRequired),
        sortOrder: Number(body.sortOrder) || 0,
        isActive: body.isActive === undefined ? true : Boolean(body.isActive),
        applyFrom: body.applyFrom || null,
        aliases: Array.isArray(body.aliases)
          ? body.aliases.map((a: string) => String(a).trim()).filter(Boolean)
          : [],
        exportColumnName: body.exportColumnName || null,
      })
      .returning();

    await writeAudit(guard.session, "CREATE_QUESTION", "form_questions", { id: row.id });
    return NextResponse.json({ success: true, row });
  } catch (error) {
    return NextResponse.json(
      { error: "Mã trường đã tồn tại hoặc dữ liệu sai: " + (error as Error).message },
      { status: 400 },
    );
  }
}

export async function PATCH(req: Request) {
  const guard = await requireRoleAndPermission(["ADMIN", "HR_RECRUITER"], "questions.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const body = await req.json();
  if (!body.id) return NextResponse.json({ error: "Thiếu ID." }, { status: 400 });

  const patch: Record<string, unknown> = {};
  if ("questionText" in body) patch.questionText = body.questionText;
  if ("fieldType" in body) patch.fieldType = body.fieldType;
  if ("options" in body) patch.options = body.options;
  if ("isRequired" in body) patch.isRequired = Boolean(body.isRequired);
  if ("isActive" in body) patch.isActive = Boolean(body.isActive);
  if ("sortOrder" in body) patch.sortOrder = Number(body.sortOrder) || 0;
  if ("applyFrom" in body) patch.applyFrom = body.applyFrom || null;
  if ("aliases" in body) {
    patch.aliases = Array.isArray(body.aliases)
      ? body.aliases.map((a: string) => String(a).trim()).filter(Boolean)
      : [];
  }
  if ("exportColumnName" in body) patch.exportColumnName = body.exportColumnName || null;

  const [row] = await db
    .update(formQuestions)
    .set(patch)
    .where(eq(formQuestions.id, body.id))
    .returning();

  await writeAudit(guard.session, "UPDATE_QUESTION", "form_questions", { id: body.id });
  return NextResponse.json({ success: true, row });
}

export async function DELETE(req: Request) {
  const guard = await requireRoleAndPermission(["ADMIN"], "questions.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Thiếu ID." }, { status: 400 });
  await db.delete(formQuestions).where(eq(formQuestions.id, id));
  await writeAudit(guard.session, "DELETE_QUESTION", "form_questions", { id });
  return NextResponse.json({ success: true });
}
