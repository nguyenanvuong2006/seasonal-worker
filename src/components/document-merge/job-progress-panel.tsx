"use client";

/**
 * Merge Job Progress Panel (Phase 11).
 *
 * - Poll GET /api/document-merge/jobs/[id] mỗi 4 giây (KHÔNG 1s).
 * - Hiển thị: total / completed / processing / queued / failed / cancelled,
 *   progress %, elapsed, ETA (khi có đủ dữ liệu tốc độ).
 * - Actions: Retry failed · Cancel · Download PDF tổng · Download ZIP ·
 *   View individual outputs · View errors (technical details chỉ ADMIN).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock, Download, FileText, Loader2, PauseCircle, RefreshCw, XCircle } from "lucide-react";

export type MergeJobProgressItem = {
  id: string;
  sourceRecordId: string;
  sortOrder: number;
  status: string;
  attemptCount: number;
  pdfUrl: string | null;
  filename?: string | null;
  errorCode: string | null;
  errorMessage: string | null;
};

export type MergeJobProgressData = {
  id: string;
  status: string;
  engine?: string | null;
  templateNameSnapshot?: string | null;
  recordCount?: number;
  createdAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  outputPdfUrl?: string | null;
  outputZipUrl?: string | null;
  /** GOOGLE_DOCS output (Google Doc edit link / merged PDF webViewLink). */
  outputUrl?: string | null;
  batchExpiresAt?: string | null;
  errorSummary?: string | null;
  viewerRole?: string | null;
  progress?: {
    total: number;
    queued: number;
    processing: number;
    completed: number;
    failed: number;
    cancelled: number;
  };
  items: MergeJobProgressItem[];
};

const POLL_INTERVAL_MS = 4000;

