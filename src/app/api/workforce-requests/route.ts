import { NextResponse } from "next/server";
import { getUserScope, hasPermission, requirePermission } from "@/lib/auth";
import { listWorkforceRequests } from "@/lib/workforce-request";
import { todayStr } from "@/lib/helpers";
import type { RequestRow } from "@/lib/workforce-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * WORKFORCE REQUEST — danh sách + KPI Nam/Nữ (mục 10, 11).
 * asOf: today | expected | period | YYYY-MM-DD (mục 14).
 */
export async function GET(req: Request) {
  const guard = await requirePermission(
    ["ADMIN", "HR_RECRUITER", "DEPT_MANAGER", "HR_DIRECTOR"],
    "workforce_request.view",
  );
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const url = new URL(req.url);
  const statusParam = url.searchParams.get("status");
  const departmentId = url.searchParams.get("departmentId") ?? undefined;
  const search = url.searchParams.get("search") ?? undefined;
  const asOfParam = url.searchParams.get("asOf") ?? "today";
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 300) || 300, 1000);

  const scope = await getUserScope(guard.session);
  const asOf: string | ((r: RequestRow) => string) = resolveAsOf(asOfParam);

  const rows = await listWorkforceRequests({
    scope,
    status: statusParam && statusParam !== "ALL" ? statusParam : undefined,
    departmentId,
    search,
    asOf,
    limit,
  });

  const can = {
    allocate: await hasPermission(guard.session.role, "workforce_request.allocate"),
    overallocate: await hasPermission(guard.session.role, "planning.overallocate"),
    comment: await hasPermission(guard.session.role, "workforce_request.comment"),
  };

  return NextResponse.json({ rows, can, asOf: asOfParam });
}

/** Giải tham số asOf (mục 14): today | expected | period | ngày cụ thể YYYY-MM-DD. */
function resolveAsOf(asOfParam: string): string | ((r: RequestRow) => string) {
  if (!asOfParam || asOfParam === "today") return todayStr();
  if (/^\d{4}-\d{2}-\d{2}$/.test(asOfParam)) return asOfParam;
  if (asOfParam === "expected" || asOfParam === "period") {
    return (r: RequestRow) => r.expectedDate ?? todayStr();
  }
  return todayStr();
}
