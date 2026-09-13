import { NextResponse } from "next/server";
import { requirePermission, getUserScope, hasPermission, writeAudit } from "@/lib/auth";
import { scopeAllowsDepartment } from "@/lib/data-scope";
import { formatDate } from "@/lib/helpers";
import { normalizePersonName } from "@/lib/person-name";
import {
  getFingerprintItCodeRows,
  type FingerprintItCodeRow,
  type FingerprintClassificationFilter,
  type ItCodeStatusFilter,
} from "@/lib/fingerprint-it-code-list";
import { maskCccd } from "@/lib/daily-intake-workflow";
import { buildDailyOperationsWorkbook, exportFilenameHeaders } from "@/lib/daily-operations-export";
import { CLASSIFICATION_LABELS } from "@/lib/fingerprint-classification";
import { formatDateRangeLabel, parseOperationalDateRange, rangeFilenameSuffix } from "@/lib/date-range";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * FINGERPRINT_STAFF — "Xuất danh sách IT Code / Vân tay" (mục VIII). Server
 * enforce điều kiện (DW imported AND Mã số công nhật not null) — KHÔNG
 * export toàn bộ Daily Application rồi để người dùng tự lọc. Nhận CÙNG bộ
 * filter (from/to/deptId/q/classification/itCodeStatus) với GET
 * /api/fingerprint/it-code qua getFingerprintItCodeRows dùng chung, để file
 * xuất LUÔN khớp danh sách đang hiển thị trên màn hình. Audit mỗi lần export.
 */
export async function GET(req: Request) {
  const guard = await requirePermission(["ADMIN", "FINGERPRINT_STAFF"], "fingerprint.view");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const url = new URL(req.url);
  const rangeResult = parseOperationalDateRange(url.searchParams);
  if (!rangeResult.ok) return NextResponse.json({ error: rangeResult.error.code, message: rangeResult.error.message }, { status: 400 });
  const { range } = rangeResult;
  const deptId = url.searchParams.get("deptId") || null;
  const q = url.searchParams.get("q") || null;
  const classification = (url.searchParams.get("classification") as FingerprintClassificationFilter | null) || "ALL";
  const itCodeStatus = (url.searchParams.get("itCodeStatus") as ItCodeStatusFilter | null) || "ALL";
  const scope = await getUserScope(guard.session);
  if (deptId && !scopeAllowsDepartment(scope, deptId)) {
    return NextResponse.json({ error: "Ngoài phạm vi dữ liệu được cấp." }, { status: 403 });
  }
  const canViewCccd = await hasPermission(guard.session.role, "privacy.view_cccd");

  const rows = await getFingerprintItCodeRows(range, scope, { deptId, q, classification, itCodeStatus });

  const buffer = await buildDailyOperationsWorkbook<FingerprintItCodeRow>({
    sheetName: "IT Code - Vân tay",
    title: `Danh sách IT Code / Vân tay — ${formatDateRangeLabel(range, formatDate)}`,
    columns: [
      { header: "STT", width: 6, value: (_r, i) => i + 1 },
      { header: "Mã công nhật", width: 18, value: (r) => r.code ?? "" },
      { header: "Họ và tên", width: 28, value: (r) => normalizePersonName(r.fullName) },
      { header: "CCCD", width: 16, value: (r) => maskCccd(r.cccd, canViewCccd) ?? r.cccd },
      { header: "Bộ phận", width: 26, value: (r) => [r.deptName, r.groupName].filter(Boolean).join(" — ") },
      { header: "Phân loại", width: 22, value: (r) => (r.classification ? CLASSIFICATION_LABELS[r.classification] : "") },
      { header: "IT CODE", width: 18, value: (r) => r.itCode ?? "" },
    ],
    rows,
  });

  await writeAudit(guard.session, "EXPORT_IT_CODE_LIST", "dw_data", {
    from: range.from,
    to: range.to,
    deptId,
    q,
    classification,
    itCodeStatus,
    rows: rows.length,
    departmentScope: scope,
  }, "EXPORT");

  return new NextResponse(new Uint8Array(buffer), { headers: exportFilenameHeaders("it-code-van-tay", rangeFilenameSuffix(range)) });
}
