/**
 * GET /api/archive/documents/[id]/download
 * Tải binary PDF từ storage provider (backend proxy — KHÔNG expose Drive token
 * cho Archive Agent). Agent tính SHA-256 local rồi verify qua POST /verify.
 *
 * Auth: Bearer ARCHIVE_API_KEY hoặc session ADMIN.
 */

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { documentHistory } from "@/db/schema";
import { authenticateArchiveRequest } from "@/lib/document-merge/archive-auth";
import { getStorageProvider } from "@/lib/storage/index";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  const auth = await authenticateArchiveRequest(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  try {
    const { id } = await context.params;
    const [doc] = await db.select().from(documentHistory).where(eq(documentHistory.id, id)).limit(1);
    if (!doc) {
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }
    if (doc.onlineDeletedAt) {
      return NextResponse.json({ error: "Document đã bị xoá online (online_deleted_at đã set)." }, { status: 410 });
    }
    if (doc.archiveStatus === "VERIFIED") {
      return NextResponse.json({ error: "Document đã VERIFIED — không tải lại." }, { status: 409 });
    }
    if (!doc.storageFileId) {
      return NextResponse.json({ error: "Document không có storage_file_id." }, { status: 409 });
    }

    const storage = getStorageProvider();
    const buffer = await storage.get(doc.storageFileId);

    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(buffer.byteLength),
        "Content-Disposition": `attachment; filename="${doc.filename.replace(/[\\/:*?"<>|]/g, "_")}"`,
        "X-Expected-SHA256": doc.sha256 ?? "",
        "X-History-Id": doc.id,
      },
    });
  } catch (error) {
    console.error("[archive/documents/[id]/download] error:", error);
    return NextResponse.json({ error: "Failed to download document" }, { status: 500 });
  }
}
