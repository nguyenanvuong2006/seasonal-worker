/**
 * POST /api/document-merge/verification/benchmark
 * Benchmark trên CLOUD (worker /benchmark): 1/10/50/100 records.
 * Body: { counts?: number[] } — chỉ chấp nhận giá trị trong {1,10,50,100}.
 */

import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { isVerificationEnabled, callWorker } from "@/lib/verification/helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED = [1, 10, 50, 100];

export async function POST(request: Request) {
  const guard = await requirePermission(["ADMIN"], "document_merge.history.view");
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  if (!isVerificationEnabled()) {
    return NextResponse.json({ error: "Verification chỉ khả dụng ở non-production." }, { status: 403 });
  }

  const body = (await request.json().catch(() => ({}))) as { counts?: number[] };
  const counts = Array.isArray(body.counts) ? body.counts.map(Number).filter((c) => ALLOWED.includes(c)) : ALLOWED;
  if (counts.length === 0) {
    return NextResponse.json({ error: "counts không hợp lệ — chỉ hỗ trợ 1,10,50,100." }, { status: 400 });
  }

  const startedAt = Date.now();
  const result = await callWorker<{ runs?: Record<string, unknown>[]; concurrency?: number; error?: string }>(
    "/benchmark",
    { counts },
    300_000,
    { request },
  );
  const data = result.data as { runs?: Record<string, unknown>[]; concurrency?: number; error?: string };

  if (!result.ok || !data.runs) {
    return NextResponse.json({
      pass: false,
      stage: "BENCHMARK",
      error: data.error ?? `Worker HTTP ${result.status}`,
      durationMs: Date.now() - startedAt,
    });
  }

  return NextResponse.json({
    pass: true,
    stage: "BENCHMARK",
    runs: data.runs,
    concurrency: data.concurrency,
    durationMs: Date.now() - startedAt,
  });
}
