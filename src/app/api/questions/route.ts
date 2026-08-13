import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { formQuestions } from "@/db/schema";
import { requireRoleAndPermission, writeAudit } from "@/lib/auth";
import { normalizeTargetAudience, TARGET_AUDIENCES } from "@/lib/form-targeting";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MANAGER_ROLES = ["ADMIN", "HR_RECRUITER"] as const;
const FIELD_TYPES = ["TEXT", "SELECT", "NUMBER", "BOOLEAN", "DATE"] as const;

export async function GET() {
  const guard = await requireRoleAndPermission([...MANAGER_ROLES], "questions.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const rows = await db.select().from(formQuestions).orderBy(asc(formQuestions.sortOrder));
  return NextResponse.json({ rows });
}

export async function POST(req: Request) {
  const guard = await requireRoleAndPermission([...MANAGER_ROLES], "questions.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  try {
    const body = await req.json();
    const fieldKey = String(body.fieldKey ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "_");
    const questionText = String(body.questionText ?? "").trim();
    const fieldType = String(body.fieldType ?? "TEXT");

    if (!fieldKey || !questionText) {
      return NextResponse.json({ error: "Thiếu mã trường hoặc nội dung câu hỏi." }, { status: 400 });
    }
    if (!FIELD_TYPES.includes(fieldType as (typeof FIELD_TYPES)[number])) {
      return NextResponse.json({ error: "Loại trường không hợp lệ." }, { status: 400 });
    }
    if (
      body.targetAudience !== undefined &&
      !TARGET_AUDIENCES.includes(body.targetAudience as (typeof TARGET_AUDIENCES)[number])
    ) {
      return NextResponse.json({ error: "Nhóm ứng viên không hợp lệ." }, { status: 400 });
    }

    const [row] = await db
      .insert(formQuestions)
      .values({
        fieldKey,
        questionText,
        fieldType,
        options: Array.isArray(body.options)
          ? body.options.map((option: unknown) => String(option).trim()).filter(Boolean)
          : [],
        isRequired: Boolean(body.isRequired),
        sortOrder: Number(body.sortOrder) || 0,
        isActive: body.isActive === undefined ? true : Boolean(body.isActive),
        visibleToApplicants:
          body.visibleToApplicants === undefined ? true : Boolean(body.visibleToApplicants),
        targetAudience: normalizeTargetAudience(body.targetAudience),
        skipForReturning: Boolean(body.skipForReturning),
        applyFrom: body.applyFrom || null,
        aliases: Array.isArray(body.aliases)
          ? body.aliases.map((alias: unknown) => String(alias).trim()).filter(Boolean)
          : [],
        exportColumnName: body.exportColumnName
          ? String(body.exportColumnName).trim()
          : null,
      })
      .returning();

    await writeAudit(guard.session, "CREATE_QUESTION", "form_questions", { id: row.id });
    return NextResponse.json({ success: true, row }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: "Mã trường đã tồn tại hoặc dữ liệu sai: " + (error as Error).message },
      { status: 400 },
    );
  }
}

export async function PATCH(req: Request) {
  const guard = await requireRoleAndPermission([...MANAGER_ROLES], "questions.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const body = await req.json();
  if (!body.id) return NextResponse.json({ error: "Thiếu ID." }, { status: 400 });
  if (
    body.targetAudience !== undefined &&
    !TARGET_AUDIENCES.includes(body.targetAudience as (typeof TARGET_AUDIENCES)[number])
  ) {
    return NextResponse.json({ error: "Nhóm ứng viên không hợp lệ." }, { status: 400 });
  }
  if (
    body.fieldType !== undefined &&
    !FIELD_TYPES.includes(String(body.fieldType) as (typeof FIELD_TYPES)[number])
  ) {
    return NextResponse.json({ error: "Loại trường không hợp lệ." }, { status: 400 });
  }

  const patch: Partial<typeof formQuestions.$inferInsert> = {};
  if ("questionText" in body) {
    const questionText = String(body.questionText ?? "").trim();
    if (!questionText) {
      return NextResponse.json({ error: "Nội dung câu hỏi không được để trống." }, { status: 400 });
    }
    patch.questionText = questionText;
  }
  if ("fieldType" in body) patch.fieldType = String(body.fieldType);
  if ("options" in body) {
    patch.options = Array.isArray(body.options)
      ? body.options.map((option: unknown) => String(option).trim()).filter(Boolean)
      : [];
  }
  if ("isRequired" in body) patch.isRequired = Boolean(body.isRequired);
  if ("isActive" in body) patch.isActive = Boolean(body.isActive);
  if ("visibleToApplicants" in body) {
    patch.visibleToApplicants = Boolean(body.visibleToApplicants);
  }
  if ("targetAudience" in body) {
    patch.targetAudience = normalizeTargetAudience(body.targetAudience);
  }
  if ("skipForReturning" in body) patch.skipForReturning = Boolean(body.skipForReturning);
  if ("sortOrder" in body) patch.sortOrder = Number(body.sortOrder) || 0;
  if ("applyFrom" in body) patch.applyFrom = body.applyFrom || null;
  if ("aliases" in body) {
    patch.aliases = Array.isArray(body.aliases)
      ? body.aliases.map((alias: unknown) => String(alias).trim()).filter(Boolean)
      : [];
  }
  if ("exportColumnName" in body) {
    patch.exportColumnName = body.exportColumnName
      ? String(body.exportColumnName).trim()
      : null;
  }

  try {
    const [row] = await db
      .update(formQuestions)
      .set(patch)
      .where(eq(formQuestions.id, String(body.id)))
      .returning();
    if (!row) return NextResponse.json({ error: "Không tìm thấy câu hỏi." }, { status: 404 });

    await writeAudit(guard.session, "UPDATE_QUESTION", "form_questions", {
      id: row.id,
      fields: Object.keys(patch),
    });
    return NextResponse.json({ success: true, row });
  } catch (error) {
    return NextResponse.json(
      { error: "Không thể cập nhật câu hỏi: " + (error as Error).message },
      { status: 400 },
    );
  }
}

export async function DELETE(req: Request) {
  const guard = await requireRoleAndPermission(["ADMIN"], "questions.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Thiếu ID." }, { status: 400 });

  const [row] = await db.delete(formQuestions).where(eq(formQuestions.id, id)).returning({ id: formQuestions.id });
  if (!row) return NextResponse.json({ error: "Không tìm thấy câu hỏi." }, { status: 404 });

  await writeAudit(guard.session, "DELETE_QUESTION", "form_questions", { id });
  return NextResponse.json({ success: true });
}
