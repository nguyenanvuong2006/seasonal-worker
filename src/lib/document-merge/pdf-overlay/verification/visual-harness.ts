/**
 * PDF Overlay Verification — visual verification harness (PR4).
 *
 * Chạy các fixture qua renderer, tạo artifacts (PDF + report), kiểm tra:
 *   - renderer succeeds for valid fixtures
 *   - Vietnamese glyphs supported
 *   - expected page count
 *   - no unexpected renderer warnings
 *   - deterministic output (same input → same SHA-256)
 *   - SHA-256 generated
 *   - required-field rejection works
 *   - FIELD_OVERFLOW works
 *   - invalid coordinates rejected
 *   - output PDF can be parsed again successfully
 *
 * VISUAL correctness itself remains a MANUAL gate — harness chỉ tạo artifacts
 * để operator review, KHÔNG tự động PASS visual.
 */

import { PDFDocument } from "pdf-lib";

import { PdfOverlayError, type PdfOverlayRenderResult } from "../types.ts";
import { renderPdfOverlay, sha256Hex } from "../renderer.ts";
import { readEmbeddedFontBytes } from "../vietnamese-font.ts";
import type { VerificationFixture, VisualVerificationReport, VisualFixtureReport, RenderArtifact } from "./types.ts";

const RENDERER_NAME = "pdf-overlay-renderer";

/** Render một fixture, trả artifact hoặc error. */
export async function renderFixture(
  fixture: VerificationFixture,
  fontBytes: Uint8Array,
): Promise<{ artifact?: RenderArtifact; error?: string; errorCode?: string }> {
  const startedAt = Date.now();
  try {
    const result: PdfOverlayRenderResult = await renderPdfOverlay(
      fixture.templatePdf,
      fixture.positions,
      fixture.fieldValues,
      {
        fontBytes,
        expectedPageCount: fixture.expectedPageCount,
        subsetFont: true,
      },
    );

    const artifact: RenderArtifact = {
      fixtureId: fixture.id,
      bytes: result.bytes,
      sha256: result.sha256,
      pageCount: result.pageCount,
      positionsDrawn: result.positionsDrawn,
      warnings: result.warnings,
      durationMs: Date.now() - startedAt,
      renderedAt: new Date().toISOString(),
    };
    return { artifact };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const errorCode = err instanceof PdfOverlayError ? err.code : undefined;
    return { error, errorCode };
  }
}

/** Kiểm tra PDF output có parse lại được không (structural integrity). */
export async function isOutputParseable(bytes: Uint8Array): Promise<boolean> {
  try {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    return doc.getPageCount() > 0;
  } catch {
    return false;
  }
}

/** Kiểm tra tính deterministic: render 2 lần cùng input → cùng SHA-256. */
export async function checkDeterministic(
  fixture: VerificationFixture,
  fontBytes: Uint8Array,
): Promise<boolean> {
  try {
    const [r1, r2] = await Promise.all([
      renderPdfOverlay(fixture.templatePdf, fixture.positions, fixture.fieldValues, {
        fontBytes,
        subsetFont: true,
      }),
      renderPdfOverlay(fixture.templatePdf, fixture.positions, fixture.fieldValues, {
        fontBytes,
        subsetFont: true,
      }),
    ]);
    return r1.sha256 === r2.sha256;
  } catch {
    return false;
  }
}

/** Chạy verification cho 1 fixture, trả report. */
export async function verifyFixture(
  fixture: VerificationFixture,
  fontBytes: Uint8Array,
): Promise<VisualFixtureReport> {
  const { artifact, error, errorCode } = await renderFixture(fixture, fontBytes);

  // Nếu fixture mong đợi lỗi
  if (fixture.expectedError) {
    if (errorCode && errorCode === fixture.expectedError) {
      return {
        fixtureId: fixture.id,
        fixtureName: fixture.name,
        status: "PASS",
        checks: {
          rendererSucceeded: false,
          sha256Generated: false,
          noUnexpectedWarnings: true,
          outputParseable: false,
        },
      };
    }
    return {
      fixtureId: fixture.id,
      fixtureName: fixture.name,
      status: "FAIL",
      error: errorCode
        ? `Expected error ${fixture.expectedError}, got: ${errorCode}`
        : error
        ? `Expected error ${fixture.expectedError}, got: ${error}`
        : `Expected error ${fixture.expectedError}, but renderer succeeded`,
      checks: {
        rendererSucceeded: !error,
        sha256Generated: false,
        noUnexpectedWarnings: false,
        outputParseable: false,
      },
    };
  }

  // Fixture mong đợi thành công
  if (error) {
    return {
      fixtureId: fixture.id,
      fixtureName: fixture.name,
      status: "ERROR",
      error,
      checks: {
        rendererSucceeded: false,
        sha256Generated: false,
        noUnexpectedWarnings: false,
        outputParseable: false,
      },
    };
  }

  if (!artifact) {
    return {
      fixtureId: fixture.id,
      fixtureName: fixture.name,
      status: "ERROR",
      error: "No artifact produced",
      checks: {
        rendererSucceeded: false,
        sha256Generated: false,
        noUnexpectedWarnings: false,
        outputParseable: false,
      },
    };
  }

  const outputParseable = await isOutputParseable(artifact.bytes);
  const pageCountMatches =
    fixture.expectedPageCount !== undefined
      ? artifact.pageCount === fixture.expectedPageCount
      : true;
  const sha256Generated = artifact.sha256.length === 64 && /^[a-f0-9]{64}$/.test(artifact.sha256);
  const noUnexpectedWarnings = artifact.warnings.length === 0;

  const allChecksPass =
    outputParseable && pageCountMatches && sha256Generated && noUnexpectedWarnings;

  return {
    fixtureId: fixture.id,
    fixtureName: fixture.name,
    status: allChecksPass ? "PASS" : "FAIL",
    artifact,
    checks: {
      rendererSucceeded: true,
      sha256Generated,
      pageCountMatches,
      noUnexpectedWarnings,
      outputParseable,
    },
  };
}

/** Chạy verification cho tất cả fixtures, trả report tổng hợp. */
export async function runVisualVerification(
  fixtures: VerificationFixture[],
): Promise<VisualVerificationReport> {
  const fontBytes = readEmbeddedFontBytes();
  const reports: VisualFixtureReport[] = [];
  const warnings: string[] = [];

  for (const fixture of fixtures) {
    const report = await verifyFixture(fixture, fontBytes);
    reports.push(report);

    // Kiểm tra deterministic cho các fixture thành công
    if (report.status === "PASS" && !fixture.expectedError) {
      const deterministic = await checkDeterministic(fixture, fontBytes);
      if (!deterministic) {
        warnings.push(`Fixture ${fixture.id}: output không deterministic`);
        report.status = "FAIL";
      }
    }
  }

  const passed = reports.filter((r) => r.status === "PASS").length;
  const failed = reports.filter((r) => r.status === "FAIL").length;
  const errors = reports.filter((r) => r.status === "ERROR").length;

  return {
    generatedAt: new Date().toISOString(),
    renderer: RENDERER_NAME,
    fixtures: reports,
    summary: {
      total: reports.length,
      passed,
      failed,
      errors,
    },
    deterministic: warnings.length === 0,
    warnings,
  };
}

/** Tạo SHA-256 của toàn bộ report (để tracking). */
export function hashReport(report: VisualVerificationReport): string {
  const json = JSON.stringify(report, null, 2);
  return sha256Hex(new TextEncoder().encode(json));
}
