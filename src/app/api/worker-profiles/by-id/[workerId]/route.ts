/**
 * GET /api/worker-profiles/by-id/[workerId]
 *
 * Canonical 360° profile read endpoint — the SAME getWorker360Profile()
 * service the AI Copilot's get_worker_employment_history tool calls, so
 * both surfaces answer identically. Addressed by the OPAQUE worker_profiles.id
 * (never CCCD/phone) so the URL itself carries no PII and is safe to bookmark
 * or share between staff who both hold worker_profile.view.
 *
 * A separate route (not the legacy CCCD-based [cccd]/route.ts) so existing
 * CCCD-search callers keep working unmodified — this is purely additive.
 *
 * Data Scope: getWorker360Profile() already returns null for a worker with
 * zero in-scope engagements (never a global existence oracle) — this route
 * just maps that to 404, identical to the CCCD-based route's own contract.
 */
import { NextResponse } from "next/server";
import { requirePermission, getUserScope } from "@/lib/auth";
import { getWorker360Profile } from "@/lib/worker-360-profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_req: Request, ctx: { params: Promise<{ workerId: string }> }) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER", "HR_DIRECTOR"], "worker_profile.view");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const { workerId } = await ctx.params;
  if (!UUID_RE.test(workerId)) return NextResponse.json({ error: "Mã lao động không hợp lệ." }, { status: 400 });

  const scope = await getUserScope(guard.session);
  const profile = await getWorker360Profile(workerId, scope);
  if (!profile) return NextResponse.json({ error: "Không tìm thấy hồ sơ trong phạm vi dữ liệu được cấp." }, { status: 404 });

  return NextResponse.json({ profile });
}
