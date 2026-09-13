import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { parseImportFile } from "@/lib/file-parser";
import { dryRunFingerprint } from "@/lib/data-management/import-fingerprint";
import { validateUploadFile } from "@/lib/data-management/file-safety";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Dry run — reconciles every row against dw_data (read-only). NO database writes, and the IT Code payload is never echoed back beyond what the uploading admin already has in their own file (mission section 19). */
export async function POST(req: Request) {
  const guard = await requirePermission(["ADMIN"], "data_management.import");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const form = await req.formData();
  const file = form.get("file") as File | null;
  if (!file) return NextResponse.json({ error: "INVALID_ARGS", message: "Chưa chọn file." }, { status: 400 });
  const safety = validateUploadFile(file);
  if (!safety.ok) return NextResponse.json({ error: "INVALID_ARGS", message: safety.message }, { status: 400 });

  const buf = Buffer.from(await file.arrayBuffer());
  let rows: Record<string, string>[];
  try {
    rows = await parseImportFile(buf, file.name);
  } catch (e) {
    return NextResponse.json({ error: "INVALID_ARGS", message: "Không đọc được file: " + (e as Error).message }, { status: 400 });
  }
  if (rows.length === 0) return NextResponse.json({ error: "INVALID_ARGS", message: "File rỗng hoặc không có dữ liệu." }, { status: 400 });

  const result = await dryRunFingerprint(rows);
  return NextResponse.json(result);
}
