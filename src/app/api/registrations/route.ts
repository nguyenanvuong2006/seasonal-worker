import { NextResponse } from "next/server";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { dailyApplications, departments, dwData, employmentSessions, formQuestions, workerProfiles } from "@/db/schema";
import { getUserScope, hasPermission, requirePermission } from "@/lib/auth";
import { matchDwWorker } from "@/lib/matching";
import { todayStr } from "@/lib/helpers";
import { normalizePersonName } from "@/lib/person-name";
import { runRules } from "@/lib/rule-engine";
import { persistRegistrationAtomically, type RegistrationTransactionRunner } from "@/lib/registration-persistence";
import { findActiveSessionByCccd } from "@/lib/employment";
import { normalizeSelfDeclaration } from "@/lib/employment-lifecycle";
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
    const fullName = normalizePersonName(body.full_name);
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

    type ApplicationInsert = typeof dailyApplications.$inferInsert;
    type ApplicationRow = typeof dailyApplications.$inferSelect;
    type ProfileInsert = typeof workerProfiles.$inferInsert;
    type ProfileRow = typeof workerProfiles.$inferSelect;

    // EMPLOYMENT LIFECYCLE (#5-6) — nếu người này ĐANG có Employment Session ACTIVE:
    //   - application mới VẪN ĐƯỢC LƯU (lịch sử đăng ký không bị chặn/ghi đè);
    //   - self-declaration "đã báo nghỉ bộ phận cũ" (nếu có) được lưu vào application để
    //     Recruiter xác minh — KHÔNG tự đóng session, KHÔNG tạo resignation, KHÔNG xoá allocation;
    //   - employment session mới được tạo ở trạng thái PENDING (chưa phải employment) — invariant
    //     "1 ACTIVE/worker" không bị ảnh hưởng vì chỉ thao tác XẾP VIỆC mới chuyển sang APPROVED.
    const activeEmployment = await findActiveSessionByCccd(cccd);
    const declaration = normalizeSelfDeclaration({
      hasActiveSession: Boolean(activeEmployment),
      declared: body.declared_previous_resignation === true,
      declaredResignationDate: typeof body.declared_resignation_date === "string" ? body.declared_resignation_date : null,
      declaredNote: typeof body.declared_resignation_note === "string" ? body.declared_resignation_note : null,
      activeDeptId: activeEmployment?.deptId ?? null,
      activeSessionId: activeEmployment?.id ?? null,
      now: new Date(),
    });

    const normalizedName = normalizePersonName(match.worker?.fullName ?? fullName);
    const applicationValues: ApplicationInsert = {
      regDate: today,
      cccd,
      fullName: normalizedName,
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
      workerDeclaredPreviousResignation: declaration.workerDeclaredPreviousResignation,
      declaredPreviousDeptId: declaration.declaredPreviousDeptId,
      declaredPreviousSessionId: declaration.declaredPreviousSessionId,
      declaredResignationDate: declaration.declaredResignationDate,
      declaredResignationNote: declaration.declaredResignationNote,
      declaredAt: declaration.declaredAt,
    };
    const profileValues: ProfileInsert = {
      cccd,
      fullName: normalizedName,
      gender: body.gender || match.worker?.gender || null,
      dob: dobStr ?? match.worker?.bod ?? null,
      phone,
      permanentAddress: body.permanent_address || match.worker?.permanentAddress || null,
      residentialAddress,
      dwId: match.worker?.id ?? null,
    };

    // Application + stable profile + employment session are one atomic business write.
    // Validation/matching/rules stay outside because they are read-only; every write is inside
    // this transaction, so a profile/session failure rolls the application insert back.
    const runTransaction: RegistrationTransactionRunner<ApplicationInsert, ApplicationRow, ProfileInsert, ProfileRow> =
      (callback) => db.transaction(async (tx) => callback({
        createApplication: async (input) => {
          const [row] = await tx.insert(dailyApplications).values(input).returning();
          if (!row) throw new Error("Không thể tạo Daily Application.");
          return row;
        },
        upsertProfile: async (input) => {
          const [row] = await tx
            .insert(workerProfiles)
            .values(input)
            .onConflictDoUpdate({
              target: workerProfiles.cccd,
              targetWhere: sql`deleted_at is null`,
              set: { fullName: normalizedName, phone, residentialAddress, updatedAt: new Date() },
            })
            .returning();
          if (!row) throw new Error("Không thể tạo hoặc cập nhật Worker Profile.");
          return row;
        },
        createEmploymentSession: async ({ application, profile }) => {
          // EMPLOYMENT LIFECYCLE — session sinh từ đăng ký công khai KHÔNG bao giờ được tự
          // APPROVED (kể cả khi Rule Engine set status APPROVED cho application): chuyển sang
          // APPROVED là nghiệp vụ XẾP VIỆC có kiểm tra invariant "1 ACTIVE/worker" riêng.
          const sessionStatus = application.status === "APPROVED" ? "PENDING" : application.status;
          await tx.insert(employmentSessions).values({
            workerId: profile.id,
            dailyApplicationId: application.id,
            regDate: today,
            status: sessionStatus,
          });
        },
      }));
    const { application: created } = await persistRegistrationAtomically(runTransaction, {
      application: applicationValues,
      profile: profileValues,
    });

    return NextResponse.json({
      success: true,
      application: created,
      dwMatch: match.status,
      confidence: match.confidence,
    });
  } catch (error) {
    const dbError = error as { code?: string; constraint?: string };
    if (dbError.code === "23505" && dbError.constraint === "daily_app_cccd_date_uq") {
      return NextResponse.json(
        { error: "Đã xác nhận đăng ký hôm nay.", code: "ALREADY_REGISTERED_TODAY" },
        { status: 409 },
      );
    }
    console.error("[registrations/post] atomic registration failed", { code: dbError.code ?? "UNKNOWN", constraint: dbError.constraint ?? null });
    return NextResponse.json({ error: "Không thể hoàn tất đăng ký. Không có dữ liệu đăng ký dở dang được lưu." }, { status: 500 });
  }
}

