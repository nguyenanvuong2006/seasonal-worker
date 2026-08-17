/**
 * POST /api/archive/verify
 * Archive Agent xác nhận kết quả tải + checksum:
 *   { historyId, sha256Match: boolean, archivePath: string, archiveSha256?: string }
 *
 * - sha256Match=true  → archive_status = VERIFIED (archive_verified_at = now).
 * - sha256Match=false → ARCHIVE_VERIFY_FAILED (GIỮ file Drive — retry/download lại).
 *
 * Auth: Bearer ARCHIVE_API_KEY hoặc session ADMIN.
 */

import { NextResponse } from "next/server";
import { authenticateArchiveRequest } from "@/lib/document-merge/archive-auth";
import { verifyArchive } from "@/lib/document-merge/document-history";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const auth = await authenticateArchiveRequest(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  try {
    const body = (await request.json()) as {
      historyId?: string;
      sha256Match?: boolean;
      archivePath?: string;
      archiveSha256?: string | null;
    };
    if (!body.historyId || typeof body.sha256Match !== "boolean" || !body.archivePath) {
      return NextResponse.json(
        { error: "Cần historyId, sha256Match (boolean) và archivePath." },
        { status: 400 },
      );
    }

    const updated = await verifyArchive(body.historyId, {
      sha256Match: body.sha256Match,
      archivePath: body.archivePath,
      archiveSha256: body.archiveSha256 ?? null,
    });

    return NextResponse.json({
      success: true,
      historyId: updated.id,
      archiveStatus: updated.archiveStatus,
      archiveVerifiedAt: updated.archiveVerifiedAt,
    });
  } catch (error) {
    console.error("[archive/verify] POST error:", error);
    return NextResponse.json({ error: "Failed to verify archive" }, { status: 500 });
  }
}
