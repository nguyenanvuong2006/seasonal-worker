/**
 * PATCH /api/worker-profiles/by-id/[workerId]/fingerprint
 *
 * Biometric (#16) update — moved from the legacy CCCD-keyed PATCH
 * /api/worker-profiles/[cccd] onto the canonical opaque-workerId surface,
 * same ADMIN-only + Data-Scope-authorized contract (never a bypass: the
 * caller must be authorized to view this exact worker's profile at all
 * before an edit is permitted, reusing getWorker360Profile()'s own scoped
 * visibility check rather than inventing a second one).
 *
 * This is the ONE pre-existing write action carried over — no NEW write
 * capability was added to the 360° profile (see mission's "do not turn
 * profile into a write center").
 *
 * MISSION F2 section 11/250 — the IT Code identity change now routes through
 * updateWorkerBiometric() (src/lib/it-code-assignment.ts), which reuses the
 * canonical assignItCode()/releaseItCode() service when the worker has an
 * active engagement — never a direct fingerprint_code overwrite that could
 * silently steal another worker's still-active IT Code or desync the other
 * two mirrors (dw_data.it_code, daily_applications.it_code).
 */
import { NextResponse } from "next/server";
import { requirePermission, getUserScope, writeAudit } from "@/lib/auth";
import { getWorker360Profile } from "@/lib/worker-360-profile";
import { updateWorkerBiometric } from "@/lib/it-code-assignment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(req: Request, ctx: { params: Promise<{ workerId: string }> }) {
  const guard = await requirePermission(["ADMIN"], "worker_profile.edit");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const { workerId } = await ctx.params;
  if (!UUID_RE.test(workerId)) return NextResponse.json({ error: "Mã lao động không hợp lệ." }, { status: 400 });

  const scope = await getUserScope(guard.session);
  const authorized = await getWorker360Profile(workerId, scope);
  if (!authorized) return NextResponse.json({ error: "Không tìm thấy hồ sơ trong phạm vi dữ liệu được cấp." }, { status: 404 });

  const body = (await req.json()) as { fingerprintCode?: string; fingerprintDevice?: string; fingerprintStatus?: string };
  const result = await updateWorkerBiometric({
    workerId,
    fingerprintCode: body.fingerprintCode ?? null,
    fingerprintDevice: body.fingerprintDevice ?? null,
    fingerprintStatus: body.fingerprintStatus ?? null,
    updatedBy: guard.session.username,
  });
  if (!result.ok) {
    if (result.error === "WORKER_NOT_FOUND") return NextResponse.json({ error: "Không tìm thấy hồ sơ." }, { status: 404 });
    const reason = result.error === "IT_CODE_ALREADY_ACTIVE" ? "IT Code này đang được gán cho người khác." : "Worker đã có IT Code đang hoạt động (xung đột).";
    return NextResponse.json({ error: reason }, { status: 409 });
  }
  await writeAudit(guard.session, "UPDATE_FINGERPRINT", "worker_profiles", { workerId, itCodeRoute: result.itCodeRoute });
  return NextResponse.json({ success: true });
}
