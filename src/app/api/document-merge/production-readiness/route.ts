/**
 * GET /api/document-merge/production-readiness
 *
 * Production readiness check — KHÁC HẲN `/api/document-merge/verification/*`
 * (vốn CHỈ chạy ở non-production và được phép ghi/xoá dữ liệu thử). Route
 * này AN TOÀN để chạy trên PRODUCTION THẬT: mọi check đều READ-ONLY (xem
 * src/lib/document-merge/production-readiness.ts để biết chi tiết những gì
 * BỊ CẤM ở đây — không tạo job/candidate giả, không claim probe, không ghi
 * Drive, không render benchmark/visual).
 *
 * Chỉ ADMIN. KHÔNG giới hạn non-production (đây chính là điểm khác biệt với
 * Verification) — nhưng KHÔNG BAO GIỜ trả secret/token/DATABASE_URL/PII.
 *
 * overallStatus = "PASS" CHỈ KHI mọi check đọc được PASS *và*
 * DOCUMENT_MERGE_ENGINE vẫn là GOOGLE_DOCS. Nếu engine đã là HTML_PDF, trả
 * "BLOCKED" ngay lập tức — route này đo "hạ tầng sẵn sàng chưa", không phải
 * "cho phép kích hoạt HTML_PDF".
 */

import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { db } from "@/db";
import {
  checkEngineDefault,
  checkAuthEnv,
  checkStorageEnv,
  checkStorageDriveReachable,
  checkDatabase,
  checkMigrations,
  checkTemplateState,
  checkCloudRun,
} from "@/lib/document-merge/production-readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const guard = await requirePermission(["ADMIN"], "document_merge.history.view");
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  const startedAt = Date.now();
  const engine = checkEngineDefault();

  // Rào chắn CỨNG: nếu HTML_PDF đã bật, KHÔNG đánh giá tiếp phần còn lại như
  // bình thường — báo BLOCKED ngay (đúng yêu cầu Phase 6: "If HTML_PDF is
  // already set in Production: report BLOCKED immediately").
  if (!engine.isGoogleDocs) {
    return NextResponse.json(
      {
        overallStatus: "BLOCKED",
        error: `DOCUMENT_MERGE_ENGINE=${engine.value} — HTML_PDF đã được kích hoạt. Route này chỉ đo hạ tầng sẵn sàng khi engine vẫn GOOGLE_DOCS; không đánh giá tiếp.`,
        checks: { ENGINE_DEFAULT: engine },
        durationMs: Date.now() - startedAt,
      },
      { status: 200 },
    );
  }

  const [database, migrations, cloudRun, template] = await Promise.all([
    checkDatabase(db),
    checkMigrations(db),
    checkCloudRun({ request }),
    checkTemplateState(db).catch((error) => ({
      templateCount: 0,
      fieldCount: 0,
      publishedVersionCount: 0,
      dangKyTapNghe: null,
      error: error instanceof Error ? error.message.slice(0, 300) : String(error),
    })),
  ]);

  const auth = checkAuthEnv();
  const storageEnv = checkStorageEnv();
  const storageReachable = storageEnv.pass ? await checkStorageDriveReachable() : { pass: false, detail: "Env chưa đủ — bỏ qua đọc Drive." };

  const checks = {
    DATABASE: database,
    MIGRATIONS: migrations,
    CLOUD_RUN: cloudRun,
    AUTH: auth,
    STORAGE: { ...storageEnv, reachable: storageReachable },
    TEMPLATE: template,
    ENGINE_DEFAULT: engine,
    VISUAL_GATE: {
      status: "NOT_AUTOMATED_HERE",
      note: "Route này KHÔNG render benchmark/visual (nghiêm cấm theo thiết kế) — xác nhận thủ công qua worker/scripts/visual-verify.mjs hoặc Verification (staging) trước khi coi hạ tầng sẵn sàng cho HTML_PDF.",
    },
    BENCHMARK_GATE: {
      status: "NOT_AUTOMATED_HERE",
      note: "Route này KHÔNG chạy render benchmark (nghiêm cấm theo thiết kế) — xác nhận thủ công qua worker/scripts/benchmark.mjs hoặc Verification (staging).",
    },
  };

  const pass =
    database.pass &&
    migrations.pass &&
    cloudRun.pass &&
    auth.pass &&
    storageEnv.pass &&
    storageReachable.pass &&
    engine.isGoogleDocs;

  return NextResponse.json({
    overallStatus: pass ? "PASS" : "PARTIAL",
    note: "PASS ở đây nghĩa là HẠ TẦNG sẵn sàng — KHÔNG có nghĩa HTML_PDF đã/nên được kích hoạt. Kích hoạt vẫn yêu cầu VISUAL_GATE + BENCHMARK_GATE xác nhận thủ công và quyết định rõ ràng của người vận hành.",
    checks,
    durationMs: Date.now() - startedAt,
  });
}
