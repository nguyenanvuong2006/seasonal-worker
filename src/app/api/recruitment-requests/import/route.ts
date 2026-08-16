import { NextResponse } from "next/server";
import { requirePermission, writeAudit } from "@/lib/auth";
import { getUserScope } from "@/lib/auth";
import {
  importRecruitmentRequests,
  mapRowToCanonical,
  validateRow,
  resolveHeaderAlias,
  normalizeHeaderName,
  matchHierarchy,
} from "@/lib/recruitment-request";
import { parseImportFile } from "@/lib/file-parser";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/recruitment-requests/import
 * Import yêu cầu tuyển dụng từ:
 *   - body.rawData: mảng dòng dữ liệu (từ paste TSV đã parse ở client)
 *   - body.fileData: base64 file upload (CSV/XLSX)
 *   - body.options: { skipDuplicates, updateDuplicates }
 */
export async function POST(req: Request) {
  // QUYỀN IMPORT TÁCH RIÊNG (Yêu cầu #11): chỉ ADMIN / HR_RECRUITER có
  // `planning.import` mới được dán hoặc tải kế hoạch lên.
  // DEPT_MANAGER bị loại ở CẢ hai lớp: không nằm trong danh sách vai trò, và
  // `planning.import` = allowed:false ở cấp DB.
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "planning.import");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const body = (await req.json()) as {
    rawData?: Record<string, string>[];
    fileData?: string; // base64
    fileName?: string;
    action?: "preview" | "import";
    options?: { skipDuplicates?: boolean; updateDuplicates?: boolean };
  };

  const action = body.action ?? "preview";

  let parsedRows: Record<string, string>[] = [];

  if (body.rawData && body.rawData.length > 0) {
    parsedRows = body.rawData;
  } else if (body.fileData && body.fileName) {
    const buf = Buffer.from(body.fileData, "base64");
    parsedRows = await parseImportFile(buf, body.fileName);
  }

  if (parsedRows.length === 0) {
    return NextResponse.json({ error: "Không có dữ liệu để import. Vui lòng paste dữ liệu hoặc upload file." }, { status: 400 });
  }

  if (parsedRows.length > 5000) {
    return NextResponse.json({ error: "Tối đa 5.000 dòng mỗi lần import." }, { status: 400 });
  }

  // Map headers to canonical names and validate
  const preview: {
    rowIndex: number;
    requestCode: string;
    mapped: Record<string, string>;
    unknownHeaders: string[];
    valid: boolean;
    errors: { field: string; message: string }[];
    warnings: { field: string; message: string }[];
  }[] = [];

  // First row headers detection
  const headerMap: Record<string, string> = {};
  const firstRow = parsedRows[0];
  for (const header of Object.keys(firstRow)) {
    const resolved = resolveHeaderAlias(header);
    headerMap[header] = resolved || header;
  }

  const unknownHeadersAll = new Set<string>();
  let hasHeaderRow = false;

  // Detect if first row is header
  const allHeaders = Object.keys(firstRow);
  const resolvedCount = allHeaders.filter((h) => resolveHeaderAlias(h)).length;
  hasHeaderRow = resolvedCount >= 4; // At least 4 header aliases recognized = header row

  let dataRows = parsedRows;
  if (hasHeaderRow) {
    // Skip header row for validation/import but keep its column names
    dataRows = parsedRows.slice(1);
  }

  const usedHeaders = hasHeaderRow ? allHeaders : Object.keys(dataRows[0] ?? {});
  // Map used headers to canonical
  const usedHeaderMap: Record<string, string> = {};
  for (const h of usedHeaders) {
    const resolved = resolveHeaderAlias(h);
    usedHeaderMap[h] = resolved || h;
    if (!resolved) unknownHeadersAll.add(h);
  }

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    const { canonical, unknownHeaders } = mapRowToCanonical(row);
    const validation = validateRow(canonical);
    unknownHeaders.forEach((h) => unknownHeadersAll.add(h));

    preview.push({
      rowIndex: hasHeaderRow ? i + 2 : i + 1,
      requestCode: canonical["Request Code"] || "",
      mapped: canonical,
      unknownHeaders,
      valid: validation.valid,
      errors: validation.errors,
      warnings: validation.warnings,
    });
  }

  if (action === "preview") {
    return NextResponse.json({
      totalRows: dataRows.length,
      validCount: preview.filter((p) => p.valid).length,
      errorCount: preview.filter((p) => !p.valid).length,
      unknownHeaders: Array.from(unknownHeadersAll),
      headerMapping: usedHeaderMap,
      hasHeaderRow,
      preview: preview.slice(0, 50), // Only return first 50 rows for preview
      previewFull: preview,
    });
  }

  // Action = import
  const scope = await getUserScope(guard.session);
  const validRows = preview.filter((p) => p.valid).map((p) => p.mapped);

  // DATA SCOPE PHÍA SERVER (Yêu cầu #15).
  // scope chứa UUID phòng ban, còn dòng Excel chỉ có TÊN phòng ban dạng text.
  // Vì vậy phải phân giải tên -> department_id qua cây tổ chức rồi mới so khớp,
  // thay vì so chuỗi lỏng lẻo (cách cũ `dept.includes(uuid)` không bao giờ đúng).
  let rowsToImport = validRows;
  let outOfScopeCount = 0;
  if (scope !== null) {
    if (scope.length === 0) {
      return NextResponse.json({ error: "Tài khoản chưa được cấp Data Scope nào." }, { status: 403 });
    }
    const allowed: Record<string, string>[] = [];
    for (const r of validRows) {
      const { deptId } = await matchHierarchy(r["Location"], r["Division"], r["Department"], r["Section"], r["Group"]);
      if (deptId && scope.includes(deptId)) allowed.push(r);
      else outOfScopeCount++;
    }
    rowsToImport = allowed;
  }

  const results = await importRecruitmentRequests(
    rowsToImport,
    guard.session.username,
    body.options ?? { skipDuplicates: false, updateDuplicates: true },
  );

  await writeAudit(guard.session, "IMPORT_RECRUITMENT_REQUESTS", "recruitment_requests", {
    totalRows: dataRows.length,
    outOfScope: outOfScopeCount,
    imported: results.filter((r) => r.status === "INSERTED").length,
    updated: results.filter((r) => r.status === "UPDATED").length,
    skipped: results.filter((r) => r.status === "SKIPPED").length,
    errors: results.filter((r) => r.status === "ERROR").length,
  });

  return NextResponse.json({
    success: true,
    totalRows: dataRows.length,
    outOfScope: outOfScopeCount,
    results,
  });
}