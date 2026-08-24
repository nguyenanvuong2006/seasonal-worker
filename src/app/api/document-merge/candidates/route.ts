/**
 * GET /api/document-merge/candidates?q=...
 *
 * Candidate lookup for the DRAFT VERSION PREVIEW dialog (Trộn tài liệu → Sửa
 * Template → Phiên bản Template → Xem trước). Read-only: SELECT only, no
 * writes, no job creation, no external calls.
 *
 * SECURITY — mirrors the rules already enforced by GET /api/registrations and
 * /api/global-search; it invents no new authorisation logic:
 *   - authenticated session + ADMIN role + document_merge.templates.manage
 *     (same gate as the preview endpoint it feeds);
 *   - Data Scope (getUserScope) restricts which departments' candidates are
 *     visible; an empty scope returns nothing;
 *   - CCCD / phone are masked unless the caller holds privacy.view_cccd /
 *     privacy.view_phone.
 */

import { NextResponse } from "next/server";
import { and, desc, eq, ilike, inArray, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { dailyApplications, departments } from "@/db/schema";
import { getUserScope, hasPermission, requirePermission } from "@/lib/auth";
import { normalizePersonName } from "@/lib/person-name";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIN_QUERY_LENGTH = 2;
const RESULT_LIMIT = 20;

const mask = (value: string | null, visible: boolean) =>
  visible ? (value ?? "") : value ? "•••• (ẩn theo quyền)" : "";

export async function GET(request: Request) {
  const guard = await requirePermission(["ADMIN"], "document_merge.templates.manage");
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  const q = (new URL(request.url).searchParams.get("q") ?? "").trim();
  if (q.length < MIN_QUERY_LENGTH) {
    return NextResponse.json({ rows: [] });
  }

  const scope = await getUserScope(guard.session);
  if (scope !== null && scope.length === 0) {
    return NextResponse.json({ rows: [] });
  }

  const pattern = `%${q.replace(/[%_\\]/g, (m) => "\\" + m)}%`;
  const filters = [
    isNull(dailyApplications.deletedAt),
    or(
      ilike(dailyApplications.fullName, pattern),
      ilike(dailyApplications.cccd, pattern),
      ilike(dailyApplications.phone, pattern),
    ),
  ];
  if (scope !== null) filters.push(inArray(dailyApplications.deptId, scope));

  const rows = await db
    .select({
      id: dailyApplications.id,
      fullName: dailyApplications.fullName,
      cccd: dailyApplications.cccd,
      phone: dailyApplications.phone,
      regDate: dailyApplications.regDate,
      status: dailyApplications.status,
      deptName: departments.deptName,
    })
    .from(dailyApplications)
    .leftJoin(departments, eq(dailyApplications.deptId, departments.id))
    .where(and(...filters))
    .orderBy(desc(dailyApplications.regDate))
    .limit(RESULT_LIMIT);

  const canViewCccd = await hasPermission(guard.session.role, "privacy.view_cccd");
  const canViewPhone = await hasPermission(guard.session.role, "privacy.view_phone");

  return NextResponse.json({
    rows: rows.map((row) => ({
      id: row.id,
      fullName: normalizePersonName(row.fullName),
      cccd: mask(row.cccd, canViewCccd),
      phone: mask(row.phone, canViewPhone),
      regDate: row.regDate,
      status: row.status,
      deptName: row.deptName,
    })),
  });
}
