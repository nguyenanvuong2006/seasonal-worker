/**
 * POST /api/document-merge/verification/check-queue
 *
 * "Check Queue" gate (CLAIM_STALLED root-cause investigation, STAGING only).
 * KHÔNG đoán claimItems() có bug — chứng minh bằng chứng thật theo 2 bước:
 *
 *   1. Database identity: so sánh Vercel (kết nối trực tiếp) vs Cloud Run
 *      worker (qua /diag/db-identity) — nếu KHÔNG khớp, đây CHÍNH LÀ root
 *      cause (Vercel ghi vào 1 DB, worker đọc DB khác) — dừng ngay, KHÔNG
 *      chạy claim probe (claim probe vô nghĩa nếu 2 DB khác nhau).
 *   2. Claim probe: gọi worker /diag/claim-probe — seed 1 job/item QUEUED
 *      thật trên CHÍNH kết nối worker dùng khi xử lý job thật, gọi ĐÚNG
 *      claimItems() production, trả về ranh giới lỗi cụ thể nếu claim thất bại.
 *
 * Chỉ ADMIN + non-production (VERIFICATION_ENABLED=true). Không expose secret.
 */

import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { db } from "@/db";
import { isVerificationEnabled, callWorker } from "@/lib/verification/helpers";
import { getDbIdentity, type DbIdentity } from "@/lib/document-merge/db-identity";
import type { ClaimProbeReport } from "@/lib/document-merge/queue-diagnostics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const guard = await requirePermission(["ADMIN"], "document_merge.history.view");
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  if (!isVerificationEnabled()) {
    return NextResponse.json({ error: "Verification chỉ khả dụng ở non-production." }, { status: 403 });
  }

  const startedAt = Date.now();

  // Bước 1: database identity — Vercel (trực tiếp) vs Cloud Run worker (qua HTTP).
  const vercelIdentity = await getDbIdentity(db);
  const workerIdentityResult = await callWorker<DbIdentity>("/diag/db-identity", undefined, 15_000, { request });
  if (!workerIdentityResult.ok) {
    return NextResponse.json({
      pass: false,
      stage: workerIdentityResult.stage === "CLOUD_RUN_IAM" || workerIdentityResult.stage === "WORKER_AUTH"
        ? workerIdentityResult.stage
        : "WORKER_DB_IDENTITY_UNREACHABLE",
      error: (workerIdentityResult.data as { error?: string }).error ?? `HTTP ${workerIdentityResult.status}`,
      vercelIdentity,
      durationMs: Date.now() - startedAt,
    });
  }
  const workerIdentity = workerIdentityResult.data as DbIdentity;

  const identityMatches =
    vercelIdentity.hostFromConnectionString !== null &&
    vercelIdentity.hostFromConnectionString === workerIdentity.hostFromConnectionString &&
    vercelIdentity.currentDatabase !== null &&
    vercelIdentity.currentDatabase === workerIdentity.currentDatabase;

  if (!identityMatches) {
    return NextResponse.json({
      pass: false,
      stage: "DB_IDENTITY_MISMATCH",
      error:
        "Vercel và Cloud Run worker đang trỏ vào 2 database/host khác nhau — đây LÀ root cause (item seed ở Vercel không thể được worker claim vì worker không thấy nó). Sửa cấu hình DATABASE_URL, KHÔNG sửa claimItems().",
      vercelIdentity,
      workerIdentity,
      identityMatches,
      durationMs: Date.now() - startedAt,
    });
  }

  // Bước 2: claim probe — CHỈ chạy khi 2 DB đã xác nhận khớp (nếu không, kết
  // quả claim probe vô nghĩa: có thể "pass" trên worker's DB trong khi job
  // thật được seed ở DB khác của Vercel).
  const probeResult = await callWorker<ClaimProbeReport>("/diag/claim-probe", undefined, 30_000, { request });
  if (!probeResult.ok) {
    return NextResponse.json({
      pass: false,
      stage: "CLAIM_PROBE_UNREACHABLE",
      error: (probeResult.data as { error?: string }).error ?? `HTTP ${probeResult.status}`,
      vercelIdentity,
      workerIdentity,
      identityMatches,
      durationMs: Date.now() - startedAt,
    });
  }

  const probe = probeResult.data as ClaimProbeReport;
  const pass = probe.boundary === "E_CLAIM_SUCCEEDED" && probe.cleanupOk;

  return NextResponse.json({
    pass,
    stage: "QUEUE",
    identityMatches,
    vercelIdentity,
    workerIdentity,
    claimProbe: probe,
    durationMs: Date.now() - startedAt,
  });
}
