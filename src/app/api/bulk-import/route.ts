import { NextResponse } from "next/server";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { dailyApplications, dwData, employmentSessions, workerProfiles } from "@/db/schema";
import { requireRoleAndPermission, writeAudit } from "@/lib/auth";
import { todayStr } from "@/lib/helpers";
import { normalizePersonName } from "@/lib/person-name";
import { runRules } from "@/lib/rule-engine";
import { queueNotification } from "@/lib/notifications";
import { autoAllocateInternship } from "@/lib/planning";
import { isValidCccd, normalizeCccd } from "@/lib/validators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const MAX_BULK = 500;

type RowResult = { id: string; cccd: string | null; fullName: string | null; ok: boolean; reason: string };

/** Duyệt hàng loạt & Import người mới vào sheet "DW Data". */
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

    const result = await db.transaction(async (tx) => {
      // BƯỚC 0/4 — Duyệt hồ sơ (#1 yêu cầu nghiệp vụ): phân loại RÕ RÀNG từng ID thay vì âm thầm
      // loại bỏ những dòng không đủ điều kiện — để khi có 0 thay đổi, người dùng biết CHÍNH XÁC vì sao.
      const allTargets = await tx.select().from(dailyApplications).where(inArray(dailyApplications.id, ids));
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

      const targets = allTargets.filter((target) => target.status !== finalStatus && !invalidIdentityIds.has(target.id));
      if (targets.length === 0) {
        return { updated: 0, newImported: 0, results, processedIds: [] as string[] };
      }

      let newImported = 0;
      const dwInsertedCccd = new Set<string>();

      if (finalStatus === "APPROVED") {
        // Chỉ tạo hồ sơ DW mới cho người CHƯA có trong DW Data
        const freshOnes = targets.filter((t) => t.dwMatch === "NEW");
        if (freshOnes.length > 0) {
          const inserted = await tx
            .insert(dwData)
            .values(
              freshOnes.map((t) => ({
                fullName: normalizePersonName(t.fullName),
                // IT CODE / Mã vân tay (#18) — chuyển IT CODE đã nhập ở Daily Application sang DW Data.
                itCode: t.itCode ?? null,
                gender: t.gender,
                bod: t.dob,
                cccd: t.cccd,
                phone: t.phone,
                permanentAddress: t.permanentAddress,
                residentialAddress: t.residentialAddress,
                source: "Đăng ký thời vụ (Portal)",
                profile: "Tự đăng ký online",
              })),
            )
            .onConflictDoUpdate({
              target: dwData.cccd,
              targetWhere: sql`deleted_at is null`,
              set: {
                fullName: sql`excluded.full_name`,
                itCode: sql`coalesce(excluded.it_code, ${dwData.itCode})`,
                phone: sql`coalesce(excluded.phone, ${dwData.phone})`,
                residentialAddress: sql`coalesce(excluded.residential_address, ${dwData.residentialAddress})`,
              },
            })
            .returning({ id: dwData.id, cccd: dwData.cccd });
          newImported = inserted.length;

          // Gắn liên kết DW cho các đơn vừa import + cập nhật worker_profiles.dw_id
          // để các lần sửa IT CODE sau này đồng bộ đúng sang dw_data.it_code.
          for (const ins of inserted) {
            if (!ins.cccd) continue;
            dwInsertedCccd.add(ins.cccd);
            await tx
              .update(dailyApplications)
              .set({ dwId: ins.id, dwMatch: "MATCHED" })
              .where(eq(dailyApplications.cccd, ins.cccd));
            await tx
              .update(workerProfiles)
              .set({ dwId: ins.id })
              .where(and(eq(workerProfiles.cccd, ins.cccd), isNull(workerProfiles.deletedAt)));
          }
        }
      }

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
          ...(finalStatus === "APPROVED" ? { startingDate: today } : {}),
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
            ? dwInsertedCccd.has(t.cccd)
              ? "Đã duyệt và thêm mới vào DW Data"
              : "Đã duyệt"
            : finalStatus === "REJECTED"
              ? "Đã từ chối"
              : "Đã chuyển vào danh sách dự phòng (Waitlist)";
        results.push({ id: t.id, cccd: t.cccd, fullName: normalizePersonName(t.fullName), ok: true, reason });
      }

      return { updated: updated.length, newImported, results, processedIds: targets.map((t) => t.id) };
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
      for (const row of approvedRows) {
        const actions = await runRules("daily_application", "ON_APPROVE", {
          age: row.age,
          gender: row.gender,
          ethnicity: row.ethnicity,
          dwMatch: row.dwMatch,
          declaredType: row.declaredType,
        });
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

    await writeAudit(guard.session, "BULK_IMPORT_" + finalStatus, "dw_data", {
      updated: result.updated,
      newImported: result.newImported,
      skipped: result.results.filter((r) => !r.ok).length,
      departmentId: deptId,
    });

    return NextResponse.json({
      success: true,
      imported: result.updated,
      newToDw: result.newImported,
      skipped: result.results.filter((r) => !r.ok).length,
      results: result.results,
    });
  } catch (error) {
    return NextResponse.json(
      { error: "Lỗi hệ thống: " + (error as Error).message },
      { status: 500 },
    );
  }
}
