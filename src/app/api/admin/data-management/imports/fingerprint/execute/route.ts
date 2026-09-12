import { NextResponse } from "next/server";
import { requirePermission, writeAudit } from "@/lib/auth";
import { parseImportFile } from "@/lib/file-parser";
import { resolveDataManagementEnvironment } from "@/lib/data-management/environment";
import { computeFileChecksum } from "@/lib/data-management/import-workforce-master";
import { createFingerprintBatch, mergeFingerprintChunk } from "@/lib/data-management/import-fingerprint";
import { validateUploadFile } from "@/lib/data-management/file-safety";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Same bounded-chunk/resumable contract as the Workforce Master execute route. Distinct permission (data_management.import — same as workforce; the destructive RESET side has its own separate fingerprint permission, reset_fingerprint, which this route never touches). */
export async function POST(req: Request) {
  const guard = await requirePermission(["ADMIN"], "data_management.import");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const form = await req.formData();
  const existingBatchId = form.get("batchId") as string | null;

  let batchId: string;
  if (existingBatchId) {
    batchId = existingBatchId;
  } else {
    const file = form.get("file") as File | null;
    if (!file) return NextResponse.json({ error: "INVALID_ARGS", message: "Chưa chọn file." }, { status: 400 });
    const safety = validateUploadFile(file);
    if (!safety.ok) return NextResponse.json({ error: "INVALID_ARGS", message: safety.message }, { status: 400 });
    const datasetModeRaw = form.get("datasetMode");
    const datasetMode = datasetModeRaw === "OFFICIAL" ? "OFFICIAL" : "TEST";

    const buf = Buffer.from(await file.arrayBuffer());
    const checksum = computeFileChecksum(buf);
    let rows: Record<string, string>[];
    try {
      rows = await parseImportFile(buf, file.name);
    } catch (e) {
      return NextResponse.json({ error: "INVALID_ARGS", message: "Không đọc được file: " + (e as Error).message }, { status: 400 });
    }
    if (rows.length === 0) return NextResponse.json({ error: "INVALID_ARGS", message: "File rỗng hoặc không có dữ liệu." }, { status: 400 });

    const created = await createFingerprintBatch({
      fileName: file.name,
      checksum,
      rows,
      createdBy: guard.session.username,
      environment: resolveDataManagementEnvironment(),
      datasetMode,
    });
    if (!created.ok) return NextResponse.json({ error: created.error, message: created.message }, { status: 409 });
    batchId = created.batchId;

    await writeAudit(guard.session, "DATA_MANAGEMENT_IMPORT_STARTED", "workforce_data_import_batches", { batchId, importType: "FINGERPRINT", fileName: file.name, totalRows: rows.length, datasetMode }, "IMPORT");
  }

  const chunk = await mergeFingerprintChunk(batchId, guard.session.username);
  if (chunk.done) {
    await writeAudit(guard.session, "DATA_MANAGEMENT_IMPORT_COMPLETED", "workforce_data_import_batches", { batchId, importType: "FINGERPRINT" }, "IMPORT");
  }

  return NextResponse.json({ batchId, ...chunk });
}
