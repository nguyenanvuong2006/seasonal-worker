/**
 * GET /api/archive/documents
 * Archive Agent hỏi danh sách PDF chưa archive (ONLINE / ARCHIVED / ARCHIVE_VERIFY_FAILED).
 * Phân trang (limit/offset). Không trả nội dung file — chỉ metadata (download riêng).
 * Auth: Bearer ARCHIVE_API_KEY hoặc session ADMIN.
 */

import { NextResponse } from "next/server";
import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { dailyApplications } from "@/db/schema";
import { authenticateArchiveRequest } from "@/lib/document-merge/archive-auth";
import { listDocumentsPendingArchive } from "@/lib/document-merge/document-history";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await authenticateArchiveRequest(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  try {
    const url = new URL(request.url);
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 200)));
    const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));

    const docs = await listDocumentsPendingArchive({ limit, offset });

    // Lấy tên ứng viên cho manifest (chỉ khi có applicationId).
    const appIds = [...new Set(docs.map((doc) => doc.applicationId).filter(Boolean))] as string[];
    const appRows = appIds.length > 0
      ? await db
          .select({ id: dailyApplications.id, fullName: dailyApplications.fullName })
          .from(dailyApplications)
          .where(inArray(dailyApplications.id, appIds))
          .catch(() => [])
      : [];
    const nameById = new Map(appRows.map((row) => [row.id, row.fullName]));

    return NextResponse.json({
      documents: docs.map((doc) => ({
        id: doc.id,
        filename: doc.filename,
        applicationId: doc.applicationId,
        candidateId: doc.candidateId,
        candidateName: doc.applicationId ? (nameById.get(doc.applicationId) ?? null) : null,
        documentType: doc.documentType,
        templateVersion: doc.templateVersion,
        generatedAt: doc.generatedAt,
        fileSize: doc.fileSize,
        sha256: doc.sha256,
        storageProvider: doc.storageProvider,
        storageFileId: doc.storageFileId,
        archiveStatus: doc.archiveStatus,
        retentionUntil: doc.retentionUntil,
      })),
      count: docs.length,
      offset,
      limit,
    });
  } catch (error) {
    console.error("[archive/documents] GET error:", error);
    return NextResponse.json({ error: "Failed to list archive documents" }, { status: 500 });
  }
}
