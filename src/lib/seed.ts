import "server-only";
import { db } from "@/db";
import { departments, fieldDefinitions, formQuestions, scheduledJobs, userDepartmentScopes, users, workflowStages } from "@/db/schema";
import { hashPassword } from "@/lib/auth";
import { DEFAULT_FIELD_DEFINITIONS } from "@/lib/metadata";
import { DEFAULT_WORKFLOW_STAGES, DEFAULT_MOVEMENT_WORKFLOW_STAGES } from "@/lib/workflow";
import { DEFAULT_SCHEDULED_JOBS } from "@/lib/scheduler";
import { asc, eq, isNotNull, sql } from "drizzle-orm";

let seeded = false;

/** Bootstrap tài khoản + câu hỏi mặc định. Dữ liệu Department/DW Data nạp từ sheet. */
export async function ensureSeed() {
  if (seeded) return;
  try {
    const existing = await db.select({ id: users.id }).from(users).limit(1);
    if (existing.length === 0) {
      const [firstDept] = await db
        .select({ id: departments.id })
        .from(departments)
        .orderBy(asc(departments.deptName))
        .limit(1);

      await db
        .insert(users)
        .values([
          {
            username: "admin",
            passwordHash: hashPassword("admin123"),
            fullName: "Quản Trị Viên Hệ Thống",
            role: "ADMIN",
          },
          {
            username: "hr",
            passwordHash: hashPassword("hr123"),
            fullName: "Nhân Sự Tuyển Dụng",
            role: "HR_RECRUITER",
          },
          {
            username: "truongbophan",
            passwordHash: hashPassword("bophan123"),
            fullName: "Phụ Trách Lao Động Bộ Phận",
            role: "DEPT_MANAGER",
            deptId: firstDept?.id ?? null,
          },
        ])
        .onConflictDoNothing();
    }

    const q = await db.select({ id: formQuestions.id }).from(formQuestions).limit(1);
    if (q.length === 0) {
      await db
        .insert(formQuestions)
        .values([
          {
            fieldKey: "gioi_tinh",
            questionText: "Giới tính",
            fieldType: "SELECT",
            options: ["Nam", "Nữ"],
            isRequired: true,
            sortOrder: 1,
            aliases: ["Gender"],
            exportColumnName: "Giới tính",
          },
          {
            fieldKey: "dan_toc",
            questionText: "Dân tộc",
            fieldType: "SELECT",
            options: ["Kinh", "Cơ Ho", "Raglây", "Chăm", "Cill", "Tring", "Khác"],
            isRequired: true,
            sortOrder: 2,
            aliases: ["Ethnicity"],
            exportColumnName: "Dân tộc",
          },
          {
            fieldKey: "thoi_gian_dang_ky",
            questionText: "Anh/Chị đăng ký làm việc bao lâu?",
            fieldType: "SELECT",
            options: ["01 - 03 tháng", "03 - 06 tháng", "06 - 12 tháng", "Trên 12 tháng"],
            isRequired: true,
            sortOrder: 3,
            aliases: ["Thời gian đăng ký làm"],
            exportColumnName: "Thời gian đăng ký làm",
          },
          {
            fieldKey: "kenh_gioi_thieu",
            questionText: "Anh/chị biết thông tin tuyển dụng từ đâu?",
            fieldType: "SELECT",
            options: [
              "Người thân, bạn bè",
              "Mạng xã hội (Facebook, Zalo, Tiktok, Youtube...)",
              "Băng rôn tuyển dụng",
              "Trường Đại Học Nông Lâm",
              "Giáo viên",
              "Tự đi làm",
              "Khác",
            ],
            isRequired: true,
            sortOrder: 4,
            aliases: ["Kênh giới thiệu"],
            exportColumnName: "Kênh giới thiệu",
          },
          {
            fieldKey: "cam_ket",
            questionText: "Tôi cam kết những thông tin trên là đầy đủ, chính xác",
            fieldType: "BOOLEAN",
            isRequired: true,
            sortOrder: 10,
          },
        ])
        .onConflictDoNothing();
    }

    // Metadata Engine: nạp sẵn định nghĩa các trường lõi (Department/DW Data/
    // Daily Application) nếu bảng field_definitions đang trống, để import/export
    // hoạt động ngay cả khi admin chưa vào /admin/field-definitions chỉnh sửa gì.
    const fd = await db.select({ id: fieldDefinitions.id }).from(fieldDefinitions).limit(1);
    if (fd.length === 0) {
      await db
        .insert(fieldDefinitions)
        .values(
          DEFAULT_FIELD_DEFINITIONS.map((d, i) => ({
            fieldKey: d.fieldKey,
            groupName: d.groupName,
            displayName: d.displayName,
            databaseField: d.databaseField,
            importColumnName: d.importColumnName,
            exportColumnName: d.displayName,
            aliases: d.aliases ?? [],
            fieldType: d.fieldType ?? "TEXT",
            required: d.required ?? false,
            searchable: d.searchable ?? false,
            sortable: d.sortable ?? false,
            filterable: d.filterable ?? false,
            exportable: d.exportable ?? true,
            importable: d.importable ?? true,
            sortOrder: d.sortOrder ?? i,
            isSystem: true,
          })),
        )
        .onConflictDoNothing();
    }

    // WORKFLOW ENGINE (#5) — nạp sẵn 4 bước hiện có (PENDING/APPROVED/WAITLIST/REJECTED)
    // để giao diện KHÔNG đổi gì so với trước khi có bảng này.
    const wf = await db.select({ id: workflowStages.id }).from(workflowStages).limit(1);
    if (wf.length === 0) {
      await db
        .insert(workflowStages)
        .values(
          DEFAULT_WORKFLOW_STAGES.map((s) => ({
            entityType: "daily_application",
            stageKey: s.stageKey,
            label: s.label,
            color: s.color,
            sortOrder: s.sortOrder,
            isStart: s.isStart ?? false,
            isEnd: s.isEnd ?? false,
            allowedRoles: ["ADMIN", "HR_RECRUITER"],
          })),
        )
        .onConflictDoNothing();
    }

    // WORKFORCE MOVEMENT (Phase 2, Step 3) — nạp sẵn bước quy trình cho Nghỉ việc + Thuyên chuyển
    // (Workflow Engine dùng chung, không viết state machine riêng — mục 10 yêu cầu nghiệp vụ).
    const wfMovement = await db.select({ id: workflowStages.id }).from(workflowStages).where(sql`entity_type in ('resignation','transfer')`).limit(1);
    if (wfMovement.length === 0) {
      const movementRows = (Object.entries(DEFAULT_MOVEMENT_WORKFLOW_STAGES) as [string, (typeof DEFAULT_MOVEMENT_WORKFLOW_STAGES)["resignation"]][]).flatMap(
        ([entityType, stages]) =>
          stages.map((s) => ({
            entityType,
            stageKey: s.stageKey,
            label: s.label,
            color: s.color,
            sortOrder: s.sortOrder,
            isStart: s.isStart ?? false,
            isEnd: s.isEnd ?? false,
            allowedRoles: ["ADMIN", "HR_RECRUITER"],
          })),
      );
      await db.insert(workflowStages).values(movementRows).onConflictDoNothing();
    }

    // SCHEDULER FOUNDATION (#15) — đăng ký sẵn danh sách job (chưa tự chạy trừ khi có Vercel Cron/cron ngoài gọi /api/cron/run).
    // Luôn thử insert (onConflictDoNothing theo job_key) thay vì chỉ seed khi bảng rỗng —
    // để job MỚI thêm sau này (vd expire_planning_periods ở Phase 2 Step 4) vẫn tự xuất hiện
    // trên các hệ thống đã seed từ trước, không cần migration riêng.
    await db.insert(scheduledJobs).values(DEFAULT_SCHEDULED_JOBS).onConflictDoNothing();

    // NGÀY CÔNG CLEANUP (Phase 2, Step 7) — hệ thống KHÔNG phải chấm công. Job cũ
    // "recompute_dw_workdays" (nếu đã seed từ bản trước) không còn handler tương ứng —
    // tắt (không xoá, giữ lịch sử) để /admin/system không còn hiển thị job "NO_HANDLER".
    await db.update(scheduledJobs).set({ isActive: false }).where(eq(scheduledJobs.jobKey, "recompute_dw_workdays"));

    // RBAC — DATA SCOPE (Phase 2, Step 1): di trú 1 lần users.deptId (cột cũ, đơn) sang
    // user_department_scopes (nhiều-nhiều). An toàn chạy lại nhiều lần (ON CONFLICT DO NOTHING) —
    // không dùng cờ `seeded` để giới hạn 1 lần vì user mới có thể được gán deptId sau này.
    const usersWithDept = await db.select({ id: users.id, deptId: users.deptId }).from(users).where(isNotNull(users.deptId));
    if (usersWithDept.length > 0) {
      await db
        .insert(userDepartmentScopes)
        .values(usersWithDept.map((u) => ({ userId: u.id, departmentId: u.deptId as string })))
        .onConflictDoNothing();
    }

    seeded = true;
  } catch (error) {
    console.error("[seed] failed", error);
  }
}

export async function tablesReady(): Promise<boolean> {
  try {
    await db.execute(sql`select 1 from users limit 1`);
    return true;
  } catch {
    return false;
  }
}
