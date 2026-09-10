import "server-only";
import { getUserScope } from "@/lib/auth";
import { todayStr } from "@/lib/helpers";
import { getWorker360Profile, type Worker360Profile } from "@/lib/worker-360-profile";
import type { ToolContext, ToolDefinition, ToolResult } from "../types.ts";
import { ToolExecutionError } from "../types.ts";

/**
 * Worker 360° Profile mission (2026-09-10), Section 21: a SINGLE tool that
 * answers every "employment history" question about one person (lịch sử làm
 * việc, số lần vào làm, lần gần nhất, đã xác nhận chưa, đã nghỉ/chuyển chưa)
 * by calling the EXACT SAME canonical service the admin profile page itself
 * calls (getWorker360Profile) — never a second, independently-reasoned
 * definition of a worker's history. RBAC (worker_profile.view, enforced by
 * every route this tool's caller reached to get here) and Data Scope are
 * re-derived from ctx.session on EVERY call, exactly like every other tool
 * in this registry — a model-supplied workerId alone never bypasses scope:
 * getWorker360Profile() itself returns null for a worker with zero in-scope
 * engagements (its own "never a global existence oracle" contract), which
 * this tool surfaces as the SAME NOT_FOUND a scoped human caller would see
 * on the profile page — never a distinguishable "exists but forbidden".
 *
 * PII: the returned Worker360Profile already excludes CCCD/phone/DOB/address
 * by construction (see worker-360-profile.ts's own person/engagement DTOs) —
 * this tool adds no extra fields and performs no extra query, so there is
 * nothing here for privacy-audit.test.ts's raw-column scan to catch.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const get_worker_employment_history: ToolDefinition<{ workerId: string }, Worker360Profile> = {
  name: "get_worker_employment_history",
  description:
    'Lấy TOÀN BỘ hồ sơ 360° (lịch sử làm việc) của MỘT lao động theo workerId (định danh vận hành — dùng find_current_workers hoặc công cụ tra cứu lao động khác để lấy workerId trước, KHÔNG dùng CCCD). Trả về trạng thái hiện tại (đang làm việc/không hoạt động, bộ phận hiện tại), và TỪNG lần bắt đầu công việc (engagement) độc lập — mới nhất trước — kèm bộ phận, ngày bắt đầu/kết thúc, sự kiện Nghỉ việc/Thuyên chuyển thuộc đúng lần đó, và hồ sơ Xác nhận điện tử thuộc đúng lần đó (đã xác nhận/còn hạn/hết hạn). Một người quay lại làm việc nhiều lần có NHIỀU engagement độc lập — KHÔNG BAO GIỜ suy luận rằng đã xác nhận ở lần trước thì lần này không cần hồ sơ mới. Không trả CCCD/SĐT/địa chỉ/ngày sinh.',
  parameters: {
    type: "object",
    properties: { workerId: { type: "string", description: "UUID của lao động (workerId) cần tra lịch sử — không phải CCCD." } },
    required: ["workerId"],
    additionalProperties: false,
  },
  parseArgs: (raw) => {
    const body = (raw ?? {}) as Record<string, unknown>;
    const workerId = typeof body.workerId === "string" ? body.workerId.trim() : "";
    if (!workerId || !UUID_RE.test(workerId)) {
      throw new ToolExecutionError("INVALID_ARGS", "Cần cung cấp workerId hợp lệ (UUID) — không dùng CCCD.");
    }
    return { workerId };
  },
  execute: async (ctx: ToolContext, args): Promise<ToolResult<Worker360Profile>> => {
    const scope = await getUserScope(ctx.session);
    const profile = await getWorker360Profile(args.workerId, scope);
    if (!profile) throw new ToolExecutionError("NOT_FOUND", "Không tìm thấy hồ sơ trong phạm vi dữ liệu được cấp.");
    return { data: profile, source: { domains: ["workforce", "employment", "document_confirmation", "workforce_movements"], asOf: todayStr() } };
  },
};

export const worker360ProfileTools = [get_worker_employment_history];
