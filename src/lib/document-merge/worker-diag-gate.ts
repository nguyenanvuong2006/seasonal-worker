/**
 * Document Merge — worker /diag/* endpoint gate.
 *
 * /diag/db-identity, /diag/claim-probe, /diag/claim-existing được thêm cho
 * điều tra CLAIM_STALLED trên STAGING — chúng seed/xoá job+item thật (dù có
 * cleanup) và trả về DB identity (hostname, current_database). Trước khi có
 * production worker, endpoint này CHỈ tồn tại trên staging (secret-gated qua
 * isAuthorized() như /run) — nhưng khi production worker được deploy bằng
 * CÙNG source code, các endpoint này sẽ tồn tại ở đó nữa nếu không có gate
 * riêng. Module THUẦN (không import server-only/DB) để Cloud Run worker (Node
 * thuần) và bộ test (`node --test`) đều dùng được — theo đúng pattern
 * queue-types.ts (pure functions, test tại đây thay vì trong worker/src/
 * vốn không có hạ tầng test).
 *
 * WORKER_ENV=production tắt các endpoint /diag/* (404 — không tiết lộ cả sự
 * tồn tại của endpoint, mạnh hơn 403). Không set (hoặc bất kỳ giá trị nào
 * khác) → giữ nguyên hành vi hiện tại (bật, vẫn yêu cầu app secret qua
 * isAuthorized() — xem worker/src/index.ts).
 */

const DIAG_PATH_PREFIX = "/diag/";

export function isDiagnosticPath(pathname: string): boolean {
  return pathname.startsWith(DIAG_PATH_PREFIX);
}

export function isDiagnosticsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.WORKER_ENV !== "production";
}

/** true nếu request tới `pathname` phải bị chặn (404) vì đây là path /diag/* trên production worker. */
export function shouldBlockDiagnosticRequest(
  pathname: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isDiagnosticPath(pathname) && !isDiagnosticsEnabled(env);
}