function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "00:00";
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function JobProgressPanel({ jobId, onClosed }: { jobId: string; onClosed?: () => void }) {
  const [data, setData] = useState<MergeJobProgressData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // action đang chạy
  const [showOutputs, setShowOutputs] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isAdmin = data?.viewerRole === "ADMIN";

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/document-merge/jobs/${jobId}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Không tải được job.");
      setData(json);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Không tải được job.");
    }
  }, [jobId]);

  useEffect(() => {
    load();
    intervalRef.current = setInterval(load, POLL_INTERVAL_MS);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      clearInterval(tick);
    };
  }, [load]);

  const runAction = async (path: string, label: string) => {
    setBusy(label);
    try {
      const res = await fetch(`/api/document-merge/jobs/${jobId}/${path}`, { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Không ${label.toLowerCase()} được.`);
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : `Không ${label.toLowerCase()} được.`);
    } finally {
      setBusy(null);
    }
  };

  if (!data) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
        <Loader2 className="mx-auto h-5 w-5 animate-spin text-emerald-700" />
        <p className="mt-2">Đang tải tiến độ merge job...</p>
        {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      </div>
    );
  }

  const progress = data.progress ?? {
    total: data.items.length,
    queued: 0,
    processing: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };
  const total = progress.total || data.recordCount || 0;
  const done = progress.completed + progress.failed + progress.cancelled;
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  const isTerminal = ["COMPLETED", "FAILED", "CANCELLED"].includes(data.status);

  const startedAtMs = data.startedAt ? new Date(data.startedAt).getTime() : data.createdAt ? new Date(data.createdAt).getTime() : now;
  const endAtMs = data.completedAt ? new Date(data.completedAt).getTime() : null;
  const elapsedSeconds = ((endAtMs ?? now) - startedAtMs) / 1000;

  // ETA: dựa tốc độ hoàn thành (elapsed / completed × remaining). Chỉ khi đang chạy.
  let etaSeconds: number | null = null;
  if (!isTerminal && progress.completed > 0 && total > done) {
    const perItem = elapsedSeconds / progress.completed;
    etaSeconds = perItem * (total - done);
  }

  const failedItems = data.items.filter((item) => item.status === "FAILED");

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-bold text-slate-900">MERGE JOB</h3>
            <span className={`rounded-full px-2.5 py-0.5 text-[10px] font-bold ${
              data.status === "COMPLETED"
                ? "bg-emerald-100 text-emerald-700"
                : data.status === "FAILED"
                  ? "bg-red-100 text-red-700"
                  : data.status === "CANCELLED"
                    ? "bg-slate-200 text-slate-600"
                    : "bg-sky-100 text-sky-700"
            }`}>
              {data.status}
            </span>
            {data.engine && (
              <span className="rounded-full bg-slate-100 px-2.5 py-0.5 font-mono text-[10px] text-slate-500">{data.engine}</span>
            )}
            <span className="font-mono text-[10px] text-slate-400">{jobId.slice(0, 8)}</span>
          </div>
          <p className="mt-1 truncate text-xs text-slate-500">{data.templateNameSnapshot || "Merge"}</p>
        </div>
        {!isTerminal && (
          <button
            onClick={() => runAction("cancel", "Cancel")}
            disabled={busy !== null}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-[11px] font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50"
          >
            <PauseCircle className="h-3.5 w-3.5" /> Cancel
          </button>
        )}
      </div>

      {/* Progress bar */}
      <div className="mt-4">
        <div className="flex items-baseline justify-between">
          <span className="text-2xl font-black text-slate-900">
            {progress.completed} <span className="text-sm font-semibold text-slate-400">/ {total}</span>
          </span>
          <span className="text-sm font-bold text-emerald-700">{percent}%</span>
        </div>
        <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-slate-100">
          <div
            className={`h-full rounded-full transition-all duration-500 ${
              data.status === "FAILED" ? "bg-red-500" : data.status === "CANCELLED" ? "bg-slate-400" : "bg-emerald-600"
            }`}
            style={{ width: `${Math.min(100, percent)}%` }}
          />
        </div>
      </div>

      {/* Counts */}
      <div className="mt-4 grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-3">
        <div className="rounded-lg bg-slate-50 px-3 py-2">
          <span className="text-slate-400">Completed</span>
          <p className="text-sm font-bold text-emerald-700">{progress.completed}</p>
        </div>
        <div className="rounded-lg bg-slate-50 px-3 py-2">
          <span className="text-slate-400">Processing</span>
          <p className="text-sm font-bold text-sky-700">{progress.processing}</p>
        </div>
        <div className="rounded-lg bg-slate-50 px-3 py-2">
          <span className="text-slate-400">Queued</span>
          <p className="text-sm font-bold text-slate-700">{progress.queued}</p>
        </div>
        <div className="rounded-lg bg-slate-50 px-3 py-2">
          <span className="text-slate-400">Failed</span>
          <p className="text-sm font-bold text-red-600">{progress.failed}</p>
        </div>
        <div className="rounded-lg bg-slate-50 px-3 py-2">
          <span className="text-slate-400">Cancelled</span>
          <p className="text-sm font-bold text-slate-500">{progress.cancelled}</p>
        </div>
        <div className="rounded-lg bg-slate-50 px-3 py-2">
          <span className="text-slate-400">Elapsed</span>
          <p className="flex items-center gap-1 text-sm font-bold text-slate-700">
            <Clock className="h-3.5 w-3.5 text-slate-400" /> {formatDuration(elapsedSeconds)}
          </p>
        </div>
      </div>

      {etaSeconds !== null && !isTerminal && (
        <p className="mt-2 text-[11px] text-slate-500">
          ETA: <span className="font-bold text-slate-700">{formatDuration(etaSeconds)}</span> (ước tính theo tốc độ hiện tại)
        </p>
      )}
      {data.batchExpiresAt && (
        <p className="mt-1 text-[10px] text-slate-400">
          PDF tổng/ZIP tạm thời — tự xoá sau {new Date(data.batchExpiresAt).toLocaleString("vi-VN")}
        </p>
      )}
      {data.errorSummary && (
        <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-red-50 p-2 text-[11px] text-red-700">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {data.errorSummary}
        </p>
      )}

      {/* Actions */}
      <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-100 pt-3">
        {progress.failed > 0 && !isTerminal && (
          <button
            onClick={() => runAction("retry", "Retry failed")}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-[11px] font-bold text-white hover:bg-amber-700 disabled:opacity-50"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Retry failed ({progress.failed})
          </button>
        )}
        {data.outputUrl && (
          <a
            href={data.outputUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-3 py-1.5 text-[11px] font-bold text-white hover:bg-emerald-800"
          >
            <FileText className="h-3.5 w-3.5" /> Mở Google Doc
          </a>
        )}
        {data.outputPdfUrl && (
          <a
            href={data.outputPdfUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-3 py-1.5 text-[11px] font-bold text-white hover:bg-emerald-800"
          >
            <Download className="h-3.5 w-3.5" /> PDF tổng
          </a>
        )}
        {data.outputZipUrl && (
          <a
            href={data.outputZipUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-[11px] font-bold text-emerald-700 hover:bg-emerald-100"
          >
            <FileText className="h-3.5 w-3.5" /> ZIP
          </a>
        )}
        <button
          onClick={() => setShowOutputs((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-[11px] font-semibold text-slate-600 hover:bg-slate-50"
        >
          <CheckCircle2 className="h-3.5 w-3.5" /> Individual outputs
        </button>
        {failedItems.length > 0 && (
          <button
            onClick={() => setShowErrors((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-1.5 text-[11px] font-semibold text-red-600 hover:bg-red-50"
          >
            <XCircle className="h-3.5 w-3.5" /> Errors ({failedItems.length})
          </button>
        )}
        {onClosed && (
          <button onClick={onClosed} className="ml-auto text-[11px] font-semibold text-slate-400 hover:text-slate-600">
            Đóng
          </button>
        )}
      </div>

      {/* Individual outputs */}
      {showOutputs && (
        <div className="mt-3 max-h-64 overflow-y-auto rounded-xl border border-slate-200">
          <table className="w-full text-left text-[11px]">
            <thead className="sticky top-0 bg-slate-50 text-slate-500">
              <tr>
                <th className="px-3 py-2">#</th>
                <th className="px-3 py-2">Hồ sơ</th>
                <th className="px-3 py-2">Trạng thái</th>
                <th className="px-3 py-2">File</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.items.map((item) => (
                <tr key={item.id} className={item.status === "FAILED" ? "bg-red-50/50" : ""}>
                  <td className="px-3 py-1.5 font-mono text-slate-400">{String(item.sortOrder).padStart(3, "0")}</td>
                  <td className="max-w-[160px] truncate px-3 py-1.5 font-mono text-[10px] text-slate-600">{item.sourceRecordId.slice(0, 8)}</td>
                  <td className="px-3 py-1.5">
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${
                      item.status === "COMPLETED"
                        ? "bg-emerald-100 text-emerald-700"
                        : item.status === "FAILED"
                          ? "bg-red-100 text-red-700"
                          : item.status === "PROCESSING"
                            ? "bg-sky-100 text-sky-700"
                            : "bg-slate-100 text-slate-500"
                    }`}>
                      {item.status}
                    </span>
                    {item.attemptCount > 1 && <span className="ml-1 text-[9px] text-slate-400">×{item.attemptCount}</span>}
                  </td>
                  <td className="px-3 py-1.5">
                    {item.pdfUrl ? (
                      <a href={item.pdfUrl} target="_blank" rel="noreferrer" className="font-semibold text-emerald-700 hover:underline">
                        {item.filename || "PDF"}
                      </a>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Errors — HR thấy mã + mô tả ngắn; technical details chỉ ADMIN */}
      {showErrors && failedItems.length > 0 && (
        <div className="mt-3 space-y-2">
          {failedItems.map((item) => (
            <div key={item.id} className="rounded-lg border border-red-100 bg-red-50/50 p-2.5 text-[11px]">
              <p className="font-semibold text-red-700">
                #{String(item.sortOrder).padStart(3, "0")} · {item.errorCode || "ERROR"}
              </p>
              <p className="mt-0.5 text-red-600">{item.errorMessage || ""}</p>
              {isAdmin && item.errorMessage && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-[10px] text-slate-500">Chi tiết kỹ thuật (Admin)</summary>
                  <pre className="mt-1 max-h-32 overflow-auto rounded bg-slate-900 p-2 font-mono text-[10px] text-slate-100">
                    {item.errorMessage}
                  </pre>
                </details>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
