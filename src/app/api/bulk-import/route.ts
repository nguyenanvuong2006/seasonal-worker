import { NextResponse } from "next/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { dailyApplications, employmentSessions } from "@/db/schema";
import { getUserScope, requireRoleAndPermission, writeAudit } from "@/lib/auth";
import { scopeAllowsDepartment } from "@/lib/data-scope";
import { todayStr } from "@/lib/helpers";
import { normalizePersonName } from "@/lib/person-name";
import { loadActiveRules, runRules } from "@/lib/rule-engine";
import { queueNotification } from "@/lib/notifications";
import { autoAllocateInternship } from "@/lib/planning";
import { isValidCccd, normalizeCccd } from "@/lib/validators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const MAX_BULK = 500;

type RowResult = { id: string; cccd: string | null; fullName: string | null; ok: boolean; reason: string };

/**
 * BƯỚC A — "Sắp xếp công việc/bộ phận" (Duyệt hàng loạt): APPROVE + xếp việc
 * (employment_sessions APPROVED + Planning allocation). KHÔNG đụng DW Data —
 * đó là BƯỚC B, hành động riêng biệt tại POST /api/bulk-import/dw (mục IV
 * trong đề bài: "xếp việc" và "Nhập vào DW Data" là hai hành động tách bạch,
 * không được gộp vào cùng một nút/API).
 */
