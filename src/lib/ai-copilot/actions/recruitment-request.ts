import "server-only";
import { randomBytes } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { departments, recruitmentRequests } from "@/db/schema";
import { getUserScope } from "@/lib/auth";
import { scopeAllowsDepartment } from "@/lib/data-scope";
import { formatDate, todayStr } from "@/lib/helpers";
import { computeDateDeltas, computeTotalRequest } from "@/lib/planning-recruitment-core";
import { provisionRecruitmentRequest } from "@/lib/recruitment-request-provisioning";
import type { ActionContext, ActionDefinition, ActionValidationResult } from "../action-types.ts";

/**
 * ACTION: prepare_recruitment_request (Phase 3 "Safe Action Copilot").
 *
 * Also covers "Chuẩn bị Workforce Request" — the domain audit (Phase 1)
 * confirmed Workforce Request is the KPI-augmented VIEW of this exact
 * recruitment_requests row, not a separate write path, so there is
 * deliberately no separate prepare_workforce_request action (that would
 * duplicate this one under a different name).
 *
 * validate() is READ-ONLY: it resolves a department name/id and checks
 * Data Scope/business preconditions, never writes. execute() reuses the
 * SAME domain functions the real POST /api/recruitment-requests route
 * uses (computeTotalRequest, computeDateDeltas, provisionRecruitmentRequest,
 * an insert into recruitmentRequests inside one transaction) — never a
 * reimplementation of that business logic.
 *
 * prepare_worker_transfer is deliberately NOT implemented in this phase —
 * workforce_movements' state machine (workflow_stages, spawn-resignation,
 * multi-actor confirmation) was not audited deeply enough this phase to
 * call it a "mature, authorization-clear" candidate per the mission's own
 * conditional.
 */

export type PrepareRecruitmentRequestArgs = {
  departmentId?: string;
  departmentName?: string;
  maleRq: number;
  femaleRq: number;
  expectedDate: string;
  reason?: string;
  position?: string;
};

export type RecruitmentRequestPayload = {
  departmentId: string;
  departmentName: string;
  maleRq: number;
  femaleRq: number;
  totalRequest: number;
  expectedDate: string;
  reason: string | null;
  position: string | null;
};

async function resolveDepartment(args: PrepareRecruitmentRequestArgs, scope: string[] | null): Promise<{ id: string; name: string } | null> {
  if (args.departmentId) {
    const [row] = await db.select({ id: departments.id, name: departments.deptName }).from(departments).where(and(eq(departments.id, args.departmentId), eq(departments.isActive, true), isNull(departments.deletedAt))).limit(1);
    return row ?? null;
  }
  if (args.departmentName?.trim()) {
    const rows = await db
      .select({ id: departments.id, name: departments.deptName })
      .from(departments)
      .where(and(sql`${departments.deptName} ILIKE ${args.departmentName.trim()}`, eq(departments.isActive, true), isNull(departments.deletedAt)))
      .limit(5);
    // Ambiguous or out-of-scope matches are rejected rather than silently
    // picking one — a name resolution must never widen what the model
    // could otherwise only reach via an explicit, in-scope departmentId.
    const inScope = rows.filter((r) => scopeAllowsDepartment(scope, r.id));
    return inScope.length === 1 ? inScope[0] : null;
  }
  return null;
}

function generateRequestCode(): string {
  return `AI-${todayStr().replace(/-/g, "")}-${randomBytes(3).toString("hex").toUpperCase()}`;
}

