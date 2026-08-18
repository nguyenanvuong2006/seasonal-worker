"use client";

/**
 * Document Merge — Verification Panel (cloud-only, Admin).
 *
 * Các nút:
 *   Check Database · Check Worker · Check Google Drive
 *   Run 1-record Test · Run 10-record Test
 *   Run Visual Verification (upload reference PDF) · Run Benchmark
 *
 * Chỉ hiển thị khi VERIFICATION_ENABLED=true (non-production).
 * Không cho nhập arbitrary command/HTML/URL — chỉ các giá trị cố định.
 * Không expose secrets.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  Database,
  FileUp,
  Gauge,
  Loader2,
  Play,
  Server,
  ShieldCheck,
  XCircle,
} from "lucide-react";

type Status = "idle" | "running" | "pass" | "fail";

type GateRow = { key: string; label: string; status: Status; detail?: string };

function GateBadge({ status }: { status: Status }) {
  if (status === "pass") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-0.5 text-[11px] font-bold text-emerald-700">
        <CheckCircle2 className="h-3 w-3" /> PASS
      </span>
    );
  }
  if (status === "fail") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2.5 py-0.5 text-[11px] font-bold text-red-700">
        <XCircle className="h-3 w-3" /> FAIL
      </span>
    );
  }
  if (status === "running") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-sky-100 px-2.5 py-0.5 text-[11px] font-bold text-sky-700">
        <Loader2 className="h-3 w-3 animate-spin" /> RUNNING
      </span>
    );
  }
  return <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-[11px] font-semibold text-slate-400">—</span>;
}

export function VerificationPanel() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  const [gates, setGates] = useState<GateRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/document-merge/verification/status", { cache: "no-store" });
      const data = await res.json();
      if (res.ok) {
        setEnabled(true);
        setConfig(data);
      } else {
        setEnabled(false);
        setError(data.error || "Verification disabled.");
      }
    } catch {
      setEnabled(false);
      setError("Không gọi được verification status API.");
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const setGate = (key: string, label: string, status: Status, detail?: string) => {
    setGates((prev) => {
      const next = prev.filter((g) => g.key !== key);
      next.push({ key, label, status, detail });
      return next;
    });
  };

  const runAction = async (key: string, label: string, url: string, init?: RequestInit) => {
    setBusy(key);
    setError(null);
    setGate(key, label, "running");
    try {
      const res = await fetch(url, init ?? { method: "POST" });
      const data = await res.json();
      const pass = Boolean(data.pass);
      setGate(key, label, pass ? "pass" : "fail", data.error ?? undefined);
      setResults((prev) => ({ ...(prev ?? {}), [key]: data }));
    } catch (err) {
      setGate(key, label, "fail", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const runVisual = async (file: File) => {
    setBusy("visual");
    setError(null);
    setGate("visual", "VISUAL", "running");
    try {
      const form = new FormData();
      form.append("reference", file);
      const res = await fetch("/api/document-merge/verification/visual", { method: "POST", body: form });
      const data = await res.json();
      const pass = Boolean(data.pass);
      setGate("visual", "VISUAL", pass ? "pass" : "fail", data.error ?? undefined);
      setResults((prev) => ({ ...(prev ?? {}), visual: data }));
    } catch (err) {
      setGate("visual", "VISUAL", "fail", err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const requiredGates = ["DATABASE", "CLOUD_RUN", "GOOGLE_DRIVE", "1_RECORD", "10_RECORD", "VISUAL", "BENCHMARK"];
  const productionReady =
    gates.length >= requiredGates.length &&
    requiredGates.every((k) => gates.find((g) => g.key === k)?.status === "pass");

  if (enabled === false) {
    return (
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-800">
        <ShieldCheck className="inline h-5 w-5" /> Verification chỉ khả dụng ở môi trường
        non-production với <code className="rounded bg-amber-100 px-1">VERIFICATION_ENABLED=true</code>.
        {error && <p className="mt-1 text-xs">{error}</p>}
      </div>
    );
  }
  if (enabled === null) {
    return <div className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-500">Đang kiểm tra trạng thái verification...</div>;
  }

  const btn = (key: string, label: string, icon: React.ReactNode, url: string, init?: RequestInit) => (
    <button
      key={key}
      disabled={busy !== null}
      onClick={() => void runAction(key, label, url, init)}
      className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50"
    >
      {busy === key ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      {label}
    </button>
  );

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-slate-200/80 bg-white p-4 text-xs text-slate-600">
        <p>
          <b>Engine:</b> <code>{String(config?.engine)}</code> · <b>Worker:</b>{" "}
          {config?.workerConfigured ? "đã cấu hình" : "CHƯA cấu hình"} · <b>Storage:</b>{" "}
          <code>{String(config?.storageProvider)}</code> · <b>Env:</b> <code>{String(config?.vercelEnv)}</code>
        </p>
        <p className="mt-1 text-[11px] text-slate-400">
          Tất cả chạy trên CLOUD (Cloud Run/Chromium) — máy bạn không cần cài gì. Không nhập arbitrary input; chỉ các giá trị cố định.
        </p>
      </div>

      {/* Activation gate */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5">
        <h3 className="text-sm font-bold text-slate-900">Activation Gate</h3>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {[
            ["DATABASE", "Database"],
            ["CLOUD_RUN", "Cloud Run"],
            ["GOOGLE_DRIVE", "Google Drive"],
            ["1_RECORD", "1-record E2E"],
            ["10_RECORD", "10-record E2E"],
            ["VISUAL", "Visual"],
            ["BENCHMARK", "Benchmark"],
          ].map(([key, label]) => {
            const gate = gates.find((g) => g.key === key);
            return (
              <div key={key} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
                <span className="text-xs font-semibold text-slate-700">{label}</span>
                <GateBadge status={gate?.status ?? "idle"} />
              </div>
            );
          })}
        </div>
        <div
          className={`mt-3 rounded-xl px-4 py-3 text-sm font-bold ${
            productionReady ? "bg-emerald-50 text-emerald-800" : "bg-slate-100 text-slate-500"
          }`}
        >
          PRODUCTION READY: {productionReady ? "✅ TẤT CẢ GATES PASS" : "⏳ Chưa đạt — cần tất cả required gates PASS"}
        </div>
        <p className="mt-1 text-[11px] text-slate-400">
          Lưu ý: production engine vẫn <code>GOOGLE_DOCS</code> — gates ở đây chỉ cho STAGING/verification.
        </p>
      </div>

      {/* Actions */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5">
        <h3 className="text-sm font-bold text-slate-900">Cloud Verification Actions</h3>
        <div className="mt-3 flex flex-wrap gap-2">
          {btn("DATABASE", "Check Database", <Database className="h-4 w-4" />, "/api/document-merge/verification/check-db")}
          {btn("CLOUD_RUN", "Check Worker", <Server className="h-4 w-4" />, "/api/document-merge/verification/check-worker")}
          {btn("GOOGLE_DRIVE", "Check Google Drive", <ShieldCheck className="h-4 w-4" />, "/api/document-merge/verification/check-drive")}
          {btn("1_RECORD", "Run 1-record Test", <Play className="h-4 w-4" />, "/api/document-merge/verification/run-test", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ records: 1 }),
          })}
          {btn("10_RECORD", "Run 10-record Test", <Play className="h-4 w-4" />, "/api/document-merge/verification/run-test", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ records: 10 }),
          })}
          <button
            disabled={busy !== null}
            onClick={() => fileRef.current?.click()}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50"
          >
            {busy === "visual" ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileUp className="h-4 w-4" />}
            Run Visual Verification (upload reference PDF)
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void runVisual(f);
            }}
          />
          {btn("BENCHMARK", "Run Benchmark (1/10/50/100)", <Gauge className="h-4 w-4" />, "/api/document-merge/verification/benchmark", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ counts: [1, 10, 50, 100] }),
          })}
        </div>
        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      </div>

      {/* Latest result JSON */}
      {results && (
        <div className="rounded-2xl border border-slate-200 bg-white p-5">
          <h3 className="text-sm font-bold text-slate-900">Kết quả mới nhất</h3>
          <pre className="mt-2 max-h-96 overflow-auto rounded-xl bg-slate-900 p-3 font-mono text-[10px] leading-relaxed text-slate-100">
            {JSON.stringify(results, null, 2) as string}
          </pre>
          {Boolean(results.visual) && (
            <div className="mt-2 flex flex-wrap gap-2">
              {(results.visual as { renderedPdfDownloadUrl?: string }).renderedPdfDownloadUrl && (
                <a
                  href={(results.visual as { renderedPdfDownloadUrl: string }).renderedPdfDownloadUrl}
                  download="rendered.pdf"
                  className="rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-800"
                >
                  Tải rendered.pdf
                </a>
              )}
              {(results.visual as { referenceFileName?: string }).referenceFileName && (
                <span className="self-center text-[11px] text-slate-500">
                  Reference: {(results.visual as { referenceFileName: string }).referenceFileName}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