export async function POST(req: Request) {
  const guard = await requireRoleAndPermission(["ADMIN", "HR_RECRUITER"], "registrations.approve");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  try {
    const { ids, departmentId, status } = (await req.json()) as {
      ids: string[];
      departmentId?: string | null;
      status?: string;
    };

    if (!Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json({ error: "Danh sách hồ sơ rỗng." }, { status: 400 });
    }
    if (ids.length > MAX_BULK) {
      return NextResponse.json(
        { error: `Vượt quá giới hạn! Mỗi lần chỉ được duyệt tối đa ${MAX_BULK} lao động.` },
        { status: 429 },
      );
    }
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!ids.every((id) => typeof id === "string" && uuidRe.test(id))) {
      return NextResponse.json({ error: "Mã hồ sơ không hợp lệ." }, { status: 400 });
    }

    const finalStatus = status === "REJECTED" || status === "WAITLIST" ? status : "APPROVED";
    const today = todayStr();
    const deptId = departmentId && departmentId !== "ALL" ? departmentId : null;
    const scope = await getUserScope(guard.session);
    if (deptId && !scopeAllowsDepartment(scope, deptId)) {
      return NextResponse.json({ error: "Bộ phận đích nằm ngoài Data Scope được cấp." }, { status: 403 });
    }

    const result = await db.transaction(async (tx) => {
      // BƯỚC 0/4 — Duyệt hồ sơ (#1 yêu cầu nghiệp vụ): phân loại RÕ RÀNG từng ID thay vì âm thầm
      // loại bỏ những dòng không đủ điều kiện — để khi có 0 thay đổi, người dùng biết CHÍNH XÁC vì sao.
      const selectedTargets = await tx.select().from(dailyApplications).where(inArray(dailyApplications.id, ids));
      // Outside-scope IDs are deliberately treated as not found so this endpoint cannot be used
      // as an existence/PII oracle. Scoped users may only process already-owned applications.
      const allTargets = scope === null ? selectedTargets : selectedTargets.filter((target) => scopeAllowsDepartment(scope, target.deptId));
      const foundIds = new Set(allTargets.map((t) => t.id));

      const results: RowResult[] = [];
      for (const id of ids) {
        if (!foundIds.has(id)) {
          results.push({ id, cccd: null, fullName: null, ok: false, reason: "Không tìm thấy hồ sơ (có thể đã bị xoá hoặc ID không hợp lệ)" });
        }
      }

      const invalidIdentity = allTargets.filter(
        (target) => !isValidCccd(target.cccd) || target.cccd !== normalizeCccd(target.cccd),
      );
      const invalidIdentityIds = new Set(invalidIdentity.map((target) => target.id));
      for (const target of invalidIdentity) {
        results.push({
          id: target.id,
          cccd: target.cccd,
          fullName: normalizePersonName(target.fullName),
          ok: false,
          reason: "CCCD phải gồm đúng 12 chữ số trước khi xử lý hồ sơ",
        });
      }

      const alreadyAtStatus = allTargets.filter((target) => target.status === finalStatus && !invalidIdentityIds.has(target.id));
      for (const t of alreadyAtStatus) {
        results.push({ id: t.id, cccd: t.cccd, fullName: normalizePersonName(t.fullName), ok: false, reason: "Hồ sơ đã ở đúng trạng thái này từ trước — không có gì để duyệt lại (bỏ qua)" });
      }

      let targets = allTargets.filter((target) => target.status !== finalStatus && !invalidIdentityIds.has(target.id));

      // EMPLOYMENT LIFECYCLE (#3/#8) — KHÔNG xếp việc âm thầm: loại khỏi lô duyệt bất kỳ hồ sơ
      // nào mà worker đang có Employment Session ACTIVE Ở NƠI KHÁC (session không thuộc chính
      // application này). Phải xử lý riêng qua “Yêu cầu xác nhận nghỉ” / “Xác nhận nghỉ & xếp việc mới”.
      if (finalStatus === "APPROVED" && targets.length > 0) {
        const targetIds = targets.map((t) => t.id);
        const conflicts = await tx.execute(sql`
          SELECT es.daily_application_id AS "dailyApplicationId", d.dept_name AS "activeDeptName"
          FROM employment_sessions es
          JOIN employment_sessions active_es ON active_es.worker_id = es.worker_id
            AND active_es.status = 'APPROVED' AND active_es.end_date IS NULL
            AND active_es.id <> es.id
          LEFT JOIN departments d ON d.id = active_es.dept_id
          WHERE es.daily_application_id IN (${sql.join(targetIds.map((tid) => sql`${tid}`), sql`, `)})`);
        const conflictByApp = new Map<string, string | null>();
        for (const c of conflicts.rows as { dailyApplicationId: string; activeDeptName: string | null }[]) {
          conflictByApp.set(c.dailyApplicationId, c.activeDeptName);
        }
        const blocked = targets.filter((t) => conflictByApp.has(t.id));
        for (const t of blocked) {
          results.push({
            id: t.id,
            cccd: t.cccd,
            fullName: normalizePersonName(t.fullName),
            ok: false,
            reason: `Đang được ghi nhận ĐANG LÀM VIỆC tại "${conflictByApp.get(t.id) ?? "bộ phận khác"}" — cần xác nhận nghỉ bộ phận cũ trước khi xếp việc mới (không duyệt trong lô)`,
          });
        }
        targets = targets.filter((t) => !conflictByApp.has(t.id));
      }

      if (targets.length === 0) {
        return { updated: 0, results, processedIds: [] as string[] };
      }

      // KHÔNG đụng dw_data ở đây (mục IV) — "Nhập vào DW Data" là hành động RIÊNG,
      // rõ ràng, do Recruiter chủ động thực hiện SAU khi xếp việc xong, tại
      // POST /api/bulk-import/dw (xem src/lib/daily-intake-workflow.ts).

      const updated = await tx
        .update(dailyApplications)
        .set({
          status: finalStatus,
          isImported: finalStatus === "APPROVED" ? true : undefined,
          ...(deptId ? { deptId } : {}),
          ...(finalStatus === "APPROVED" ? { startingDate: today } : {}),
          updatedAt: new Date(),
        })
        .where(inArray(dailyApplications.id, targets.map((t) => t.id)))
        .returning({ id: dailyApplications.id });

      // DIGITAL WORKER FILE (#10) — đồng bộ trạng thái/bộ phận/ngày bắt đầu sang employment_sessions.
      const updatedSessions = await tx
        .update(employmentSessions)
        .set({
          status: finalStatus,
          ...(deptId ? { deptId } : {}),
          // RULE #10 — DEFAULT START DATE = hôm nay (Asia/Ho_Chi_Minh) tại thời điểm Recruiter
          // xếp việc, KHÔNG phải reg_date của application (application_date ≠ employment_start_date).
          ...(finalStatus === "APPROVED" ? { startingDate: today, startDateSource: "ASSIGNMENT" } : {}),
        })
        .where(inArray(employmentSessions.dailyApplicationId, targets.map((t) => t.id)))
        .returning({ id: employmentSessions.id, deptId: employmentSessions.deptId, startingDate: employmentSessions.startingDate });

      if (finalStatus === "APPROVED") {
        for (const s of updatedSessions) {
          const targetDept = s.deptId ?? deptId;
          if (targetDept) {
            await autoAllocateInternship(s.id, targetDept, s.startingDate, guard.session.username, tx);
          }
        }
      }

      for (const t of targets) {
        const reason =
          finalStatus === "APPROVED"
            ? "Đã duyệt và xếp việc — dùng “Nhập vào DW Data” để hoàn tất bước tiếp theo"
            : finalStatus === "REJECTED"
              ? "Đã từ chối"
              : "Đã chuyển vào danh sách dự phòng (Waitlist)";
        results.push({ id: t.id, cccd: t.cccd, fullName: normalizePersonName(t.fullName), ok: true, reason });
      }

      return { updated: updated.length, results, processedIds: targets.map((t) => t.id) };
    });

    // RULE ENGINE (#6, trigger ON_APPROVE) — chỉ áp dụng hành động "Thêm ghi chú cảnh báo",
    // không đổi lại status vừa duyệt (tránh xung đột với lựa chọn của HR).
    // NOTIFICATION FOUNDATION (#10) — xếp hàng đợi thông báo cho từng hồ sơ vừa Duyệt.
    // CHỈ xử lý result.processedIds (hồ sơ THỰC SỰ vừa đổi trạng thái ở lần gọi này) — tránh
    // xếp hàng đợi thông báo trùng lặp khi người dùng bấm duyệt nhiều lần trên cùng 1 hồ sơ.
    if (finalStatus === "APPROVED" && result.processedIds.length > 0) {
      const approvedRows = await db
        .select()
        .from(dailyApplications)
        .where(inArray(dailyApplications.id, result.processedIds));
      // Perf (Production Recovery audit) — TRƯỚC ĐÂY runRules() tự query lại bảng `rules` (cùng
      // entityType/trigger, kết quả giống hệt) ở MỖI vòng lặp. Tải 1 lần, dùng chung cho cả batch.
      const preloadedRules = await loadActiveRules("daily_application");
      for (const row of approvedRows) {
        const actions = await runRules(
          "daily_application",
          "ON_APPROVE",
          {
            age: row.age,
            gender: row.gender,
            ethnicity: row.ethnicity,
            dwMatch: row.dwMatch,
            declaredType: row.declaredType,
          },
          preloadedRules,
        );
        const notes = actions.filter((a) => a.type === "FLAG_NOTE").map((a) => `${a.value} (rule: ${a.ruleName})`);
        if (notes.length) {
          await db
            .update(dailyApplications)
            .set({ noteWorker: [row.noteWorker, ...notes].filter(Boolean).join("; ") })
            .where(eq(dailyApplications.id, row.id));
        }
        await queueNotification({
          event: "WORKER_APPROVED",
          recipientType: "WORKER",
          recipientRef: row.cccd,
          templateKey: "worker_approved",
          payload: { fullName: normalizePersonName(row.fullName), deptId },
        });
      }
    }

    await writeAudit(guard.session, "BULK_IMPORT_" + finalStatus, "daily_applications", {
      updated: result.updated,
      skipped: result.results.filter((r) => !r.ok).length,
      departmentId: deptId,
    });

    return NextResponse.json({
      success: true,
      imported: result.updated,
      skipped: result.results.filter((r) => !r.ok).length,
      results: result.results,
    });
  } catch (error) {
    // Lưới cuối cấp DB (employment_session_one_active_uq) — race thật giữa 2 lô duyệt đồng thời.
    if ((error as { code?: string; constraint?: string }).code === "23505" &&
        (error as { constraint?: string }).constraint === "employment_session_one_active_uq") {
      return NextResponse.json(
        { error: "Có lao động trong lô đã được xếp việc ACTIVE ở thao tác khác cùng lúc — tải lại trang và duyệt lại.", code: "DUPLICATE_ACTIVE_EMPLOYMENT" },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: "Lỗi hệ thống: " + (error as Error).message },
      { status: 500 },
    );
  }
}