const prepare_recruitment_request: ActionDefinition<PrepareRecruitmentRequestArgs, RecruitmentRequestPayload> = {
  name: "prepare_recruitment_request",
  description:
    "Chuẩn bị (KHÔNG tạo ngay) một Yêu cầu tuyển dụng mới (cũng chính là Workforce Request — cùng một bản ghi). Cần departmentId HOẶC departmentName (tên phải khớp duy nhất 1 bộ phận trong phạm vi Data Scope), maleRq + femaleRq (PHẢI hỏi lại người dùng nếu họ chỉ nêu tổng số mà không nêu rõ Nam/Nữ), và expectedDate (Ngày cần nhân lực, YYYY-MM-DD). Đây chỉ tạo ĐỀ XUẤT chờ xác nhận — không ghi dữ liệu.",
  parameters: {
    type: "object",
    properties: {
      departmentId: { type: "string", description: "UUID bộ phận (ưu tiên nếu đã biết từ tool tra cứu trước đó)." },
      departmentName: { type: "string", description: "Tên bộ phận (dùng khi chưa có departmentId) — phải khớp duy nhất 1 bộ phận trong phạm vi Data Scope." },
      maleRq: { type: "number", description: "Số lượng Nam cần tuyển. Bắt buộc — hỏi lại người dùng nếu không rõ." },
      femaleRq: { type: "number", description: "Số lượng Nữ cần tuyển. Bắt buộc — hỏi lại người dùng nếu không rõ." },
      expectedDate: { type: "string", description: "Ngày cần nhân lực, YYYY-MM-DD." },
      reason: { type: "string", description: "Lý do tuyển dụng (tuỳ chọn)." },
      position: { type: "string", description: "Vị trí/vai trò cần tuyển (tuỳ chọn)." },
    },
    required: ["maleRq", "femaleRq", "expectedDate"],
    additionalProperties: false,
  },
  requiredPermission: "planning.request",
  parseArgs: (raw) => {
    const body = (raw ?? {}) as Record<string, unknown>;
    const maleRq = typeof body.maleRq === "number" ? body.maleRq : NaN;
    const femaleRq = typeof body.femaleRq === "number" ? body.femaleRq : NaN;
    if (!Number.isFinite(maleRq) || !Number.isFinite(femaleRq) || maleRq < 0 || femaleRq < 0) {
      throw new Error("maleRq và femaleRq phải là số không âm.");
    }
    if (maleRq + femaleRq <= 0) throw new Error("Tổng số lượng cần tuyển phải lớn hơn 0.");
    if (typeof body.expectedDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.expectedDate)) {
      throw new Error("expectedDate phải có định dạng YYYY-MM-DD.");
    }
    return {
      departmentId: typeof body.departmentId === "string" ? body.departmentId.trim() : undefined,
      departmentName: typeof body.departmentName === "string" ? body.departmentName.trim() : undefined,
      maleRq: Math.floor(maleRq),
      femaleRq: Math.floor(femaleRq),
      expectedDate: body.expectedDate,
      reason: typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : undefined,
      position: typeof body.position === "string" ? body.position.trim().slice(0, 160) : undefined,
    };
  },
  validate: async (ctx: ActionContext, args): Promise<ActionValidationResult<RecruitmentRequestPayload>> => {
    if (!args.departmentId && !args.departmentName) return { ok: false, error: "Cần departmentId hoặc departmentName." };
    if (args.expectedDate < todayStr()) return { ok: false, error: "Ngày cần nhân lực không được ở quá khứ." };
    const scope = await getUserScope(ctx.session);
    const department = await resolveDepartment(args, scope);
    if (!department) return { ok: false, error: "Không xác định được đúng 1 bộ phận trong phạm vi Data Scope khớp với thông tin đã cho." };
    if (!scopeAllowsDepartment(scope, department.id)) return { ok: false, error: "Bộ phận này nằm ngoài Data Scope của bạn." };
    const payload: RecruitmentRequestPayload = {
      departmentId: department.id,
      departmentName: department.name,
      maleRq: args.maleRq,
      femaleRq: args.femaleRq,
      totalRequest: computeTotalRequest(args.maleRq, args.femaleRq),
      expectedDate: args.expectedDate,
      reason: args.reason ?? null,
      position: args.position ?? null,
    };
    return { ok: true, payload, departmentId: department.id };
  },
  buildPreview: (payload) => {
    const lines = [
      "ĐỀ XUẤT HÀNH ĐỘNG",
      "",
      "Tạo Yêu cầu tuyển dụng (Recruitment Request / Workforce Request)",
      "",
      `Bộ phận: ${payload.departmentName}`,
      `Nam: ${payload.maleRq}`,
      `Nữ: ${payload.femaleRq}`,
      `Tổng số lượng: ${payload.totalRequest}`,
      `Ngày cần nhân lực: ${formatDate(payload.expectedDate)}`,
    ];
    if (payload.position) lines.push(`Vị trí: ${payload.position}`);
    if (payload.reason) lines.push(`Lý do: ${payload.reason}`);
    return lines.join("\n");
  },
  execute: async (ctx: ActionContext, payload) => {
    const requestedDate = todayStr();
    for (let attempt = 0; attempt < 5; attempt++) {
      const requestCode = generateRequestCode();
      const existing = await db.select({ id: recruitmentRequests.id }).from(recruitmentRequests).where(and(eq(recruitmentRequests.requestCode, requestCode), isNull(recruitmentRequests.deletedAt))).limit(1);
      if (existing.length > 0) continue; // astronomically rare — regenerate and retry.
      try {
        const requestId = await db.transaction(async (tx) => {
          const [inserted] = await tx
            .insert(recruitmentRequests)
            .values({
              requestCode,
              requester: ctx.session.username,
              position: payload.position,
              location: null,
              section: null,
              groupName: null,
              division: null,
              department: payload.departmentName,
              reason: payload.reason,
              maleRq: payload.maleRq,
              femaleRq: payload.femaleRq,
              maleBalance: payload.maleRq,
              femaleBalance: payload.femaleRq,
              totalBalance: payload.totalRequest,
              status: "PENDING",
              requestedDate,
              expectedDate: payload.expectedDate,
              ...computeDateDeltas({ requestedDate, offeredDate: null, completedDate: null }),
              departmentId: payload.departmentId,
              totalRequest: payload.totalRequest,
              recruitedVsExpected: 0,
              departmentText: payload.departmentName,
              createdBy: ctx.session.username,
            })
            .returning({ id: recruitmentRequests.id });
          await provisionRecruitmentRequest(tx, {
            requestId: inserted.id,
            departmentId: payload.departmentId,
            maleRq: payload.maleRq,
            femaleRq: payload.femaleRq,
            location: null,
            division: null,
            section: null,
            groupName: null,
            startingDate: null,
            expectedDate: payload.expectedDate,
            requestedDate,
            endDate: null,
            status: "PENDING",
            actor: ctx.session.username,
          });
          return inserted.id;
        });
        return { ok: true, resultRef: { requestId, requestCode } };
      } catch (error) {
        console.error("[ai-copilot] prepare_recruitment_request execute failed", error);
        return { ok: false, code: "INTERNAL", message: "Không thể tạo Yêu cầu tuyển dụng. Không có dữ liệu nào bị thay đổi." };
      }
    }
    return { ok: false, code: "CONFLICT", message: "Không thể tạo mã yêu cầu duy nhất — vui lòng thử lại." };
  },
};

export const recruitmentRequestActions = [prepare_recruitment_request];
