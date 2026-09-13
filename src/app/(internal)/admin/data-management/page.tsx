"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertPanel, Badge, Button, Card, EmptyState, ErrorState, Input, Modal, PageHeader, SkeletonTable, toast } from "@/components/ui";
import { AlertTriangle, Database, Fingerprint, History, LayoutDashboard, Lock } from "lucide-react";

type ResetScope = "IT_CODE" | "RECRUITMENT_OPERATIONS" | "PLANNING" | "WORKFORCE" | "ALL_BUSINESS_DATA";

const SCOPE_LABELS: Record<ResetScope, string> = {
  IT_CODE: "Mã IT / Mã số công nhật",
  RECRUITMENT_OPERATIONS: "Tuyển dụng vận hành",
  PLANNING: "Planning allocations",
  WORKFORCE: "Workforce / DW",
  ALL_BUSINESS_DATA: "Tất cả dữ liệu nghiệp vụ (Factory Reset)",
};

type Summary = {
  environment: string;
  resetAllowed: boolean;
  resetBlockedReason: string | null;
  currentDatasets: { importType: string; datasetMode: string | null; sourceFilename: string | null; importedAt: string | null; rowCount: number | null }[];
  quickCounts: { dwDataRows: number; workerProfileRows: number; activeEmploymentSessions: number };
  scopes: { scope: ResetScope; label: string; domainCount: number }[];
};

type ResetPreview = {
  effectiveScopes: ResetScope[];
  affected: { domain: string; label: string; rows: number }[];
  preserved: string[];
  warnings: string[];
  requiredConfirmationPhrase: string;
  previewToken: string;
  expiresAt: string;
};

