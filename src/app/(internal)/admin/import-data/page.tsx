"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Card, CardContent, Label, toast } from "@/components/ui";
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

type JobType = "department" | "dw_data" | "daily_application";
const TYPES: { key: JobType; title: string }[] = [
  { key: "department", title: "Department" },
  { key: "dw_data", title: "DW Data" },
  { key: "daily_application", title: "Daily Application" },
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
  updatedAt: string; // <-- ĐÃ KHAI BÁO BỔ SUNG ĐỂ PASS VERCEL BUILD
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
    green: "from-hasfarm-600 to-hasfarm-800 text-white",
    gold: "from-gold-400 to-gold-600 text-hasfarm-900",
    red: "from-red-500 to-red-700 text-white",
    amber: "from-amber-400 to-amber-600 text-white",
    gray: "from-gray-200 to-gray-300 text-gray-700",
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
  QUEUED: "bg-gray-100 text-gray-600",
  RUNNING: "bg-blue-100 text-blue-700",
  PAUSED: "bg-amber-100 text-amber-700",
  DONE: "bg-emerald-100 text-emerald-700",
  FAILED: "bg-red-100 text-red-700",
  CANCELLED: "bg-gray-200 text-gray-500",
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
  const [jobType, setJobType] = useState<JobType>("department");
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);

  const [mappingInfo, setMappingInfo] = useState<Extract<UploadResponse, { needsMapping: true }> | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});

  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<JobStatusResp | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [history, setHistory] = useState<Job[]>([]);
  const [historyOpen, setHistoryOpen] = useState(true);

  const loadHistory = useCallback(async () => {
    const res = await fetch("/api/import/jobs");
    if (res.ok) setHistory((await res.json()).rows ?? []);
  }, []);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  // ---- Polling & Client-Driven Auto-Resume ----
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
      } else if (d.job.status === "RUNNING" || d.job.status === "QUEUED") {
        // Lách Vercel Loop Protection: Trình duyệt đóng vai trò máy trợ tim.
        // Nếu thấy server không update trạng thái quá 15 giây (bị chém ngầm),
        // Trình duyệt lập tức chọc API để ép server chạy lô tiếp theo!
        const lastUpdated = new Date(d.job.updatedAt ?? d.job.createdAt).getTime();
        const now = Date.now();
        if (now - lastUpdated > 15000) {
          console.log("Phát hiện máy chủ bị ngắt kết nối. Trình duyệt đang tự động Resume...");
          fetch(`/api/import/job/${activeJobId}/retry`, { method: "POST" }).catch(() => {});
        }
      }
    };
    void poll();
    pollRef.current = setInterval(poll, 1500);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [activeJobId, loadHistory]);

  const doUpload = (mappingToSend?: Record<string, string>) => {
    if (!file) {
      toast({ title: "Chưa chọn file", variant: "destructive" });
      return;
    }
    setUploading(true);
    setUploadPct(0);
    const fd = new FormData();
    fd.append("file", file);
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
            toast({ title: "✅ Đã tạo Job — xử lý chạy nền, có thể đóng trang này" });
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
    toast({ title: "✅ Đã tiếp tục Job — chạy nền" });
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
    <div className="mx-auto max-w-5xl space-y-6 pb-16">
      {/* HERO */}
      <div className="hasfarm-hero animate-slide-up overflow-hidden rounded-[24px] p-6 text-white shadow-[0_20px_50px_rgba(8,50,27,0.35)] sm:p-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white/10 backdrop-blur-md ring-1 ring-white/20">
              <Sparkles className="h-7 w-7 text-gold-300" />
            </div>
            <div>
              <p className="text-[11px] font-black uppercase tracking-[0.3em] text-gold-300">Import Engine v3</p>
              <h1 className="text-2xl font-black tracking-tight sm:text-[28px]">Nhập dữ liệu</h1>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <a
              href="/help/import/IMPORT_GUIDE.md"
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 rounded-full bg-white/10 px-4 py-2.5 text-sm font-bold backdrop-blur-md ring-1 ring-white/20 transition hover:bg-white/20"
            >
              <HelpCircle className="h-4 w-4" /> Hướng dẫn Import
            </a>
            <button
              onClick={() => setHistoryOpen((v) => !v)}
              className="flex items-center gap-2 rounded-full bg-white/10 px-4 py-2.5 text-sm font-bold backdrop-blur-md ring-1 ring-white/20 transition hover:bg-white/20"
            >
              <History className="h-4 w-4" /> Job Queue
              {activeIncomplete.length > 0 && <span className="rounded-full bg-gold-400 px-2 py-0.5 text-[10px] font-black text-hasfarm-900">{activeIncomplete.length} đang xử lý</span>}
            </button>
          </div>
        </div>
      </div>

      {/* JOB QUEUE / HISTORY */}
      {historyOpen && (
        <Card className="hasfarm-card animate-fade-in-scale rounded-[20px] border-0 p-0">
          <CardContent className="max-h-80 overflow-y-auto p-3">
            {history.length === 0 && <p className="p-6 text-center text-sm text-gray-400">Chưa có Job nào.</p>}
            {history.map((j) => (
              <div key={j.id} className="flex flex-wrap items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-hasfarm-50/60">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold text-hasfarm-900">{j.fileName}</p>
                  <p className="text-xs text-gray-500">
                    {TYPES.find((t) => t.key === j.jobType)?.title} · {j.processedRows.toLocaleString("vi-VN")}/{j.totalRows.toLocaleString("vi-VN")} dòng · {new Date(j.createdAt).toLocaleString("vi-VN")}
                  </p>
                </div>
                <span className={`shrink-0 rounded-full px-3 py-1 text-[10px] font-black uppercase ${STATUS_BADGE[j.status]}`}>{STATUS_LABEL[j.status]}</span>
                <div className="flex shrink-0 gap-1">
                  {(j.status === "RUNNING" || j.status === "QUEUED") && (
                    <button onClick={() => setActiveJobId(j.id)} className="rounded-full bg-hasfarm-100 px-3 py-1.5 text-[11px] font-bold text-hasfarm-700 hover:bg-hasfarm-200">
                      Theo dõi
                    </button>
                  )}
                  {(j.status === "FAILED" || j.status === "PAUSED") && (
                    <button onClick={() => resumeJob(j.id)} className="flex items-center gap-1 rounded-full bg-hasfarm-700 px-3 py-1.5 text-[11px] font-bold text-white hover:bg-hasfarm-800">
                      <RotateCcw className="h-3 w-3" /> {j.status === "FAILED" ? "Retry" : "Resume"}
                    </button>
                  )}
                  {(j.status === "RUNNING" || j.status === "QUEUED") && (
                    <button onClick={() => cancelJob(j.id)} className="flex items-center gap-1 rounded-full bg-red-50 px-3 py-1.5 text-[11px] font-bold text-red-600 hover:bg-red-100">
                      <XCircle className="h-3 w-3" /> Cancel
                    </button>
                  )}
                  {j.errorRows + j.warningRows > 0 && (
                    <a href={`/api/import/job/${j.id}/log`} className="flex items-center gap-1 rounded-full bg-gray-100 px-3 py-1.5 text-[11px] font-bold text-gray-600 hover:bg-gray-200">
                      <Download className="h-3 w-3" /> Log
                    </a>
                  )}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* UPLOAD FORM (chỉ hiện khi không có job đang theo dõi) */}
      {!activeJobId && !mappingInfo && (
        <Card className="hasfarm-card animate-slide-up rounded-[22px] border-0 p-1">
          <CardContent className="space-y-5 p-6">
            <div>
              <Label className="mb-2 block text-xs font-black uppercase tracking-widest text-gray-400">Loại dữ liệu</Label>
              <div className="grid gap-3 sm:grid-cols-3">
                {TYPES.map((t) => (
                  <button
                    key={t.key}
                    onClick={() => setJobType(t.key)}
                    className={`rounded-2xl border-2 p-4 text-left transition-all ${jobType === t.key ? "border-hasfarm-700 bg-hasfarm-50 shadow-[0_8px_20px_rgba(17,88,48,0.12)]" : "border-gray-100 hover:border-hasfarm-200"}`}
                  >
                    <p className="font-black text-hasfarm-900">{t.title}</p>
                  </button>
                ))}
              </div>
            </div>

            <div className="flex justify-end">
              <a href={`/api/admin/field-definitions/template?group=${jobType}`} className="inline-flex items-center gap-1 text-xs font-bold text-hasfarm-700 hover:underline">
                <Download className="h-3 w-3" /> Tải file mẫu
              </a>
            </div>

            <label className={`flex flex-col items-center justify-center gap-3 rounded-[20px] border-2 border-dashed p-10 text-center transition-colors ${file ? "border-hasfarm-400 bg-hasfarm-50/50" : "border-gray-200 hover:border-hasfarm-300 hover:bg-hasfarm-50/30"}`}>
              <input
                type="file"
                className="hidden"
                accept=".csv,text/csv,.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              {file ? (
                <>
                  <FileSpreadsheet className="h-10 w-10 text-hasfarm-600" />
                  <div>
                    <p className="font-bold text-hasfarm-900">{file.name}</p>
                    <p className="text-xs text-gray-500">{(file.size / 1024).toFixed(0)} KB — bấm để chọn file khác</p>
                  </div>
                </>
              ) : (
                <>
                  <UploadCloud className="h-10 w-10 text-gray-300" />
                  <div>
                    <p className="font-bold text-gray-600">Kéo thả hoặc bấm để chọn file CSV / XLSX / XLS</p>
                  </div>
                </>
              )}
            </label>

            {uploading && (
              <div className="space-y-1.5">
                <div className="h-2.5 w-full overflow-hidden rounded-full bg-gray-100">
                  <div className="progress-glow h-full rounded-full bg-gradient-to-r from-hasfarm-600 to-hasfarm-800 transition-all duration-300" style={{ width: `${uploadPct}%` }} />
                </div>
                <p className="text-center text-xs font-bold text-hasfarm-700">Đang tải lên… {uploadPct}%</p>
              </div>
            )}

            <Button onClick={() => doUpload()} disabled={uploading || !file} className="w-full gap-2" size="lg">
              {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
              {uploading ? "Đang tải lên…" : "Tải lên & Tạo Job"}
            </Button>
          </CardContent>
        </Card>
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
                  <span className="text-gray-400">←</span>
                  <select value={mapping[f.fieldKey] ?? ""} onChange={(e) => setMapping((m) => ({ ...m, [f.fieldKey]: e.target.value }))} className="h-9 flex-1 rounded-lg border-2 border-gray-200 px-2 text-sm">
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
                  <p className="text-sm font-black text-hasfarm-900">{job.fileName}</p>
                  <p className="text-xs text-gray-500">{jobStatus?.stageLabel}</p>
                </div>
                <span className={`rounded-full px-3 py-1 text-[11px] font-black uppercase ${STATUS_BADGE[job.status]}`}>{STATUS_LABEL[job.status]}</span>
              </div>

              {/* Stage timeline */}
              <div className="flex items-center gap-1 overflow-x-auto pb-1">
                {STAGES.map((s, i) => (
                  <div key={s} className={`shrink-0 rounded-full px-3 py-1.5 text-[11px] font-bold ${i < stageIdx ? "bg-hasfarm-50 text-hasfarm-700 ring-1 ring-hasfarm-200" : i === stageIdx ? "bg-gradient-to-r from-hasfarm-700 to-hasfarm-800 text-white" : "bg-gray-100 text-gray-400"}`}>
                    {i < stageIdx ? <CheckCircle2 className="mr-1 inline h-3 w-3" /> : null}
                    {STAGE_LABEL[s]}
                  </div>
                ))}
              </div>

              <div className="h-3 w-full overflow-hidden rounded-full bg-gray-100">
                <div className={`h-full rounded-full bg-gradient-to-r from-hasfarm-600 via-hasfarm-700 to-gold-500 transition-all duration-500 ${job.status === "RUNNING" ? "progress-glow" : ""}`} style={{ width: `${job.progress}%` }} />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500">
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
                    <a href={`/api/import/job/${job.id}/log`} className="flex w-full items-center justify-center gap-2 rounded-full bg-hasfarm-800 py-2.5 text-sm font-bold text-white hover:bg-hasfarm-900">
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
