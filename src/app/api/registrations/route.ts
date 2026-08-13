import { NextResponse } from "next/server";
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { dailyApplications, departments, employmentSessions, formQuestions, workerProfiles } from "@/db/schema";
import { getSession, getUserScope } from "@/lib/auth";
import { matchDwWorker } from "@/lib/matching";
import { todayStr } from "@/lib/helpers";
import { runRules } from "@/lib/rule-engine";
import { isQuestionForAudience } from "@/lib/form-targeting";
import { CCCD_ERROR_MESSAGE, isValidCccd } from "@/lib/validators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Cổng công khai — nộp đơn. CCCD BẮT BUỘC. */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const cccd = String(body.cccd ?? "").trim();
    const phone = String(body.phone ?? "").replace(/\D/g, "");
    const fullName = String(body.full_name ?? "").trim();
    const rawAnswers = body.custom_answers && typeof body.custom_answers === "object" && !Array.isArray(body.custom_answers)
      ? body.custom_answers as Record<string, unknown>
      : {};

    if (!isValidCccd(cccd)) {
      return NextResponse.json({ error: CCCD_ERROR_MESSAGE }, { status: 400 });
    }
    if (!/^\d{9,11}$/.test(phone)) {
      return NextResponse.json({ error: "Số điện thoại không hợp lệ." }, { status: 400 });
    }
    if (!fullName) {
      return NextResponse.json({ error: "Thiếu họ và tên." }, { status: 400 });
    }

    const today = todayStr();

    const [dup] = await db
      .select({ id: dailyApplications.id })
      .from(dailyApplications)
      .where(and(eq(dailyApplications.cccd, cccd), eq(dailyApplications.regDate, today), isNull(dailyApplications.deletedAt)))
      .limit(1);
    if (dup) {
      return NextResponse.json(
        { error: "Đã xác nhận đăng ký hôm nay.", code: "ALREADY_REGISTERED_TODAY" },
        { status: 409 },
      );
    }

    // Đối chiếu DW Data (nguồn sự thật) — không phụ thuộc lời khai
    const match = await matchDwWorker({ cccd, fullName, dob: body.dob, phone });

    // Phân loại hoàn toàn từ dữ liệu server; không tin cờ `is_returning` do client gửi.
    const isReturning = match.status === "MATCHED" && match.confidence === "CCCD";
    const activeQuestions = await db
      .select()
      .from(formQuestions)
      .where(
        and(
          eq(formQuestions.isActive, true),
          eq(formQuestions.visibleToApplicants, true),
          sql`(${formQuestions.applyFrom} IS NULL OR ${formQuestions.applyFrom} <= ${today}::date)`,
        ),
      );
    const applicableQuestions = activeQuestions.filter((question) =>
      isQuestionForAudience(question, isReturning ? "RETURNING" : "NEW"),
    );

    // Chỉ lưu câu trả lời thuộc câu hỏi hiện đang hiển thị cho đúng nhóm ứng viên.
    const answers: Record<string, string> = {};
    for (const question of applicableQuestions) {
      const value = rawAnswers[question.fieldKey];
      if (value !== undefined && value !== null) answers[question.fieldKey] = String(value).trim();
      if (question.isRequired && !answers[question.fieldKey]) {
        return NextResponse.json(
          { error: `Thiếu câu trả lời bắt buộc: "${question.questionText}"` },
          { status: 400 },
        );
      }
    }

    const dobStr = String(body.dob ?? "").trim() || null;
    const year = dobStr?.match(/(19|20)\d{2}/)?.[0];
    const birthYear = year ? parseInt(year) : null;
    const computedAge = birthYear ? new Date().getFullYear() - birthYear : null;
    const residentialAddress = String(body.residential_address ?? body.address_current ?? "").trim()
      || match.worker?.residentialAddress
      || null;

    // RULE ENGINE (#6) — chạy các rule đang bật ở trigger ON_REGISTER (cấu hình tại /admin/rules).
    let ruleStatus: string | null = null;
    let ruleNote: string | null = null;
    const ruleActions = await runRules("daily_application", "ON_REGISTER", {
      age: computedAge,
      gender: body.gender ?? null,
      ethnicity: body.ethnicity ?? null,
      dwMatch: match.status,
      declaredType: isReturning ? "OLD" : "NEW",
    });
    for (const a of ruleActions) {
      if (a.type === "SET_STATUS") ruleStatus = a.value;
      if (a.type === "FLAG_NOTE") ruleNote = ruleNote ? `${ruleNote}; ${a.value} (rule: ${a.ruleName})` : `${a.value} (rule: ${a.ruleName})`;
    }

    const [created] = await db
      .insert(dailyApplications)
      .values({
        regDate: today,
        cccd,
        fullName: match.worker?.fullName ?? fullName,
        gender: body.gender || match.worker?.gender || null,
        dob: dobStr ?? match.worker?.bod ?? null,
        birthYear,
        age: computedAge,
        phone,
        ethnicity: body.ethnicity || null,
        permanentAddress: body.permanent_address || match.worker?.permanentAddress || null,
        residentialAddress,
        declaredType: isReturning ? "OLD" : "NEW",
        dwMatch: match.status,
        dwId: match.worker?.id ?? null,
        dwCode: match.worker?.code ?? null,
        workDuration: body.work_duration || null,
        referralChannel: body.referral_channel || null,
        customAnswers: answers,
        status: ruleStatus ?? "PENDING",
        noteWorker: ruleNote,
      })
      .returning();

    // DIGITAL WORKER FILE (#10) — 1 người chỉ có 1 worker_profiles, mỗi lần đăng ký chỉ
    // tạo 1 employment_sessions gắn vào profile đó (KHÔNG tạo "người" mới mỗi lần quay lại).
    const [profile] = await db
      .insert(workerProfiles)
      .values({
        cccd,
        fullName: match.worker?.fullName ?? fullName,
        gender: body.gender || match.worker?.gender || null,
        dob: dobStr ?? match.worker?.bod ?? null,
        phone,
        permanentAddress: body.permanent_address || match.worker?.permanentAddress || null,
        residentialAddress,
        dwId: match.worker?.id ?? null,
      })
      .onConflictDoUpdate({
        target: workerProfiles.cccd,
        targetWhere: sql`deleted_at is null`,
        set: {
          fullName: match.worker?.fullName ?? fullName,
          phone,
          residentialAddress,
          updatedAt: new Date(),
        },
      })
      .returning();

    await db.insert(employmentSessions).values({
      workerId: profile.id,
      dailyApplicationId: created.id,
      regDate: today,
      status: created.status,
    });

    return NextResponse.json({
      success: true,
      application: created,
      dwMatch: match.status,
      confidence: match.confidence,
    });
  } catch (error) {
    return NextResponse.json(
      { error: "Lỗi hệ thống: " + (error as Error).message },
      { status: 500 },
    );
  }
}

