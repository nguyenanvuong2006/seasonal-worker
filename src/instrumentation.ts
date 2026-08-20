export async function register() {
  // register() được Next.js build ra 2 bundle RIÊNG — 1 cho Node.js runtime, 1
  // cho Edge runtime — bất kể app có route/middleware nào chạy Edge hay không
  // (Next.js luôn dựng sẵn variant Edge cho instrumentation.ts). Dynamic
  // import() KHÔNG đủ để loại code khỏi bundle Edge — Turbopack/webpack vẫn
  // static-analyze theo target đang build, và google-docs-service.ts /
  // batch-format-preserver.ts import "node:crypto" (Node-only, không có trong
  // Edge runtime) → build fail/warning "not supported in the Edge Runtime".
  //
  // Next.js xử lý ĐẶC BIỆT cho đúng trường hợp này: khi build variant Edge của
  // instrumentation.ts, code trong nhánh `if (process.env.NEXT_RUNTIME ===
  // "nodejs")` bị dead-code-eliminate hoàn toàn (không chỉ skip lúc runtime)
  // — đây là pattern CHÍNH THỨC của Next.js cho instrumentation.ts (khác biệt
  // NEXT_RUNTIME ở nơi khác trong app, vốn có thể không đáng tin cậy — nhưng
  // trong CHÍNH instrumentation.ts, Next.js đảm bảo biến này luôn có giá trị
  // "nodejs" | "edge" vì đây là input cho chính cơ chế build-tách-bundle đó).
  // Xem: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Node-only — KHÔNG được phép xuất hiện trong Edge bundle (xem guard ở trên).
  // Batch patch phải được cài TRƯỚC khi Document Merge route tạo Google Docs
  // service; nếu không, createDocument() sẽ rơi vào nhánh an toàn
  // FORMAT_PRESERVING_BATCH_REQUIRED (không phải lỗi, nhưng mất tối ưu).
  const { installGoogleDocsRateLimitGuard } = await import("@/lib/document-merge/docs-rate-limit-guard");
  installGoogleDocsRateLimitGuard();

  const { installFormatPreservingBatchPatch } = await import("@/lib/document-merge/batch-format-preserver");
  installFormatPreservingBatchPatch();
}
