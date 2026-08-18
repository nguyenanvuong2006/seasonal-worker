/**
 * GET /api/document-merge/files?key=<storage key>
 * Phục vụ file từ StorageProvider (local provider — dev/staging chạy STORAGE_PROVIDER=local).
 * Google Drive provider dùng webViewLink nên không cần route này.
 * Chỉ ADMIN/HR có quyền xem history. Không cho arbitrary path (storage provider tự sanitize).
 */

import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { getStorageProvider } from "@/lib/storage/index";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "document_merge.history.view");
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  const { searchParams } = new URL(request.url);
  const key = searchParams.get("key") ?? "";
  if (!key) {
    return NextResponse.json({ error: "Thiếu key." }, { status: 400 });
  }

  const storage = getStorageProvider();
  if (storage.name !== "local") {
    // Drive dùng webViewLink trực tiếp — route này chỉ phục vụ local provider.
    return NextResponse.json({ error: "Route chỉ phục vụ local storage provider." }, { status: 404 });
  }

  try {
    const body = await storage.get(key);
    const meta = await storage.getMetadata(key);
    const contentType =
      key.toLowerCase().endsWith(".pdf") ? "application/pdf"
      : key.toLowerCase().endsWith(".zip") ? "application/zip"
      : "application/octet-stream";
    const filename = key.split("/").pop() ?? "file";
    return new NextResponse(new Uint8Array(body), {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(meta?.size ?? body.byteLength),
        "Content-Disposition": `attachment; filename="${encodeURIComponent(filename)}"`,
        "Cache-Control": "private, max-age=300",
      },
    });
  } catch {
    return NextResponse.json({ error: "File không tồn tại." }, { status: 404 });
  }
}