/** Nội bộ — danh sách. Mặc định CHỈ HÔM NAY; hỗ trợ khoảng ngày để tham khảo. */
export async function GET(req: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Chưa đăng nhập." }, { status: 401 });

  const url = new URL(req.url);
  const from = url.searchParams.get("from") || todayStr();
  const to = url.searchParams.get("to") || from;
  const status = url.searchParams.get("status");
  const deptParam = url.searchParams.get("deptId");
  const matchParam = url.searchParams.get("dwMatch");

  const filters = [gte(dailyApplications.regDate, from), lte(dailyApplications.regDate, to), isNull(dailyApplications.deletedAt)];
  if (status && status !== "ALL") filters.push(eq(dailyApplications.status, status));
  if (matchParam && matchParam !== "ALL") filters.push(eq(dailyApplications.dwMatch, matchParam));

  if (session.role === "DEPT_MANAGER") {
    const scope = await getUserScope(session);
    if (!scope || scope.length === 0) return NextResponse.json({ rows: [] });
    filters.push(inArray(dailyApplications.deptId, scope));
    filters.push(eq(dailyApplications.status, "APPROVED"));
  } else if (deptParam && deptParam !== "ALL") {
    filters.push(eq(dailyApplications.deptId, deptParam));
  }

  const rows = await db
    .select({
      id: dailyApplications.id,
      regDate: dailyApplications.regDate,
      submittedAt: dailyApplications.submittedAt,
      cccd: dailyApplications.cccd,
      fullName: dailyApplications.fullName,
      gender: dailyApplications.gender,
      dob: dailyApplications.dob,
      age: dailyApplications.age,
      phone: dailyApplications.phone,
      ethnicity: dailyApplications.ethnicity,
      permanentAddress: dailyApplications.permanentAddress,
      residentialAddress: dailyApplications.residentialAddress,
      declaredType: dailyApplications.declaredType,
      dwMatch: dailyApplications.dwMatch,
      dwCode: dailyApplications.dwCode,
      workDuration: dailyApplications.workDuration,
      referralChannel: dailyApplications.referralChannel,
      deptId: dailyApplications.deptId,
      deptName: departments.deptName,
      groupName: departments.groupName,
      vnName: departments.vnName,
      location: departments.location,
      division: departments.division,
      section: departments.section,
      supervisor: departments.supervisor,
      supervisorPhone: departments.supervisorPhone,
      status: dailyApplications.status,
      startingDate: dailyApplications.startingDate,
      appointmentList: dailyApplications.appointmentList,
      noteWorker: dailyApplications.noteWorker,
      vaccine: dailyApplications.vaccine,
      isImported: dailyApplications.isImported,
      customAnswers: dailyApplications.customAnswers,
      workerId: workerProfiles.id,
    })
    .from(dailyApplications)
    .leftJoin(departments, eq(dailyApplications.deptId, departments.id))
    .leftJoin(workerProfiles, and(eq(dailyApplications.cccd, workerProfiles.cccd), isNull(workerProfiles.deletedAt)))
    .where(and(...filters))
    .orderBy(desc(dailyApplications.regDate), asc(dailyApplications.fullName))
    .limit(3000);

  return NextResponse.json({ rows, range: { from, to } });
}
