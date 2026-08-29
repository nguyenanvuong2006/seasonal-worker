/**
 * Document Merge — stage timing instrumentation (safe, no PII).
 *
 * Records wall-clock duration of each merge stage so a stuck/slow job can be
 * diagnosed as "waiting in queue" vs "Google API" vs "render" vs "persist",
 * instead of an opaque "PROCESSING 0%".
 *
 * SAFETY: stage names only — NEVER candidate names/CCCD/document contents,
 * tokens, or URLs with credentials. Counts and milliseconds are safe.
 *
 * Usage:
 *   const t = new MergeStageTimer(jobId);
 *   const data = await t.measure("DATA_LOAD", () => load());
 *   ...
 *   const summary = t.summary(); // → { QUEUE_WAIT_MS, DATA_LOAD_MS, ... }
 */

export type MergeStage =
  | "QUEUE_WAIT"
  | "DATA_LOAD"
  | "MAPPING_RESOLVE"
  | "DOCUMENT_RENDER"
  | "GOOGLE_API"
  | "DRIVE_PDF"
  | "OUTPUT_SAVE";

export interface MergeStageTiming {
  QUEUE_WAIT_MS?: number;
  DATA_LOAD_MS?: number;
  MAPPING_MS?: number;
  RENDER_MS?: number;
  GOOGLE_API_MS?: number;
  OUTPUT_SAVE_MS?: number;
  TOTAL_MS?: number;
}

export class MergeStageTimer {
  private readonly marks: Partial<Record<MergeStage, number>> = {};
  private readonly startedAt = Date.now();
  private readonly jobId: string;

  constructor(jobId: string) {
    this.jobId = jobId;
  }

  /** Run `fn` and record how long it took for `stage`. */
  async measure<T>(stage: MergeStage, fn: () => Promise<T>): Promise<T> {
    const t0 = Date.now();
    try {
      return await fn();
    } finally {
      this.marks[stage] = (this.marks[stage] ?? 0) + (Date.now() - t0);
    }
  }

  /** Record a standalone duration (e.g. queue wait) directly. */
  set(stage: MergeStage, ms: number): void {
    this.marks[stage] = ms;
  }

  /**
   * Aggregate into the naming used in the incident report. GOOGLE_API covers
   * Docs copy/replace; DRIVE_PDF (PDF export + Drive upload) rolls into the
   * GOOGLE_API_MS bucket for the one-number summary but is kept separately too.
   */
  summary(): MergeStageTiming {
    const googleApi = (this.marks.GOOGLE_API ?? 0) + (this.marks.DRIVE_PDF ?? 0);
    return {
      QUEUE_WAIT_MS: this.marks.QUEUE_WAIT ?? 0,
      DATA_LOAD_MS: this.marks.DATA_LOAD ?? 0,
      MAPPING_MS: this.marks.MAPPING_RESOLVE ?? 0,
      RENDER_MS: this.marks.DOCUMENT_RENDER ?? 0,
      GOOGLE_API_MS: googleApi,
      OUTPUT_SAVE_MS: this.marks.OUTPUT_SAVE ?? 0,
      TOTAL_MS: Date.now() - this.startedAt,
    };
  }

  /** Structured, PII-free console log line. */
  log(event: string, extra: Record<string, unknown> = {}): void {
    console.log(
      JSON.stringify({
        event,
        jobId: this.jobId,
        ...this.summary(),
        ...extra,
      }),
    );
  }
}

/**
 * fetch() with a hard timeout. The legacy Google Docs path called fetch with
 * NO AbortController — a hung Google connection (token endpoint, Docs
 * batchUpdate, Drive export) could block the serverless function until the
 * platform hard-killed it, leaving job RUNNING + items PENDING forever with no
 * error written. A bounded abort turns a silent hang into a caught, visible
 * failure (the route's catch marks the job FAILED).
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 30_000,
): Promise<Response> {
  // Respect an externally-provided signal (abort the whole merge request) but
  // always enforce our own hard ceiling so a hung Google endpoint cannot block
  // the serverless function until the platform hard-kills it.
  const externalSignal = options.signal;
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort(externalSignal?.reason);
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

  const timer = setTimeout(
    () => controller.abort(new Error(`Google API request timed out after ${timeoutMs}ms (${url.slice(0, 60)}…).`)),
    timeoutMs,
  );
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    // Our timer aborts with a descriptive reason; surface it verbatim.
    if (controller.signal.aborted && !externalSignal?.aborted) {
      const reason = controller.signal.reason;
      if (reason instanceof Error) throw reason;
      throw new Error(`Google API request timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener("abort", onExternalAbort);
  }
}