/** Nội bộ — danh sách. Mặc định CHỈ HÔM NAY; hỗ trợ khoảng ngày để tham khảo. */
export async function GET(req: Request) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER", "DEPT_MANAGER", "HR_DIRECTOR"], "registrations.view");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  const session = guard.session;

  const url = new URL(req.url);
  const from = url.searchParams.get("from") || todayStr();
  const to = url.searchParams.get("to") || from;
  const status = url.searchParams.get("status");
  const deptParam = url.searchParams.get("deptId");
  const matchParam = url.searchParams.get("dwMatch");
  const assigned = url.searchParams.get("assigned");

  const filters = [gte(dailyApplications.regDate, from), lte(dailyApplications.regDate, to), isNull(dailyApplications.deletedAt)];
  if (status && status !== "ALL") filters.push(eq(dailyApplications.status, status));
  if (matchParam && matchParam !== "ALL") filters.push(eq(dailyApplications.dwMatch, matchParam));
  if (assigned === "1") {
    filters.push(isNotNull(dailyApplications.deptId));
    filters.push(ne(dailyApplications.status, "REJECTED"));
  }

  // Data Scope only decides WHERE the user may read. Business permission decides which
  // workflow statuses are visible; assigning a scope to HR must not silently downgrade HR.
  const scope = await getUserScope(session);
  if (scope !== null) {
    if (scope.length === 0) return NextResponse.json({ rows: [] });
    if (deptParam && deptParam !== "ALL" && !scope.includes(deptParam)) return NextResponse.json({ rows: [] });
    filters.push(inArray(dailyApplications.deptId, scope));
  }
  if (deptParam && deptParam !== "ALL") filters.push(eq(dailyApplications.deptId, deptParam));

  const canProcessApplications = await hasPermission(session.role, "registrations.approve");
  if (!canProcessApplications) filters.push(inArray(dailyApplications.status, ["APPROVED", "INACTIVE"]));

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
      itCode: dailyApplications.itCode,
      dwItCode: dwData.itCode,
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
      // EMPLOYMENT LIFECYCLE — self-declaration chờ Recruiter xác minh (#6).
      workerDeclaredPreviousResignation: dailyApplications.workerDeclaredPreviousResignation,
      declaredResignationDate: dailyApplications.declaredResignationDate,
      declaredResignationNote: dailyApplications.declaredResignationNote,
      // EMPLOYMENT LIFECYCLE — trạng thái employment cho badge/warning (#7, #14, #23).
      // ACTIVE := APPROVED + end_date IS NULL; session của CHÍNH application này không tính là "nơi khác".
      activeElsewhereDeptName: sql<string | null>`(
        select d.dept_name from employment_sessions es
        left join departments d on d.id = es.dept_id
        where es.worker_id = ${workerProfiles.id}
          and es.status = 'APPROVED' and es.end_date is null
          and (es.daily_application_id is distinct from ${dailyApplications.id})
        order by es.reg_date desc limit 1
      )`,
      activeSessionCount: sql<number>`(
        select count(*)::int from employment_sessions es
        where es.worker_id = ${workerProfiles.id}
          and es.status = 'APPROVED' and es.end_date is null
      )`,
      endedSessionCount: sql<number>`(
        select count(*)::int from employment_sessions es
        where es.worker_id = ${workerProfiles.id}
          and (es.end_date is not null or es.status = 'ENDED')
      )`,
      pendingResignationCount: sql<number>`(
        select count(*)::int from workforce_movements wm
        where wm.worker_id = ${workerProfiles.id}
          and wm.movement_type = 'resignation' and wm.status = 'PENDING_HR'
      )`,
    })
    .from(dailyApplications)
    .leftJoin(departments, eq(dailyApplications.deptId, departments.id))
    .leftJoin(workerProfiles, and(eq(dailyApplications.cccd, workerProfiles.cccd), isNull(workerProfiles.deletedAt)))
    .leftJoin(dwData, eq(dailyApplications.dwId, dwData.id))
    .where(and(...filters))
    .orderBy(desc(dailyApplications.regDate), asc(dailyApplications.fullName))
    .limit(3000);

  // Chuẩn hoá họ tên trước khi trả về UI (dữ liệu legacy trong DB có thể chưa chuẩn).
  // IT CODE ưu tiên giá trị lưu trên daily_applications; nếu trống thì lấy hiện hành từ DW Data.
  const normalizedRows = rows.map(({ dwItCode, ...r }) => ({
    ...r,
    fullName: normalizePersonName(r.fullName),
    supervisor: normalizePersonName(r.supervisor),
    itCode: r.itCode ?? dwItCode ?? null,
  }));

  return NextResponse.json({ rows: normalizedRows, range: { from, to } });
}
