/**
 * POST /api/document-merge/verification/pdf-overlay
 *
 * Staging-only PDF Overlay verification route (PR4).
 *
 * Chạy visual verification + benchmark harness với fixtures giả (KHÔNG dữ liệu
 * Production). Trả report để operator review.
 *
 * Hard requirements:
 *   - staging only (VERIFICATION_ENABLED=true)
 *   - no Production business record mutation
 *   - no Production merge_jobs
 *   - no Production /run
 *   - no engine activation
 *   - no real candidate required
 *   - controlled fixture input
 *   - generated verification artifacts clearly marked NON-PRODUCTION
 *
 * RBAC: ADMIN only.
 */

import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { isVerificationEnabled } from "@/lib/verification/helpers";
import {
  generateAllFixtures,
  runVisualVerification,
  runBenchmark,
  createDefaultScenarios,
  computeReadinessState,
  assertVerificationSafe,
  assertFixtureSafe,
  createNonProductionMarker,
} from "@/lib/document-merge/pdf-overlay/verification";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const guard = await requirePermission(["ADMIN"], "document_merge.history.view");
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }

  if (!isVerificationEnabled()) {
    return NextResponse.json(
      { error: "Verification chỉ khả dụng ở non-production (VERIFICATION_ENABLED=true)." },
      { status: 403 },
    );
  }

  // Guard: kiểm tra an toàn
  const safety = assertVerificationSafe();
  if (!safety.safe) {
    return NextResponse.json(
      { error: `BLOCKED: ${safety.reason}` },
      { status: 403 },
    );
  }

  try {
    let body: { runBenchmark?: boolean; runsPerScenario?: number } = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    const runBenchmarkFlag = body.runBenchmark ?? false;
    const runsPerScenario = body.runsPerScenario ?? 3;

    // Tạo fixtures
    const fixtures = await generateAllFixtures();

    // Kiểm tra fixture an toàn
    for (const fixture of fixtures) {
      const fixtureSafety = assertFixtureSafe(fixture.fieldValues);
      if (!fixtureSafety.safe) {
        return NextResponse.json(
          { error: `Fixture ${fixture.id} không an toàn: ${fixtureSafety.reason}` },
          { status: 400 },
        );
      }
    }

    // Chạy visual verification
    const visualReport = await runVisualVerification(fixtures);

    // Chạy benchmark nếu yêu cầu
    let benchmarkReport = null;
    if (runBenchmarkFlag) {
      const scenarios = await createDefaultScenarios();
      for (const s of scenarios) s.runCount = runsPerScenario;
      benchmarkReport = await runBenchmark(scenarios);
    }

    // Tính readiness state
    const readinessState = computeReadinessState(visualReport, benchmarkReport);

    // Marker NON-PRODUCTION
    const marker = createNonProductionMarker();

    return NextResponse.json({
      marker,
      visualReport,
      benchmarkReport,
      readinessState,
      summary: {
        fixtures: fixtures.length,
        visualPassed: visualReport.summary.passed,
        visualFailed: visualReport.summary.failed,
        visualErrors: visualReport.summary.errors,
        visualDeterministic: visualReport.deterministic,
        benchmarkScenarios: benchmarkReport?.scenarios.length ?? 0,
        canProceedToActivation: readinessState.canProceedToActivation,
      },
    });
  } catch (error) {
    console.error("[verification/pdf-overlay] error:", error);
    return NextResponse.json(
      { error: "Không chạy được verification." },
      { status: 500 },
    );
  }
}
