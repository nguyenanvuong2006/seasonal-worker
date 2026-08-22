/**
 * PDF Overlay Verification — production isolation safeguards (PR4).
 *
 * Đảm bảo verification/benchmark KHÔNG BAO GIỜ:
 *   - Dùng Production merge_jobs
 *   - Mutate Production candidate/business records
 *   - Invoke Production Cloud Run /run
 *   - Đọc/ghi Production storage
 *   - Thay đổi DOCUMENT_MERGE_ENGINE
 *   - Dùng real candidate PII
 *
 * Các hàm guard được gọi trước khi chạy verification/benchmark.
 */

/** Kiểm tra environment có phải Production không. */
export function isProductionEnvironment(): boolean {
  const vercelEnv = process.env.VERCEL_ENV;
  const nodeEnv = process.env.NODE_ENV;
  return vercelEnv === "production" || nodeEnv === "production";
}

/** Kiểm tra DOCUMENT_MERGE_ENGINE có phải GOOGLE_DOCS không. */
export function isGoogleDocsEngine(): boolean {
  const engine = process.env.DOCUMENT_MERGE_ENGINE;
  return !engine || engine === "GOOGLE_DOCS";
}

/** Kiểm tra fixture có chứa PII thật không (heuristic). */
export function containsRealPii(fieldValues: Record<string, string>): boolean {
  // Heuristic: PII thật thường có:
  //   - CCCD 12 số
  //   - Số điện thoại 10-11 số
  //   - Email có domain thật (không phải example.com, test.com)
  //   - Địa chỉ cụ thể (có số nhà + tên đường)
  const piiPatterns = [
    /^\d{12}$/, // CCCD
    /^0\d{9,10}$/, // Phone
    /@(?!(example|test|mailinator)\.com$).+@.+\..+/, // Real email
  ];

  for (const value of Object.values(fieldValues)) {
    for (const pattern of piiPatterns) {
      if (pattern.test(value)) {
        return true;
      }
    }
  }
  return false;
}

/** Guard: kiểm tra trước khi chạy verification. */
export function assertVerificationSafe(): { safe: boolean; reason?: string } {
  if (isProductionEnvironment()) {
    return {
      safe: false,
      reason: "KHÔNG chạy verification ở Production environment.",
    };
  }

  if (!isGoogleDocsEngine()) {
    return {
      safe: false,
      reason: `DOCUMENT_MERGE_ENGINE=${process.env.DOCUMENT_MERGE_ENGINE} — verification chỉ chạy khi engine vẫn là GOOGLE_DOCS.`,
    };
  }

  return { safe: true };
}

/** Guard: kiểm tra fixture trước khi render. */
export function assertFixtureSafe(fieldValues: Record<string, string>): { safe: boolean; reason?: string } {
  if (containsRealPii(fieldValues)) {
    return {
      safe: false,
      reason: "Fixture chứa PII thật — KHÔNG được phép dùng trong verification.",
    };
  }
  return { safe: true };
}

/** Metadata đánh dấu artifact là NON-PRODUCTION. */
export interface NonProductionMarker {
  nonProduction: true;
  environment: string;
  engine: string;
  generatedAt: string;
  disclaimer: string;
}

/** Tạo marker NON-PRODUCTION cho artifact. */
export function createNonProductionMarker(): NonProductionMarker {
  return {
    nonProduction: true,
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
    engine: process.env.DOCUMENT_MERGE_ENGINE ?? "GOOGLE_DOCS",
    generatedAt: new Date().toISOString(),
    disclaimer:
      "Đây là artifact verification NON-PRODUCTION. KHÔNG dùng cho mục đích nghiệp vụ. Dữ liệu là fixture giả, KHÔNG phải candidate thật.",
  };
}