const TABS = [
  { key: "overview", label: "Tổng quan", icon: LayoutDashboard },
  { key: "workforce", label: "Import DW", icon: Database },
  { key: "fingerprint", label: "IT Code", icon: Fingerprint },
  { key: "reset", label: "Reset dữ liệu", icon: AlertTriangle },
  { key: "history", label: "Lịch sử", icon: History },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export default function DataManagementPage() {
  const [tab, setTab] = useState<TabKey>("overview");
  return (
    <div className="space-y-4">
      <PageHeader title="Quản lý dữ liệu" description="Preview/Reset dữ liệu nghiệp vụ (TEST) + import lại Master DW / IT Code. Thao tác huỷ hoại — luôn có Preview + xác nhận gõ tay trước khi thực thi." />
      <div className="flex flex-wrap gap-2 border-b border-border pb-2">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex items-center gap-1.5 rounded-[10px] px-3 py-1.5 text-[13px] font-medium transition-colors ${tab === t.key ? "bg-primary-tint text-primary" : "text-fg-secondary hover:bg-botanical-50"}`}
          >
            <t.icon className="h-4 w-4" /> {t.label}
          </button>
        ))}
      </div>
      {tab === "overview" ? <OverviewTab /> : null}
      {tab === "workforce" ? <ImportTab kind="workforce" /> : null}
      {tab === "fingerprint" ? <ImportTab kind="fingerprint" /> : null}
      {tab === "reset" ? <ResetTab /> : null}
      {tab === "history" ? <HistoryTab /> : null}
    </div>
  );
}

function OverviewTab() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/data-management/summary");
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? data.error ?? "Không tải được tổng quan.");
        return;
      }
      setSummary(data);
    } catch {
      setError("Không kết nối được máy chủ.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <SkeletonTable rows={6} cols={2} />;
  if (error) return <ErrorState description={error} onRetry={() => void load()} />;
  if (!summary) return null;

  return (
    <div className="space-y-4">
      <AlertPanel
        tone={summary.resetAllowed ? "info" : "success"}
        icon={<Lock className="h-4 w-4" />}
        title={`Môi trường: ${summary.environment}`}
      >
        {summary.resetAllowed ? "Reset dữ liệu huỷ hoại ĐANG được phép ở môi trường này (theo quyền hạn)." : `Reset dữ liệu trên môi trường này hiện đang bị khóa. ${summary.resetBlockedReason ?? ""}`}
      </AlertPanel>

      <Card className="p-5">
        <h3 className="mb-3 text-[14px] font-semibold text-fg">Kích thước dữ liệu hiện tại</h3>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <NumberBox label="DW Data" value={summary.quickCounts.dwDataRows} />
          <NumberBox label="Worker Profiles" value={summary.quickCounts.workerProfileRows} />
          <NumberBox label="Employment Sessions" value={summary.quickCounts.activeEmploymentSessions} />
        </div>
      </Card>

      <Card className="p-5">
        <h3 className="mb-3 text-[14px] font-semibold text-fg">Dataset hiện tại (batch import gần nhất đã hoàn tất)</h3>
        <div className="space-y-2">
          {summary.currentDatasets.map((d) => (
            <div key={d.importType} className="flex items-center justify-between rounded-[10px] border border-border p-3 text-[13px]">
              <div>
                <span className="font-semibold">{d.importType === "WORKFORCE_MASTER" ? "Master DW" : "IT Code"}</span>
                {d.sourceFilename ? <span className="ml-2 text-fg-muted">{d.sourceFilename}</span> : <span className="ml-2 text-fg-muted">Chưa có batch nào hoàn tất</span>}
              </div>
              {d.datasetMode ? <Badge tone={d.datasetMode === "OFFICIAL" ? "green" : "amber"}>{d.datasetMode}</Badge> : null}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function NumberBox({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-[10px] border border-border bg-surface-2 p-3">
      <div className="text-[20px] font-bold text-fg">{value.toLocaleString("vi-VN")}</div>
      <div className="text-[11px] text-fg-muted">{label}</div>
    </div>
  );
}

/* ============================================================
   IMPORT (Workforce Master DW / IT Code) — dry run preview, then
   bounded-chunk resumable execute (mission section 38).
   ============================================================ */
function ImportTab({ kind }: { kind: "workforce" | "fingerprint" }) {
  const [file, setFile] = useState<File | null>(null);
  const [datasetMode, setDatasetMode] = useState<"TEST" | "OFFICIAL">("TEST");
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ processed: number; done: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const base = `/api/admin/data-management/imports/${kind}`;

  const runPreview = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    setPreview(null);
    try {
      const form = new FormData();
      form.set("file", file);
      const res = await fetch(`${base}/preview`, { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? data.error);
        return;
      }
      setPreview(data);
    } finally {
      setBusy(false);
    }
  };

  const runExecute = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    setProgress(null);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("datasetMode", datasetMode);
      let res = await fetch(`${base}/execute`, { method: "POST", body: form });
      let data = await res.json();
      if (!res.ok) {
        setError(data.message ?? data.error);
        return;
      }
      let batchId: string = data.batchId;
      setProgress({ processed: data.processed, done: data.done });
      while (!data.done) {
        const nextForm = new FormData();
        nextForm.set("batchId", batchId);
        res = await fetch(`${base}/execute`, { method: "POST", body: nextForm });
        data = await res.json();
        if (!res.ok) {
          setError(data.message ?? data.error);
          return;
        }
        setProgress((prev) => ({ processed: (prev?.processed ?? 0) + data.processed, done: data.done }));
      }
      toast({ title: "✅ Import hoàn tất." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <h3 className="mb-3 text-[14px] font-semibold text-fg">{kind === "workforce" ? "Import Master DW (dw_data) — UPSERT lặp lại được" : "Import IT Code (Mã số công nhật) — đối chiếu theo CCCD"}</h3>
        <p className="mb-3 text-[12.5px] text-fg-muted">
          {kind === "workforce"
            ? "CCCD đã có trong hệ thống sẽ được CẬP NHẬT; CCCD mới sẽ được TẠO MỚI; lao động vắng mặt trong file KHÔNG bị xoá/suy diễn nghỉ việc."
            : "Đối chiếu theo CCCD với DW Data (phải đã có Mã số công nhật). IT Code là mã thiết bị vân tay, không phải dữ liệu sinh trắc học thô."}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <input type="file" accept=".xlsx,.xls,.csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="text-[13px]" />
          <select value={datasetMode} onChange={(e) => setDatasetMode(e.target.value as "TEST" | "OFFICIAL")} className="h-9 rounded-[10px] border border-border-strong bg-surface px-2 text-[13px]">
            <option value="TEST">TEST</option>
            <option value="OFFICIAL">OFFICIAL</option>
          </select>
          <Button variant="outline" onClick={() => void runPreview()} disabled={!file || busy} loading={busy}>
            Xem trước (Dry Run)
          </Button>
          <Button variant="primary" onClick={() => void runExecute()} disabled={!file || busy} loading={busy}>
            Import
          </Button>
        </div>
        {error ? (
          <div className="mt-3">
            <AlertPanel tone="danger" title="Lỗi" icon={<AlertTriangle className="h-4 w-4" />}>
              {error}
            </AlertPanel>
          </div>
        ) : null}
        {progress ? (
          <p className="mt-3 text-[12.5px] text-fg-secondary">
            Đã xử lý {progress.processed} dòng — {progress.done ? "hoàn tất." : "đang tiếp tục..."}
          </p>
        ) : null}
      </Card>

      {preview ? (
        <Card className="p-5">
          <h3 className="mb-3 text-[14px] font-semibold text-fg">Kết quả Dry Run (chưa ghi dữ liệu)</h3>
          <pre className="overflow-x-auto rounded-[10px] bg-surface-2 p-3 text-[12px]">{JSON.stringify(preview, null, 2)}</pre>
        </Card>
      ) : null}
    </div>
  );
}

/* ============================================================
   RESET — scope selection -> server preview (dependency expansion,
   counts, token) -> typed confirmation -> execute.
   ============================================================ */
function ResetTab() {
  const [selected, setSelected] = useState<Set<ResetScope>>(new Set());
  const [preview, setPreview] = useState<ResetPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [typedPhrase, setTypedPhrase] = useState("");

  const toggle = (scope: ResetScope) => {
    setPreview(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });
  };

  const runPreview = async () => {
    if (selected.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/data-management/reset/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scopes: [...selected] }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? data.error);
        return;
      }
      setPreview(data);
    } finally {
      setBusy(false);
    }
  };

  const runExecute = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const res = await fetch("/api/admin/data-management/reset/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ previewToken: preview.previewToken, confirmationPhrase: typedPhrase }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast({ title: data.message ?? data.error ?? "Reset thất bại.", variant: "destructive" });
        return;
      }
      toast({ title: "✅ Đã reset dữ liệu." });
      setConfirmOpen(false);
      setPreview(null);
      setSelected(new Set());
      setTypedPhrase("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <h3 className="mb-3 text-[14px] font-semibold text-fg">Chọn phạm vi reset</h3>
        <div className="flex flex-col gap-2">
          {(Object.keys(SCOPE_LABELS) as ResetScope[]).map((scope) => (
            <label key={scope} className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" checked={selected.has(scope)} onChange={() => toggle(scope)} />
              {SCOPE_LABELS[scope]}
            </label>
          ))}
        </div>
        <Button className="mt-4" variant="outline" onClick={() => void runPreview()} disabled={selected.size === 0 || busy} loading={busy}>
          Xem trước (Preview)
        </Button>
        {error ? (
          <div className="mt-3">
            <AlertPanel tone="danger" title="Lỗi" icon={<AlertTriangle className="h-4 w-4" />}>
              {error}
            </AlertPanel>
          </div>
        ) : null}
      </Card>

      {preview ? (
        <Card className="p-5">
          <h3 className="mb-2 text-[14px] font-semibold text-danger">Sẽ reset ({preview.effectiveScopes.map((s) => SCOPE_LABELS[s]).join(", ")})</h3>
          <div className="space-y-1.5">
            {preview.affected.map((a) => (
              <div key={a.domain} className="flex items-center justify-between text-[13px]">
                <span>{a.label}</span>
                <span className="font-mono font-semibold">{a.rows.toLocaleString("vi-VN")}</span>
              </div>
            ))}
          </div>
          <h4 className="mb-1.5 mt-4 text-[13px] font-semibold text-fg">Sẽ giữ nguyên</h4>
          <ul className="list-inside list-disc text-[12.5px] text-fg-secondary">
            {preview.preserved.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          {preview.warnings.length > 0 ? (
            <div className="mt-3">
              <AlertPanel tone="warning" title="Cảnh báo" icon={<AlertTriangle className="h-4 w-4" />}>
                {preview.warnings.join(" ")}
              </AlertPanel>
            </div>
          ) : null}
          <Button className="mt-4" variant="danger" onClick={() => setConfirmOpen(true)}>
            Tiếp tục reset
          </Button>
        </Card>
      ) : null}

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Xác nhận Reset dữ liệu"
        description={`Thao tác này KHÔNG THỂ hoàn tác. Gõ chính xác: ${preview?.requiredConfirmationPhrase ?? ""}`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)} disabled={busy}>
              Huỷ
            </Button>
            <Button variant="danger" onClick={() => void runExecute()} loading={busy} disabled={typedPhrase !== preview?.requiredConfirmationPhrase}>
              RESET NGAY
            </Button>
          </>
        }
      >
        <Input value={typedPhrase} onChange={(e) => setTypedPhrase(e.target.value)} placeholder={preview?.requiredConfirmationPhrase} autoFocus />
      </Modal>
    </div>
  );
}

function HistoryTab() {
  type Operation = { id: string; action: string; username: string | null; createdAt: string; details: Record<string, unknown> };
  const [operations, setOperations] = useState<Operation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        const res = await fetch("/api/admin/data-management/operations");
        const data = await res.json();
        if (!res.ok) {
          setError(data.message ?? data.error);
          return;
        }
        setOperations(data.operations);
      } catch {
        setError("Không kết nối được máy chủ.");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <SkeletonTable rows={6} cols={4} />;
  if (error) return <ErrorState description={error} />;
  if (!operations || operations.length === 0) return <EmptyState title="Chưa có thao tác nào" description="Lịch sử Reset/Import sẽ hiển thị tại đây." />;

  return (
    <Card className="overflow-x-auto p-0">
      <table className="w-full text-[13px]">
        <thead className="border-b border-border bg-surface-2 text-left text-[11px] uppercase text-fg-muted">
          <tr>
            <th className="px-3 py-2">Thời gian</th>
            <th className="px-3 py-2">Hành động</th>
            <th className="px-3 py-2">Người thực hiện</th>
            <th className="px-3 py-2">Chi tiết</th>
          </tr>
        </thead>
        <tbody>
          {operations.map((op) => (
            <tr key={op.id} className="border-b border-border last:border-0">
              <td className="px-3 py-2 text-fg-muted">{new Date(op.createdAt).toLocaleString("vi-VN")}</td>
              <td className="px-3 py-2 font-medium">{op.action}</td>
              <td className="px-3 py-2">{op.username ?? "—"}</td>
              <td className="px-3 py-2">
                <details>
                  <summary className="cursor-pointer text-primary">Xem</summary>
                  <pre className="mt-1 max-w-md overflow-x-auto text-[11px]">{JSON.stringify(op.details, null, 2)}</pre>
                </details>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
