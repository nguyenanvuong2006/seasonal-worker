/* ============================================================
   API CLIENT — production-grade fetch wrapper (PHASE 8)
   ------------------------------------------------------------
   Single helper to replace 30+ ad-hoc `fetch().then().catch()` calls
   scattered across pages and routes.

   CAPABILITIES
   - Timeout via AbortController (default 12s, override per call).
   - Stale-request cancellation via caller-provided AbortSignal.
   - Safe JSON parse (HTML 500 page → normalized ApiError, never a SyntaxError).
   - Structured ApiError with stable `code` for ErrorState UIs.
   - DurationMs for SLO / health-check reporting.
   - No secret / URL / stack leakage in messages (caller chooses what to render).

   USAGE (client):
     const r = await fetchJsonWithTimeout<{rows:Row[]}>(`/api/planning?status=ACTIVE`);
     if (r.ok) setRows(r.data.rows);
     else showErrorState(r.code, r.message);

   USAGE (server / route):
     const r = await fetchJsonWithTimeout(`${process.env.INTERNAL_URL}/api/foo`, {
       timeoutMs: 4000,
     });
     if (!r.ok) return NextResponse.json({error: r.message, code: r.code}, {status: r.status ?? 502});
   ============================================================ */

export type ApiErrorCode =
  | "TIMEOUT"
  | "NETWORK"
  | "ABORTED"
  | "PARSE"
  | "HTTP_4XX"
  | "HTTP_5XX"
  | "FORBIDDEN"
  | "UNAUTHORIZED"
  | "EMPTY"
  | "UNKNOWN";

export type ApiSuccess<T> = {
  ok: true;
  status: number;
  data: T;
  durationMs: number;
  headers: Headers;
};

export type ApiFailure = {
  ok: false;
  status: number | null;
  code: ApiErrorCode;
  message: string;
  /** Best-effort JSON body (server's own error payload), if parseable. */
  body: Record<string, unknown> | null;
  durationMs: number;
};

export type ApiResult<T> = ApiSuccess<T> | ApiFailure;

export type FetchJsonOptions = {
  /** Hard timeout in ms. Default 12000. */
  timeoutMs?: number;
  /** AbortSignal from caller to cancel stale requests. */
  signal?: AbortSignal;
  /** Request init overrides (method/headers/body). */
  init?: RequestInit;
  /** Tag for logs/health-check. */
  label?: string;
};

const DEFAULT_TIMEOUT_MS = 12_000;

/**
 * fetch() with timeout, structured errors, and safe JSON parsing.
 * NEVER throws; ALWAYS returns a discriminated ApiResult.
 */
export async function fetchJsonWithTimeout<T = unknown>(
  url: string,
  options: FetchJsonOptions = {},
): Promise<ApiResult<T>> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, signal: callerSignal, init, label } = options;
  const started = Date.now();
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal) {
    if (callerSignal.aborted) {
      return {
        ok: false,
        status: null,
        code: "ABORTED",
        message: "Yêu cầu đã bị huỷ trước khi gửi.",
        body: null,
        durationMs: Date.now() - started,
      };
    }
    callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }
  const timeoutId = setTimeout(() => {
    controller.abort(new DOMException("Request timed out", "TimeoutError"));
  }, timeoutMs);

  try {
    const res = await fetch(url, { ...(init ?? {}), signal: controller.signal });
    clearTimeout(timeoutId);
    callerSignal?.removeEventListener("abort", onCallerAbort);

    const durationMs = Date.now() - started;
    const status = res.status;

    // Body parse — defensive: HTML 500 page must not throw.
    let bodyText = "";
    try {
      bodyText = await res.text();
    } catch {
      bodyText = "";
    }
    const parsed = safeJsonParse(bodyText);
    if (!res.ok) {
      return {
        ok: false,
        status,
        code: classifyStatus(status),
        message: extractMessage(parsed, status, label),
        body: parsed,
        durationMs,
      };
    }
    if (parsed == null) {
      return {
        ok: false,
        status,
        code: "PARSE",
        message: "Phản hồi từ máy chủ không phải JSON hợp lệ.",
        body: null,
        durationMs,
      };
    }
    return {
      ok: true,
      status,
      data: parsed as T,
      durationMs,
      headers: res.headers,
    };
  } catch (err) {
    clearTimeout(timeoutId);
    callerSignal?.removeEventListener("abort", onCallerAbort);
    const durationMs = Date.now() - started;
    const e = err as { name?: string; message?: string };
    if (e?.name === "AbortError" || e?.name === "TimeoutError" || controller.signal.aborted) {
      return {
        ok: false,
        status: null,
        code: "TIMEOUT",
        message: `Yêu cầu mất quá ${Math.round(timeoutMs / 1000)} giây — vui lòng thử lại.`,
        body: null,
        durationMs,
      };
    }
    if (e?.name === "AbortError" || (callerSignal?.aborted ?? false)) {
      return {
        ok: false,
        status: null,
        code: "ABORTED",
        message: "Yêu cầu đã bị huỷ.",
        body: null,
        durationMs,
      };
    }
    return {
      ok: false,
      status: null,
      code: "NETWORK",
      message: "Không kết nối được tới máy chủ. Kiểm tra mạng rồi thử lại.",
      body: null,
      durationMs,
    };
  } finally {
    clearTimeout(timeoutId);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}

function classifyStatus(status: number): ApiErrorCode {
  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN";
  if (status >= 500) return "HTTP_5XX";
  if (status >= 400) return "HTTP_4XX";
  return "UNKNOWN";
}

function extractMessage(
  body: Record<string, unknown> | null,
  status: number,
  label: string | undefined,
): string {
  if (body) {
    const candidate = (body as Record<string, unknown>).error ?? (body as Record<string, unknown>).message;
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  if (status === 401) return "Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.";
  if (status === 403) return "Bạn không có quyền truy cập dữ liệu này.";
  if (status === 404) return "Không tìm thấy dữ liệu.";
  if (status >= 500) return `Máy chủ gặp sự cố (HTTP ${status})${label ? ` — ${label}` : ""}. Đã ghi nhận, vui lòng thử lại.`;
  return `Yêu cầu thất bại (HTTP ${status})${label ? ` — ${label}` : ""}.`;
}

function safeJsonParse(text: string): Record<string, unknown> | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed[0] !== "{" && trimmed[0] !== "[") return null;
  try {
    const v = JSON.parse(trimmed);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    return null;
  } catch {
    return null;
  }
}
