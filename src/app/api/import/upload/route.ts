import { NextResponse } from "next/server";
import crypto from "crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { importJobs } from "@/db/schema";
import { requireRoleAndPermission, writeAudit } from "@/lib/auth";
import { createJob, stageRows, triggerWorker } from "@/lib/import-jobs";
import { parseImportFile } from "@/lib/file-parser";
import { getFieldDefinitions, normalizeHeader, type Group } from "@/lib/metadata";
import { getAcceptedColumnNames } from "@/lib/import-engine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * IMPORT ENGINE v3 — BƯỚC 1: upload nguyên file, server parse (xlsx đọc được cả CSV/XLSX/XLS),
 * tạo Job (QUEUED), bulk load vào staging RIÊNG LOẠI (UNNEST — xem lib/import-jobs.ts), rồi
 * KÍCH HOẠT worker tự "chain" (Next.js after()) và trả về ngay `jobId` — không giữ request mở
 * để chờ xử lý xong. Trình duyệt có thể đóng ngay sau khi nhận được jobId.
 *
 * Nếu file có trường bắt buộc chưa tự nhận diện được cột (Map Columns), trả về
 * `needsMapping: true` KHÔNG tạo job — client gửi lại đúng file này kèm `mapping` (JSON).
 */
export async function POST(req: Request) {
  const guard = await requireRoleAndPermission(["ADMIN"], "import.run");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const form = await req.formData();
  const file = form.get("file") as File | null;
  const jobType = form.get("jobType") as "department" | "dw_data" | "daily_application" | null;
  const mappingRaw = form.get("mapping") as string | null;
  const mapping = mappingRaw ? (JSON.parse(mappingRaw) as Record<string, string>) : null;

  if (!file) return NextResponse.json({ error: "Chưa chọn file." }, { status: 400 });
  if (!jobType || !["department", "dw_data", "daily_application"].includes(jobType)) {
    return NextResponse.json({ error: "jobType không hợp lệ." }, { status: 400 });
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const checksum = crypto.createHash("sha256").update(buf).digest("hex");

  let rows: Record<string, string>[];
  try {
    rows = await parseImportFile(buf, file.name);
  } catch (e) {
    return NextResponse.json({ error: "Không đọc được file: " + (e as Error).message }, { status: 400 });
  }
  if (rows.length === 0) return NextResponse.json({ error: "File rỗng hoặc không có dữ liệu." }, { status: 400 });

  const headers = Object.keys(rows[0]);
  const headerSet = new Set(headers.map(normalizeHeader));
  const defs = await getFieldDefinitions(jobType);

  const unmatchedRequiredFields = defs
    .filter((d) => d.required)
    .filter((d) => {
      const names = [d.importColumnName, ...(d.aliases ?? [])].filter(Boolean) as string[];
      const coveredByMapping = mapping && mapping[d.fieldKey];
      return !coveredByMapping && !names.some((n) => headerSet.has(normalizeHeader(n)));
    })
    .map((d) => ({ fieldKey: d.fieldKey, displayName: d.displayName }));

  if (unmatchedRequiredFields.length > 0 && !mapping) {
    const allAcceptedNames = await getAcceptedColumnNames(jobType);
    const unrecognizedColumns = headers.filter((h) => !allAcceptedNames.has(normalizeHeader(h)));
    return NextResponse.json({
      needsMapping: true,
      totalRows: rows.length,
      headers,
      preview: rows.slice(0, 20),
      unmatchedRequiredFields,
      unrecognizedColumns,
    });
  }

  if (mapping) {
    const fieldToImportName = new Map(defs.filter((d) => d.importColumnName).map((d) => [d.fieldKey, d.importColumnName as string]));
    rows = rows.map((row) => {
      const copy = { ...row };
      for (const [fieldKey, uploadedHeader] of Object.entries(mapping)) {
        const canonical = fieldToImportName.get(fieldKey);
        if (canonical && uploadedHeader in copy) copy[canonical] = copy[uploadedHeader];
      }
      return copy;
    });
  }

  const job = await createJob(jobType, file.name, checksum, guard.session.username, rows.length);
  await stageRows(job.id, jobType, rows);
  await db.update(importJobs).set({ status: "QUEUED" }).where(eq(importJobs.id, job.id));

  const baseUrl = new URL(req.url).origin;
  triggerWorker(job.id, job.resumeToken, baseUrl);

  await writeAudit(guard.session, "IMPORT_JOB_CREATED", jobType, { jobId: job.id, fileName: file.name, totalRows: rows.length }, "IMPORT");

  return NextResponse.json({ jobId: job.id, totalRows: rows.length, headers, preview: rows.slice(0, 20) });
}
