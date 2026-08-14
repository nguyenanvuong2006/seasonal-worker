"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, CardContent, Label, toast } from "@/components/ui";
import { DirectPasteGrid, type PasteJobType } from "@/components/direct-paste-grid";
import {
  UploadCloud,
  CheckCircle2,
  Loader2,
  Download,
  TriangleAlert,
  ArrowLeft,
  FileSpreadsheet,
  History,
  RotateCcw,
  XCircle,
  Sparkles,
  Gauge,
  Timer,
  HelpCircle,
} from "lucide-react";

type JobType = PasteJobType;
const TYPES: { key: JobType; title: string; subtitle: string }[] = [
  { key: "daily_application", title: "Đăng ký tập nghề", subtitle: "Daily Application + câu hỏi trên form" },
  { key: "dw_data", title: "Hồ sơ lao động", subtitle: "DW Data đối chiếu lịch sử" },
  { key: "department", title: "Cơ cấu bộ phận", subtitle: "Department" },
];

const STAGES = ["STAGING", "VALIDATING", "MATCHING", "MERGING", "BUILDING_STATS", "DONE"];
const STAGE_LABEL: Record<string, string> = {
  STAGING: "Nạp staging",
  VALIDATING: "Kiểm tra dữ liệu",
  MATCHING: "Đối chiếu DW Data",
  MERGING: "Cập nhật bảng chính",
  BUILDING_STATS: "Tổng hợp thống kê",
  DONE: "Hoàn tất",
};

type UploadResponse =
  | { needsMapping: true; totalRows: number; headers: string[]; preview: Record<string, string>[]; unmatchedRequiredFields: { fieldKey: string; displayName: string }[]; unrecognizedColumns: string[] }
  | { needsMapping?: false; jobId: string; totalRows: number; headers: string[]; preview: Record<string, string>[] };

type Job = {
  id: string;
  jobType: JobType;
  fileName: string;
  status: "QUEUED" | "RUNNING" | "PAUSED" | "DONE" | "FAILED" | "CANCELLED";
  progress: number;
  currentStage: string;
  totalRows: number;
  processedRows: number;
  insertedRows: number;
  updatedRows: number;
  duplicateRows: number;
  warningRows: number;
  errorRows: number;
  startedAt: string | null;
  finishedAt: string | null;
  createdBy: string;
  lastError: string | null;
  createdAt: string;
};
type JobStatusResp = { job: Job; stageLabel: string; rowsPerSec: number; etaSec: number | null; errorSample: { rowNumber: number; reason: string; originalData: Record<string, string> }[]; warningSample: { rowNumber: number; reason: string; originalData: Record<string, string> }[] };

