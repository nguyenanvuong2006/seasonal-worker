/* ============================================================
   useAsyncPageState — chuẩn hóa LOADING/SUCCESS/EMPTY/ERROR/TIMEOUT/FORBIDDEN
   ------------------------------------------------------------
   Thay thế pattern:
     const [loading,setLoading]=useState(true);
     const [data,setData]=useState(null);
     const [error,setError]=useState(null);
     useEffect(() => { fetch(...).then(...).catch(...) }, [deps]);

   Bằng 1 hook:
     const state = useAsyncPageState<Row[]>({ url: '/api/x', deps: [...] });
     if (state.kind === 'loading') return <Skeleton />;
     if (state.kind === 'error')    return <ErrorState ... />;
     if (state.kind === 'empty')    return <EmptyState ... />;
     return <Table rows={state.data} />;

   - Tự huỷ request cũ khi deps đổi (AbortController).
   - Tự áp dụng timeout qua fetchJsonWithTimeout (12s mặc định).
   - Cung cấp `reload()` để bind nút "Thử lại".
   - Không bao giờ để loading=true vĩnh viễn: timeout hoặc error đều set state.
   ============================================================ */

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchJsonWithTimeout,
  type ApiErrorCode,
  type ApiResult,
} from "@/lib/api-client";

export type AsyncPageStateKind =
  | "idle"
  | "loading"
  | "success"
  | "empty"
  | "error";

export type AsyncPageState<T> = {
  kind: AsyncPageStateKind;
  data: T | null;
  error: { code: ApiErrorCode; message: string; status: number | null } | null;
  durationMs: number | null;
  reload: () => void;
  /** Tick state to force a re-fetch via `reload()`. */
  refreshTick: number;
};

export type UseAsyncPageStateOptions<T> = {
  url: string | null;
  /** Dependency list — re-fetch when any entry changes (use stable references). */
  deps?: ReadonlyArray<unknown>;
  /** Map parsed JSON to the page data. Return null/undefined to treat as empty. */
  pick?: (raw: unknown) => T | null | undefined;
  /** Hard timeout in ms. Default 12000. */
  timeoutMs?: number;
  /** Request init overrides. */
  init?: RequestInit;
  /** Auto-fetch on mount/deps change. Default true. */
  autoLoad?: boolean;
};

const EMPTY_ERROR = null;

export function useAsyncPageState<T>(options: UseAsyncPageStateOptions<T>): AsyncPageState<T> {
  const { url, timeoutMs, autoLoad = true } = options;
  // Keep pick/init as refs so the effect can read the latest values without
  // putting them in the dep array (which would re-run fetch on every render).
  const pickRef = useRef(options.pick);
  const initRef = useRef(options.init);

  const [state, setState] = useState<Omit<AsyncPageState<T>, "reload" | "refreshTick">>({
    kind: "idle",
    data: null,
    error: EMPTY_ERROR,
    durationMs: null,
  });
  const [refreshTick, setRefreshTick] = useState(0);
  const inFlightRef = useRef<AbortController | null>(null);

  const reload = useCallback(() => setRefreshTick((n) => n + 1), []);

  // Build a stable key string for the user's deps to avoid re-running on identity changes.
  const depsKey = useDepsKey(options.deps);

  useEffect(() => {
    if (!autoLoad) return;
    if (url == null) {
      setState({ kind: "idle", data: null, error: EMPTY_ERROR, durationMs: null });
      return;
    }

    inFlightRef.current?.abort();
    const controller = new AbortController();
    inFlightRef.current = controller;
    setState((s) => ({ ...s, kind: "loading", error: EMPTY_ERROR }));

    let cancelled = false;
    void (async () => {
      const r: ApiResult<unknown> = await fetchJsonWithTimeout(url, {
        signal: controller.signal,
        timeoutMs,
        init: initRef.current,
        label: url,
      });
      if (cancelled || controller.signal.aborted) return;

      if (r.ok) {
        const data = pickRef.current ? pickRef.current(r.data) : ((r.data as T) ?? null);
        const isEmpty =
          data == null ||
          (Array.isArray(data) && data.length === 0) ||
          (typeof data === "object" &&
            data !== null &&
            "rows" in (data as Record<string, unknown>) &&
            Array.isArray((data as Record<string, unknown>).rows) &&
            ((data as Record<string, unknown>).rows as unknown[]).length === 0);
        setState({
          kind: isEmpty ? "empty" : "success",
          data: (data ?? null) as T | null,
          error: EMPTY_ERROR,
          durationMs: r.durationMs,
        });
        return;
      }
      setState({
        kind: "error",
        data: null,
        error: { code: r.code, message: r.message, status: r.status },
        durationMs: r.durationMs,
      });
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [url, refreshTick, timeoutMs, autoLoad, depsKey]);

  return { ...state, reload, refreshTick };
}

function useDepsKey(deps: ReadonlyArray<unknown> | undefined): string {
  return useMemo(() => {
    if (!deps) return "";
    try {
      return JSON.stringify(deps);
    } catch {
      // Fallback for circular structures: just hash the length.
      return String(deps.length);
    }
  }, [deps]);
}
