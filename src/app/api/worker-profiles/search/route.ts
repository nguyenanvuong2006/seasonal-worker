/**
 * GET /api/worker-profiles/search?q=...
 *
 * Name/CCCD/phone search for "Hồ sơ Tập nghề" — mirrors the EXACT same
 * scoping/masking rules global-search's own worker_profile.view branch
 * already established (Data Scope via an EXISTS-on-employment_sessions
 * subquery, CCCD/phone masked unless privacy.view_cccd/privacy.view_phone)
 * — never a second, looser search rule. Kept as its own endpoint (gated
 * only by worker_profile.view) rather than reusing global_search.use
 * directly, since a role can legitimately hold worker_profile.view without
 * also holding the separate global-search permission.
 *
 * Results carry the OPAQUE workerId only — never a link containing CCCD.
 */
import { NextResponse } from "next/server";
import { and, ilike, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { employmentSessions, workerProfiles } from "@/db/schema";
import { requirePermission, getUserScope, hasPermission } from "@/lib/auth";
import { normalizePersonName } from "@/lib/person-name";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIN_QUERY_LENGTH = 2;
const MAX_RESULTS = 20;

const mask = (v: string | null, visible: boolean) => (visible ? (v ?? "") : v ? "•••• (ẩn theo quyền)" : "");

export async function GET(req: Request) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER", "HR_DIRECTOR"], "worker_profile.view");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const q = (new URL(req.url).searchParams.get("q") ?? "").trim();
  if (q.length < MIN_QUERY_LENGTH) return NextResponse.json({ results: [] });

  const scope = await getUserScope(guard.session);
  if (scope !== null && scope.length === 0) return NextResponse.json({ results: [] });

  const canViewCccd = await hasPermission(guard.session.role, "privacy.view_cccd");
  const canViewPhone = await hasPermission(guard.session.role, "privacy.view_phone");

  const pattern = `%${q.replace(/[%_]/g, (m) => "\\" + m)}%`;
  const filters = [isNull(workerProfiles.deletedAt), or(ilike(workerProfiles.fullName, pattern), ilike(workerProfiles.cccd, pattern), ilike(workerProfiles.phone, pattern))];
  if (scope !== null) {
    filters.push(sql`exists (
      select 1 from ${employmentSessions} es
      where es.worker_id = ${workerProfiles.id} and es.dept_id = any(${scope}::uuid[])
    )`);
  }

  const rows = await db
    .select({ id: workerProfiles.id, cccd: workerProfiles.cccd, fullName: workerProfiles.fullName, phone: workerProfiles.phone })
    .from(workerProfiles)
    .where(and(...filters))
    .limit(MAX_RESULTS);

  return NextResponse.json({
    results: rows.map((r) => ({
      workerId: r.id,
      fullName: normalizePersonName(r.fullName),
      cccdMasked: mask(r.cccd, canViewCccd),
      phoneMasked: r.phone ? mask(r.phone, canViewPhone) : null,
    })),
  });
}