function CountUp({ value, className }: { value: number; className?: string }) {
  const [display, setDisplay] = useState(0);
  const prevRef = useRef(0);
  useEffect(() => {
    const from = prevRef.current;
    const to = value;
    prevRef.current = value;
    if (from === to) return;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / 400);
      setDisplay(Math.round(from + (to - from) * (1 - Math.pow(1 - t, 3))));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <span className={className}>{display.toLocaleString("vi-VN")}</span>;
}

function StatCard({ label, value, tone }: { label: string; value: number; tone: "green" | "gold" | "red" | "amber" | "gray" }) {
  const toneMap = {
    green: "bg-primary text-white",
    gold: "from-gold-400 to-gold-600 text-fg",
    red: "from-red-500 to-red-700 text-white",
    amber: "from-amber-400 to-amber-600 text-white",
    gray: "bg-surface-hover text-fg-secondary",
  }[tone];
  return (
    <div className={`hasfarm-card animate-fade-in-scale overflow-hidden rounded-[18px] bg-gradient-to-br p-4 ${toneMap}`}>
      <p className="text-[10px] font-black uppercase tracking-widest opacity-80">{label}</p>
      <CountUp value={value} className="mt-1 block text-3xl font-black leading-none" />
    </div>
  );
}

function fmtEta(sec: number | null) {
  if (sec === null) return "—";
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)} phút ${sec % 60}s`;
}

const STATUS_BADGE: Record<string, string> = {
  QUEUED: "bg-surface-hover text-fg-secondary",
  RUNNING: "bg-blue-100 text-blue-700",
  PAUSED: "bg-amber-100 text-amber-700",
  DONE: "bg-emerald-100 text-emerald-700",
  FAILED: "bg-red-100 text-red-700",
  CANCELLED: "bg-surface-hover text-fg-secondary",
};
const STATUS_LABEL: Record<string, string> = {
  QUEUED: "Đang chờ",
  RUNNING: "Đang chạy",
  PAUSED: "Tạm dừng",
  DONE: "Hoàn tất",
  FAILED: "Lỗi",
  CANCELLED: "Đã huỷ",
};

export default function ImportDataPage() {
  const [jobType, setJobType] = useState<JobType>("daily_application");
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);

  const [mappingInfo, setMappingInfo] = useState<Extract<UploadResponse, { needsMapping: true }> | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});

  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<JobStatusResp | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [history, setHistory] = useState<Job[]>([]);
  // Để bảng template xuất hiện ngay khi mở trang; Job Queue vẫn truy cập bằng nút ở hero.
  const [historyOpen, setHistoryOpen] = useState(false);

  const loadHistory = useCallback(async () => {
    const res = await fetch("/api/import/jobs");
    if (res.ok) setHistory((await res.json()).rows ?? []);
  }, []);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  // ---- Polling trạng thái Job (KHÔNG điều khiển xử lý — chỉ để hiển thị) ----
  useEffect(() => {
    if (!activeJobId) return;
    const poll = async () => {
      const res = await fetch(`/api/import/job/${activeJobId}`);
      if (!res.ok) return;
      const d: JobStatusResp = await res.json();
      setJobStatus(d);
      if (["DONE", "FAILED", "CANCELLED"].includes(d.job.status)) {
        if (pollRef.current) clearInterval(pollRef.current);
        void loadHistory();
      }
    };
    void poll();
    pollRef.current = setInterval(poll, 1500);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [activeJobId, loadHistory]);

  const doUpload = (mappingToSend?: Record<string, string>, sourceFile?: File) => {
    const uploadFile = sourceFile ?? file;
    if (!uploadFile) {
      toast({ title: "Chưa có dữ liệu hoặc file để xử lý", variant: "destructive" });
      return;
    }
    // Ghi nhớ file được dựng từ bảng để bước Map Columns (nếu có) vẫn có thể gửi lại.
    if (sourceFile) setFile(sourceFile);
    setUploading(true);
    setUploadPct(0);
    const fd = new FormData();
    fd.append("file", uploadFile);
    fd.append("jobType", jobType);
    if (mappingToSend) fd.append("mapping", JSON.stringify(mappingToSend));

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/import/upload");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setUploadPct(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      setUploading(false);
      try {
        const d = JSON.parse(xhr.responseText) as UploadResponse & { error?: string };
        if (xhr.status >= 200 && xhr.status < 300) {
          if (d.needsMapping) {
            setMappingInfo(d);
          } else if ("jobId" in d) {
            setMappingInfo(null);
            setActiveJobId(d.jobId);
            toast({ title: "Đã tạo Job — xử lý chạy nền, có thể đóng trang này" });
          }
        } else {
          toast({ title: (d as { error?: string }).error ?? "Lỗi upload", variant: "destructive" });
        }
      } catch {
        toast({ title: "Lỗi không xác định khi upload", variant: "destructive" });
      }
    };
    xhr.onerror = () => {
      setUploading(false);
      toast({ title: "Lỗi kết nối khi upload", variant: "destructive" });
    };
    xhr.send(fd);
  };

  const hasUnmapped = mappingInfo ? mappingInfo.unmatchedRequiredFields.some((f) => !mapping[f.fieldKey]) : false;

  const cancelJob = async (id: string) => {
    await fetch(`/api/import/job/${id}/cancel`, { method: "POST" });
    toast({ title: "Đã gửi yêu cầu huỷ Job" });
    void loadHistory();
  };
  const resumeJob = async (id: string) => {
    await fetch(`/api/import/job/${id}/retry`, { method: "POST" });
    toast({ title: "Đã tiếp tục Job — chạy nền" });
    setActiveJobId(id);
    void loadHistory();
  };

  const resetAll = () => {
    setActiveJobId(null);
    setJobStatus(null);
    setFile(null);
    setMappingInfo(null);
    setMapping({});
  };

  const job = jobStatus?.job;
  const stageIdx = job ? STAGES.indexOf(job.currentStage) : -1;
  const activeIncomplete = useMemo(() => history.filter((j) => ["QUEUED", "RUNNING", "PAUSED", "FAILED"].includes(j.status)), [history]);

  return (
    <div className="mx-auto max-w-[1400px] space-y-6 pb-16">
      {/* HERO */}
      <div className="hasfarm-hero animate-slide-up overflow-hidden rounded-[24px] p-6 text-white shadow-[0_20px_50px_rgba(8,50,27,0.35)] sm:p-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-surface/10 backdrop-blur-md ring-1 ring-white/20">
              <Sparkles className="h-7 w-7 text-gold-300" />
            </div>
            <div>
              <p className="text-[11px] font-black uppercase tracking-[0.3em] text-gold-300">Paste Grid + Import Engine v3</p>
              <h1 className="text-2xl font-black tracking-tight sm:text-[28px]">Nhập dữ liệu trực tiếp vào bảng</h1>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <a
              href="/help/import/IMPORT_GUIDE.md"
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 rounded-full bg-surface/10 px-4 py-2.5 text-sm font-bold backdrop-blur-md ring-1 ring-white/20 transition hover:bg-surface/20"
            >
              <HelpCircle className="h-4 w-4" /> Hướng dẫn Import
            </a>
            <button
              onClick={() => setHistoryOpen((v) => !v)}
              className="flex items-center gap-2 rounded-full bg-surface/10 px-4 py-2.5 text-sm font-bold backdrop-blur-md ring-1 ring-white/20 transition hover:bg-surface/20"
            >
              <History className="h-4 w-4" /> Job Queue
              {activeIncomplete.length > 0 && <span className="rounded-full bg-gold-400 px-2 py-0.5 text-[10px] font-black text-fg">{activeIncomplete.length} đang xử lý</span>}
            </button>
          </div>
        </div>
      </div>

      {/* JOB QUEUE / HISTORY */}
      {historyOpen && (
        <Card className="hasfarm-card animate-fade-in-scale rounded-[20px] border-0 p-0">
          <CardContent className="max-h-80 overflow-y-auto p-3">
            {history.length === 0 && <p className="p-6 text-center text-sm text-fg-muted">Chưa có Job nào.</p>}
            {history.map((j) => (
              <div key={j.id} className="flex flex-wrap items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-primary-tint/60">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold text-fg">{j.fileName}</p>
                  <p className="text-xs text-fg-secondary">
                    {TYPES.find((t) => t.key === j.jobType)?.title} · {j.processedRows.toLocaleString("vi-VN")}/{j.totalRows.toLocaleString("vi-VN")} dòng · {new Date(j.createdAt).toLocaleString("vi-VN")}
                  </p>
                </div>
                <span className={`shrink-0 rounded-full px-3 py-1 text-[10px] font-black uppercase ${STATUS_BADGE[j.status]}`}>{STATUS_LABEL[j.status]}</span>
                <div className="flex shrink-0 gap-1">
                  {(j.status === "RUNNING" || j.status === "QUEUED") && (
                    <button onClick={() => setActiveJobId(j.id)} className="rounded-full bg-primary-tint px-3 py-1.5 text-[11px] font-bold text-primary hover:bg-primary/15">
                      Theo dõi
                    </button>
                  )}
                  {(j.status === "FAILED" || j.status === "PAUSED") && (
                    <button onClick={() => resumeJob(j.id)} className="flex items-center gap-1 rounded-full bg-primary px-3 py-1.5 text-[11px] font-bold text-white hover:bg-primary">
                      <RotateCcw className="h-3 w-3" /> {j.status === "FAILED" ? "Retry" : "Resume"}
                    </button>
                  )}
                  {(j.status === "RUNNING" || j.status === "QUEUED") && (
                    <button onClick={() => cancelJob(j.id)} className="flex items-center gap-1 rounded-full bg-red-50 px-3 py-1.5 text-[11px] font-bold text-red-600 hover:bg-red-100">
                      <XCircle className="h-3 w-3" /> Cancel
                    </button>
                  )}
                  {j.errorRows + j.warningRows > 0 && (
                    <a href={`/api/import/job/${j.id}/log`} className="flex items-center gap-1 rounded-full bg-surface-hover px-3 py-1.5 text-[11px] font-bold text-fg-secondary hover:bg-border">
                      <Download className="h-3 w-3" /> Log
                    </a>
                  )}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* BẢNG TEMPLATE TRỰC TIẾP (chỉ hiện khi không có job đang theo dõi) */}
      {!activeJobId && !mappingInfo && (
        <div className="animate-slide-up space-y-4">
          <Card className="hasfarm-card rounded-[20px] border-0 p-0">
            <CardContent className="p-4">
              <Label className="mb-2 block text-xs font-black uppercase tracking-widest text-fg-muted">Chọn bảng dữ liệu</Label>
              <div className="grid gap-3 sm:grid-cols-3">
                {TYPES.map((t) => (
                  <button
                    key={t.key}
                    onClick={() => setJobType(t.key)}
                    className={`rounded-2xl border-2 p-4 text-left transition-all ${jobType === t.key ? "border-accent bg-accent-tint shadow-[0_8px_20px_rgba(226,109,28,0.12)]" : "border-border bg-white hover:border-primary/40"}`}
                  >
                    <p className="font-black text-fg">{t.title}</p>
                    <p className="mt-1 text-xs text-fg-secondary">{t.subtitle}</p>
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>

          <DirectPasteGrid
            key={jobType}
            jobType={jobType}
            submitting={uploading}
            uploadPct={uploadPct}
            onSubmit={(generatedFile) => doUpload(undefined, generatedFile)}
          />

          {/* File upload chỉ còn là phương án phụ cho bộ dữ liệu quá lớn. */}
          <details className="hasfarm-card overflow-hidden rounded-[20px] border-0 bg-surface">
            <summary className="cursor-pointer list-none px-5 py-4 text-sm font-bold text-fg-secondary hover:bg-surface-hover">
              Dữ liệu rất lớn? Dùng file CSV / Excel thay cho dán trực tiếp
            </summary>
            <div className="space-y-4 border-t border-border p-5">
              <div className="flex justify-end">
                <a href={`/api/admin/field-definitions/template?group=${jobType}`} className="inline-flex items-center gap-1 text-xs font-bold text-primary hover:underline">
                  <Download className="h-3 w-3" /> Tải file mẫu
                </a>
              </div>
              <label className={`flex cursor-pointer flex-col items-center justify-center gap-3 rounded-[18px] border-2 border-dashed p-7 text-center transition-colors ${file ? "border-primary/50 bg-primary-tint/50" : "border-border-strong hover:border-primary/40 hover:bg-primary-tint/30"}`}>
                <input
                  type="file"
                  className="hidden"
                  accept=".csv,text/csv,.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
                <FileSpreadsheet className="h-8 w-8 text-primary" />
                <div>
                  <p className="font-bold text-fg">{file ? file.name : "Bấm để chọn file CSV / XLSX / XLS"}</p>
                  {file && <p className="text-xs text-fg-secondary">{(file.size / 1024).toFixed(0)} KB — bấm để chọn file khác</p>}
                </div>
              </label>
              <Button onClick={() => doUpload()} disabled={uploading || !file} className="w-full gap-2" size="lg">
                {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
                {uploading ? `Đang tải lên… ${uploadPct}%` : "Tải file lên & Tạo Job"}
              </Button>
            </div>
          </details>
        </div>
      )}

      {/* MAP COLUMNS (nếu cần) */}
      {mappingInfo && (
        <Card className="hasfarm-card animate-slide-up rounded-[22px] border-0 p-0">
          <CardContent className="space-y-4 p-6">
            <div className="rounded-xl border p-4">
              <p className="mb-3 flex items-center gap-2 text-sm font-bold text-amber-700">
                <TriangleAlert className="h-4 w-4" /> {mappingInfo.unmatchedRequiredFields.length} trường bắt buộc chưa khớp
              </p>
              {mappingInfo.unmatchedRequiredFields.map((f) => (
                <div key={f.fieldKey} className="mb-2 flex items-center gap-2">
                  <span className="w-40 shrink-0 text-sm font-semibold">{f.displayName}</span>
                  <span className="text-fg-muted">←</span>
                  <select value={mapping[f.fieldKey] ?? ""} onChange={(e) => setMapping((m) => ({ ...m, [f.fieldKey]: e.target.value }))} className="h-9 flex-1 rounded-lg border-2 border-border-strong px-2 text-sm">
                    <option value="">— Chọn cột trong file —</option>
                    {mappingInfo.headers.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <Button variant="subtle" onClick={() => setMappingInfo(null)} className="gap-2">
                <ArrowLeft className="h-4 w-4" /> Quay lại
              </Button>
              <Button onClick={() => doUpload(mapping)} disabled={hasUnmapped || uploading} className="flex-1 gap-2">
                {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Xác nhận & Tạo Job"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* JOB MONITOR (polling) */}
      {activeJobId && job && (
        <div className="animate-slide-up space-y-4">
          <Card className="hasfarm-card overflow-hidden rounded-[22px] border-0 p-0">
            <CardContent className="space-y-4 p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-black text-fg">{job.fileName}</p>
                  <p className="text-xs text-fg-secondary">{jobStatus?.stageLabel}</p>
                </div>
                <span className={`rounded-full px-3 py-1 text-[11px] font-black uppercase ${STATUS_BADGE[job.status]}`}>{STATUS_LABEL[job.status]}</span>
              </div>

              {/* Stage timeline */}
              <div className="flex items-center gap-1 overflow-x-auto pb-1">
                {STAGES.map((s, i) => (
                  <div key={s} className={`shrink-0 rounded-full px-3 py-1.5 text-[11px] font-bold ${i < stageIdx ? "bg-primary-tint text-primary ring-1 ring-primary/20" : i === stageIdx ? "bg-primary text-white" : "bg-surface-hover text-fg-muted"}`}>
                    {i < stageIdx ? <CheckCircle2 className="mr-1 inline h-3 w-3" /> : null}
                    {STAGE_LABEL[s]}
                  </div>
                ))}
              </div>

              <div className="h-3 w-full overflow-hidden rounded-full bg-surface-hover">
                <div className={`h-full rounded-full bg-primary transition-all duration-500 ${job.status === "RUNNING" ? "progress-glow" : ""}`} style={{ width: `${job.progress}%` }} />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-fg-secondary">
                <span>
                  {job.processedRows.toLocaleString("vi-VN")} / {job.totalRows.toLocaleString("vi-VN")} dòng ({job.progress}%)
                </span>
                <span className="flex items-center gap-3">
                  <span className="flex items-center gap-1">
                    <Gauge className="h-3.5 w-3.5" /> {jobStatus?.rowsPerSec ?? 0} dòng/giây
                  </span>
                  <span className="flex items-center gap-1">
                    <Timer className="h-3.5 w-3.5" /> ETA {fmtEta(jobStatus?.etaSec ?? null)}
                  </span>
                </span>
              </div>

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <StatCard label="Đã thêm" value={job.insertedRows} tone="green" />
                <StatCard label="Trùng lặp" value={job.duplicateRows} tone="gray" />
                <StatCard label="Cảnh báo" value={job.warningRows} tone="amber" />
                <StatCard label="Lỗi" value={job.errorRows} tone="red" />
              </div>

              {job.status === "RUNNING" || job.status === "QUEUED" ? (
                <Button variant="subtle" onClick={() => cancelJob(job.id)} className="w-full gap-2">
                  <XCircle className="h-4 w-4" /> Huỷ Job
                </Button>
              ) : job.status === "FAILED" ? (
                <div className="space-y-2">
                  <p className="rounded-xl bg-red-50 p-3 text-xs text-red-700">{job.lastError}</p>
                  <Button onClick={() => resumeJob(job.id)} className="w-full gap-2">
                    <RotateCcw className="h-4 w-4" /> Retry (tiếp tục từ {STAGE_LABEL[job.currentStage]})
                  </Button>
                </div>
              ) : job.status === "DONE" ? (
                <div className="space-y-2">
                  <p className="flex items-center justify-center gap-2 text-sm font-black text-emerald-700">
                    <CheckCircle2 className="h-5 w-5" /> Hoàn tất
                  </p>
                  {job.errorRows + job.warningRows > 0 && (
                    <a href={`/api/import/job/${job.id}/log`} className="flex w-full items-center justify-center gap-2 rounded-full bg-primary py-2.5 text-sm font-bold text-white hover:bg-primary-hover">
                      <Download className="h-4 w-4" /> Download Log ({job.errorRows} lỗi, {job.warningRows} cảnh báo)
                    </a>
                  )}
                  <Button variant="subtle" onClick={resetAll} className="w-full gap-2">
                    <UploadCloud className="h-4 w-4" /> Import file khác
                  </Button>
                </div>
              ) : (
                <Button variant="subtle" onClick={resetAll} className="w-full">
                  Đóng
                </Button>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
