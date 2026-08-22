/**
 * Document Merge — worker restricted-path gate.
 *
 * Các endpoint CHỈ tồn tại trên môi trường KHÔNG-production (staging/CI):
 *   - /diag/db-identity, /diag/claim-probe, /diag/claim-existing (điều tra
 *     CLAIM_STALLED trên STAGING — chúng seed/xoá job+item thật, dù có
 *     cleanup, và trả về DB identity: hostname, current_database).
 *   - /run-overlay (PR5): controlled staging E2E cho PDF Overlay renderer —
 *     render qua queue/storage/history THẬT nhưng CHỈ nhận job engine
 *     "PDF_OVERLAY" + snapshot fixture NON-PRODUCTION (xem staging-e2e.ts).
 *
 * Trước khi có production worker, các endpoint này CHỈ tồn tại trên staging
 * (secret-gated qua isAuthorized() như /run) — nhưng khi production worker
 * được deploy bằng CÙNG source code, chúng sẽ tồn tại ở đó nữa nếu không có
 * gate riêng. Module THUẦN (không import server-only/DB) để Cloud Run worker
 * (Node thuần) và bộ test (`node --test`) đều dùng được — theo đúng pattern
 * queue-types.ts (pure functions, test tại đây thay vì trong worker/src/
 * vốn không có hạ tầng test).
 *
 * WORKER_ENV=production tắt các endpoint này (404 — không tiết lộ cả sự
 * tồn tại của endpoint, mạnh hơn 403). Không set (hoặc bất kỳ giá trị nào
 * khác) → giữ nguyên hành vi hiện tại (bật, vẫn yêu cầu app secret qua
 * isAuthorized() — xem worker/src/index.ts).
 */

const DIAG_PATH_PREFIX = "/diag/";
const OVERLAY_E2E_PATH = "/run-overlay";

/** Path /diag/* (điều tra CLAIM_STALLED). */
export function isDiagnosticPath(pathname: string): boolean {
  return pathname.startsWith(DIAG_PATH_PREFIX);
}

/** Path /run-overlay (staging E2E cho PDF Overlay). */
export function isOverlayE2EPath(pathname: string): boolean {
  return pathname === OVERLAY_E2E_PATH;
}

/** Mọi path restricted (chỉ non-production). */
export function isRestrictedWorkerPath(pathname: string): boolean {
  return isDiagnosticPath(pathname) || isOverlayE2EPath(pathname);
}

export function isDiagnosticsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.WORKER_ENV !== "production";
}

/** true nếu request tới `pathname` phải bị chặn (404) vì là path /diag/* trên production worker. */
export function shouldBlockDiagnosticRequest(
  pathname: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isDiagnosticPath(pathname) && !isDiagnosticsEnabled(env);
}

/** true nếu request tới `pathname` phải bị chặn (404) vì là path /run-overlay trên production worker. */
export function shouldBlockOverlayE2ERequest(
  pathname: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isOverlayE2EPath(pathname) && !isDiagnosticsEnabled(env);
}

/** Gate tổng cho mọi restricted path (dùng trong worker HTTP server). */
export function shouldBlockRestrictedWorkerRequest(
  pathname: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isRestrictedWorkerPath(pathname) && !isDiagnosticsEnabled(env);
}
