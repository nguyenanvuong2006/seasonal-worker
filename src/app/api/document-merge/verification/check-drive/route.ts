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
    // "Bỏ qua" KHÔNG được phép hiển thị như PASS — verification chưa thật sự
    // xác nhận Drive hoạt động. Lưu ý: giá trị này đọc STORAGE_PROVIDER của
    // tiến trình Vercel (Next.js), KHÔNG phải cấu hình runtime của Cloud Run
    // worker (đặt riêng qua --set-env-vars trong deploy-worker-staging.yml) —
    // 1 process "local" không tự động nghĩa là worker cũng "local".
    return NextResponse.json({
      pass: false,
      skipped: true,
      stage: "GOOGLE_DRIVE",
      error: `StorageProvider (Vercel) = "${storage.name}", không phải "google_drive" — check Drive BỊ BỎ QUA, không phải PASS. Đây là cấu hình của tiến trình Vercel; worker Cloud Run có biến STORAGE_PROVIDER RIÊNG — kiểm tra riêng (gcloud run services describe) nếu cần xác nhận worker cũng dùng google_drive.`,
      provider: storage.name,
      checkedProcess: "vercel",
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
