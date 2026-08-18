/**
 * POST /api/document-merge/verification/check-drive
 * Kiểm tra Google Drive (OAuth user): put probe file → getMetadata → delete.
 * Probe nhỏ (<1KB) trong folder Verification/ — staging chỉ.
 */

import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { isVerificationEnabled } from "@/lib/verification/helpers";
import { getStorageProvider } from "@/lib/storage/index";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const guard = await requirePermission(["ADMIN"], "document_merge.history.view");
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  if (!isVerificationEnabled()) {
    return NextResponse.json({ error: "Verification chỉ khả dụng ở non-production." }, { status: 403 });
  }

  const startedAt = Date.now();
  const storage = getStorageProvider();
  if (storage.name !== "google_drive") {
    return NextResponse.json({
      pass: true,
      stage: "GOOGLE_DRIVE",
      note: `StorageProvider hiện tại = ${storage.name} (không phải google_drive) — check Drive bị bỏ qua.`,
      provider: storage.name,
      durationMs: Date.now() - startedAt,
    });
  }

  try {
    const key = `Verification/probe-${Date.now()}.txt`;
    await storage.put(key, Buffer.from("seasonal-worker drive probe"), "text/plain");
    const meta = await storage.getMetadata(key);
    await storage.delete(key);
    const existsAfter = await storage.exists(key);
    return NextResponse.json({
      pass: Boolean(meta),
      stage: "GOOGLE_DRIVE",
      provider: storage.name,
      probeCreated: true,
      size: meta?.size ?? null,
      driveSha256: meta?.sha256 ?? null,
      deletedAfterProbe: !existsAfter,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    return NextResponse.json({
      pass: false,
      stage: "GOOGLE_DRIVE",
      error: error instanceof Error ? error.message.slice(0, 300) : String(error),
      durationMs: Date.now() - startedAt,
    });
  }
}
