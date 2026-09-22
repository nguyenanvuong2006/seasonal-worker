import { NextResponse } from "next/server";
import { and, or, isNull, lte, asc, desc, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { dailyApplications, formQuestions } from "@/db/schema";
import { requireRoleAndPermission, writeAudit } from "@/lib/auth";
import { normalizeTargetAudience, TARGET_AUDIENCES } from "@/lib/form-targeting";
import { todayStr } from "@/lib/helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MANAGER_ROLES = ["ADMIN", "HR_RECRUITER"] as const;
const FIELD_TYPES = ["TEXT", "SELECT", "NUMBER", "BOOLEAN", "DATE"] as const;

import { getActiveEffectiveQuestions, getEffectiveQuestions } from "@/lib/dynamic-questions";

export async function GET(req: Request) {
  const guard = await requireRoleAndPermission([...MANAGER_ROLES], "questions.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  // Admin page typically wants to see the latest definitions.
  // We can just fetch the effective questions for "today", plus we should 
  // maybe fetch ALL versions if they need to edit?
  // Let's return all rows so Admin can see them, but maybe group them in the UI.
  // Wait, if we return all rows, `sortOrder` is used.
  // Actually, returning all rows is fine for now, the UI can filter or display them.
  const rows = await db.select().from(formQuestions).orderBy(asc(formQuestions.sortOrder), desc(formQuestions.applyFrom));
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
        applyFrom: body.applyFrom || todayStr(),
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
  if ("applyFrom" in body) patch.applyFrom = body.applyFrom || todayStr();
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

  // Enforce historical answer constraints & Versioning logic
  const [currentRow] = await db
    .select()
    .from(formQuestions)
    .where(eq(formQuestions.id, String(body.id)));

  if (!currentRow) return NextResponse.json({ error: "Không tìm thấy câu hỏi." }, { status: 404 });

  let historySensitiveChange = false;
  let reason = "";

  if (patch.fieldType !== undefined && patch.fieldType !== currentRow.fieldType) {
    historySensitiveChange = true;
    reason = "fieldType";
  }

  if (!historySensitiveChange && patch.options !== undefined && Array.isArray(currentRow.options)) {
    const removedOptions = currentRow.options.filter((opt: string) => !patch.options!.includes(opt));
    if (removedOptions.length > 0) {
      historySensitiveChange = true;
      reason = "options";
    }
  }

  try {
    const result = await db.transaction(async (tx) => {
      // 0. Lock the logical fieldKey from concurrent edits
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('form_questions'), hashtext(${currentRow.fieldKey}))`);

      // 1. Lock current row FOR UPDATE
      const [lockedRow] = await tx
        .select()
        .from(formQuestions)
        .where(eq(formQuestions.id, String(body.id)))
        .for("update");

      if (!lockedRow) throw new Error("Không tìm thấy câu hỏi.");

      let historySensitiveChange = false;
      let reason = "";

      if (patch.fieldType !== undefined && patch.fieldType !== lockedRow.fieldType) {
        historySensitiveChange = true;
        reason = "fieldType";
      }

      if (!historySensitiveChange && patch.options !== undefined && Array.isArray(lockedRow.options)) {
        const removedOptions = lockedRow.options.filter((opt: string) => !patch.options!.includes(opt));
        if (removedOptions.length > 0) {
          historySensitiveChange = true;
          reason = "options";
        }
      }

      const newApplyFrom = patch.applyFrom ?? lockedRow.applyFrom;
      let requiresNewVersion = false;

      // Ensure effectiveTo is never <= applyFrom for the new/updated state
      // (The PATCH request itself shouldn't normally provide effectiveTo, but if it did)
      if (newApplyFrom && lockedRow.effectiveTo && newApplyFrom >= lockedRow.effectiveTo) {
        throw Object.assign(new Error("Ngày áp dụng không hợp lệ (lớn hơn hoặc bằng ngày hết hiệu lực)."), { code: "QUESTION_VERSION_OVERLAP" });
      }

      if (historySensitiveChange) {
        // Check if ANY answers exist in the current row's effective window
        let hasIncompatibleAnswersBefore = false;
        let hasIncompatibleAnswersOnOrAfter = false;

        async function checkAnswers(before: boolean) {
          let has = false;
          if (reason === "fieldType") {
            const conditions = [
              isNotNull(sql`${dailyApplications.customAnswers}->>${currentRow.fieldKey}`)
            ];
            if (newApplyFrom) {
               conditions.push(before ? sql`${dailyApplications.regDate} < ${newApplyFrom}` : sql`${dailyApplications.regDate} >= ${newApplyFrom}`);
            }
            if (currentRow.effectiveTo) {
               conditions.push(sql`${dailyApplications.regDate} < ${currentRow.effectiveTo}`);
            }
            if (currentRow.applyFrom) {
               conditions.push(sql`${dailyApplications.regDate} >= ${currentRow.applyFrom}`);
            }

            const existing = await tx.select({ count: sql<number>`count(*)::int` })
              .from(dailyApplications)
              .where(and(...conditions))
              .limit(1);
            has = existing[0] && existing[0].count > 0;
          } else {
            const removedOptions = currentRow.options!.filter((opt: string) => !patch.options!.includes(opt));
            for (const opt of removedOptions) {
              const conditions = [
                eq(sql`${dailyApplications.customAnswers}->>${currentRow.fieldKey}`, opt)
              ];
              if (newApplyFrom) {
                 conditions.push(before ? sql`${dailyApplications.regDate} < ${newApplyFrom}` : sql`${dailyApplications.regDate} >= ${newApplyFrom}`);
              }
              if (currentRow.effectiveTo) {
                 conditions.push(sql`${dailyApplications.regDate} < ${currentRow.effectiveTo}`);
              }
              if (currentRow.applyFrom) {
                 conditions.push(sql`${dailyApplications.regDate} >= ${currentRow.applyFrom}`);
              }

              const existing = await tx.select({ count: sql<number>`count(*)::int` })
                .from(dailyApplications)
                .where(and(...conditions))
                .limit(1);
              if (existing[0] && existing[0].count > 0) {
                has = true;
                break;
              }
            }
          }
          return has;
        }

        hasIncompatibleAnswersOnOrAfter = await checkAnswers(false);
        if (hasIncompatibleAnswersOnOrAfter) {
          throw Object.assign(new Error(`Không thể thay đổi vì đã có câu trả lời từ ngày ${newApplyFrom} trở đi.`), { code: "HISTORICAL_ANSWERS_EXIST" });
        }

        hasIncompatibleAnswersBefore = await checkAnswers(true);

        if (hasIncompatibleAnswersBefore) {
          if (!newApplyFrom || newApplyFrom === currentRow.applyFrom) {
            throw Object.assign(new Error("Thay đổi này ảnh hưởng đến dữ liệu lịch sử. Vui lòng chọn 'Ngày bắt đầu áp dụng' mới để tạo phiên bản câu hỏi mới."), { code: "HISTORICAL_ANSWERS_EXIST" });
          }
          requiresNewVersion = true;
        }
      }

      if (requiresNewVersion) {
        if (newApplyFrom && currentRow.applyFrom && newApplyFrom <= currentRow.applyFrom) {
          throw Object.assign(new Error("Ngày áp dụng mới phải sau ngày áp dụng hiện tại."), { code: "QUESTION_VERSION_OVERLAP" });
        }

        // Prevent overlapping effective windows natively
        // Overlap exists if any OTHER row for this fieldKey overlaps with [newApplyFrom, NULL)
        const overlaps = await tx.select({ count: sql<number>`count(*)::int` })
          .from(formQuestions)
          .where(
            and(
              eq(formQuestions.fieldKey, currentRow.fieldKey),
              sql`${formQuestions.id} != ${currentRow.id}`,
              or(
                isNull(formQuestions.effectiveTo),
                sql`${formQuestions.effectiveTo} > ${newApplyFrom}`
              )
            )
          );

        if (overlaps[0] && overlaps[0].count > 0) {
          throw Object.assign(new Error("Ngày áp dụng bị trùng lặp với phiên bản khác."), { code: "QUESTION_VERSION_OVERLAP" });
        }

        // 1. Cap current row
        await tx.update(formQuestions)
          .set({ effectiveTo: newApplyFrom })
          .where(eq(formQuestions.id, currentRow.id));

        // 2. Insert new row
        const [newRow] = await tx.insert(formQuestions)
          .values({
            ...currentRow,
            ...patch,
            id: undefined, // let DB generate
            fieldKey: currentRow.fieldKey, // immutable
            applyFrom: newApplyFrom,
            effectiveTo: null, // by definition, the new row is open-ended
          })
          .returning();

        return { type: "CREATE_VERSION", row: newRow, previousId: currentRow.id };
      } else {
        // If applyFrom is changed without creating a new version, we must check for overlaps!
        if (patch.applyFrom && patch.applyFrom !== currentRow.applyFrom) {
          const overlaps = await tx.select({ count: sql<number>`count(*)::int` })
            .from(formQuestions)
            .where(
              and(
                eq(formQuestions.fieldKey, currentRow.fieldKey),
                sql`${formQuestions.id} != ${currentRow.id}`,
                or(isNull(formQuestions.effectiveTo), sql`${formQuestions.effectiveTo} > ${patch.applyFrom}`),
                currentRow.effectiveTo
                  ? or(isNull(formQuestions.applyFrom), sql`${formQuestions.applyFrom} < ${currentRow.effectiveTo}`)
                  : undefined
              )
            );
          if (overlaps[0] && overlaps[0].count > 0) {
            throw Object.assign(new Error("Ngày áp dụng bị trùng lặp với phiên bản khác."), { code: "QUESTION_VERSION_OVERLAP" });
          }
        }

        // Update in place
        const [row] = await tx
          .update(formQuestions)
          .set(patch)
          .where(eq(formQuestions.id, currentRow.id))
          .returning();
        
        return { type: "UPDATE", row };
      }
    });

    if (result.type === "CREATE_VERSION") {
      await writeAudit(guard.session, "CREATE_QUESTION_VERSION", "form_questions", { id: result.row.id, previousId: result.previousId });
      return NextResponse.json({ success: true, row: result.row });
    } else {
      await writeAudit(guard.session, "UPDATE_QUESTION", "form_questions", {
        id: result.row.id,
        fields: Object.keys(patch),
      });
      return NextResponse.json({ success: true, row: result.row });
    }
  } catch (error: any) {
    return NextResponse.json(
      { error: "Không thể cập nhật câu hỏi: " + error.message, code: error.code },
      { status: 400 },
    );
  }
}

export async function DELETE(req: Request) {
  const guard = await requireRoleAndPermission(["ADMIN"], "questions.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Thiếu ID." }, { status: 400 });

  const [currentRow] = await db
    .select()
    .from(formQuestions)
    .where(eq(formQuestions.id, id));

  if (!currentRow) return NextResponse.json({ error: "Không tìm thấy câu hỏi." }, { status: 404 });

  const existing = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(dailyApplications)
    .where(isNotNull(sql`${dailyApplications.customAnswers}->>${currentRow.fieldKey}`))
    .limit(1);

  if (existing[0] && existing[0].count > 0) {
    return NextResponse.json({ error: "Không thể xoá câu hỏi này vì đã có ứng viên trả lời.", code: "HISTORICAL_ANSWERS_EXIST" }, { status: 400 });
  }

  const [row] = await db.delete(formQuestions).where(eq(formQuestions.id, id)).returning({ id: formQuestions.id });
  if (!row) return NextResponse.json({ error: "Không tìm thấy câu hỏi." }, { status: 404 });

  await writeAudit(guard.session, "DELETE_QUESTION", "form_questions", { id });
  return NextResponse.json({ success: true });
}
