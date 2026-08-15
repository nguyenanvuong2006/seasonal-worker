"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Eye,
  FileCheck,
  Search,
  Send,
  Sparkles,
} from "lucide-react";
import {
  documentKindLabel,
  resolveDocumentKind,
  resolveDwClassification,
} from "@/lib/document-merge/template-routing";

type MergeTemplate = {
  id: string;
  name: string;
  googleDocId: string;
  defaultMergeMode: "ONE_DOCUMENT" | "INDIVIDUAL_DOCUMENTS";
  documentKind?: string;
  isActive: boolean;
  placeholderCount?: number;
};

type ApplicantRow = {
  id: string;
  fullName: string;
  cccd: string;
  phone?: string | null;
  gender?: string | null;
  declaredType?: string | null;
  dwMatch?: string | null;
  deptName?: string | null;
  groupName?: string | null;
  status?: string | null;
  startingDate?: string | null;
  mergedDocUrl?: string | null;
  documentSentAt?: string | null;
  signatureConfirmedAt?: string | null;
};

type PreviewResult = {
  applicationId: string;
  fullName: string;
  cccd: string;
  deptName?: string | null;
  startingDate?: string | null;
  dwClassification: "OLD" | "NEW";
  documentKind: "A" | "B";
  documentKindLabel: string;
  templateName: string;
  content: string;
  missingFields: string[];
  unreplaced: string[];
  valid: boolean;
};

function daysAgo(n: number): string {
  const date = new Date();
  date.setDate(date.getDate() - n);
  return date.toISOString().slice(0, 10);
}

export function MergeWorkspace({
  selectedTemplateId,
  onSelectTemplateId,
  onSwitchToHistory,
}: {
  selectedTemplateId: string;
  onSelectTemplateId: (id: string) => void;
  onSwitchToHistory: () => void;
}) {
  const [templates, setTemplates] = useState<MergeTemplate[]>([]);
  const [templateId, setTemplateId] = useState(selectedTemplateId);
  const [autoRoute, setAutoRoute] = useState(true);
  const [batchPrint, setBatchPrint] = useState(true);
  const [records, setRecords] = useState<ApplicantRow[]>([]);
  const [loadingRecords, setLoadingRecords] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [previewTargetId, setPreviewTargetId] = useState<string>("");
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [isMerging, setIsMerging] = useState(false);
  const [mergeError, setMergeError] = useState<string | null>(null);
  const [mergeSuccess, setMergeSuccess] = useState<{
    jobId: string;
    outputUrl?: string | null;
    printUrl?: string | null;
    dispatchedCount: number;
  } | null>(null);

  useEffect(() => {
    if (selectedTemplateId) setTemplateId(selectedTemplateId);
  }, [selectedTemplateId]);

  useEffect(() => {
    fetch("/api/document-merge/templates")
      .then((res) => res.json())
      .then((data) => setTemplates(Array.isArray(data) ? data : []))
      .catch(() => setTemplates([]));
  }, []);

  useEffect(() => {
    setLoadingRecords(true);
    const from = daysAgo(14);
    fetch(`/api/registrations?from=${from}&to=${daysAgo(0)}&assigned=1`)
      .then((res) => res.json())
      .then((data) => {
        const list = Array.isArray(data?.rows) ? data.rows : [];
        setRecords(
          list.map((item: ApplicantRow) => ({
            id: item.id,
            fullName: item.fullName,
            cccd: item.cccd,
            phone: item.phone,
            gender: item.gender,
            declaredType: item.declaredType,
            dwMatch: item.dwMatch,
            deptName: item.deptName,
            groupName: item.groupName,
            status: item.status,
            startingDate: item.startingDate,
            mergedDocUrl: item.mergedDocUrl,
            documentSentAt: item.documentSentAt,
            signatureConfirmedAt: item.signatureConfirmedAt,
          })),
        );
        setSelectedIds(new Set());
      })
      .catch(() => setRecords([]))
      .finally(() => setLoadingRecords(false));
  }, []);

  const filtered = useMemo(() => {
    const q = searchTerm.toLowerCase().trim();
    if (!q) return records;
    return records.filter(
      (row) =>
        row.fullName.toLowerCase().includes(q) ||
        row.cccd.toLowerCase().includes(q) ||
        (row.phone && row.phone.includes(q)),
    );
  }, [records, searchTerm]);

  const selectedTemplate = templates.find((item) => item.id === templateId);

  const toggleAll = () => {
    if (selectedIds.size === filtered.length && filtered.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filtered.map((row) => row.id)));
    }
  };

  const toggleOne = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
    setPreviewTargetId(id);
  };

  const loadPreview = async (id?: string) => {
    const target = id || previewTargetId || Array.from(selectedIds)[0];
    if (!target) {
      setMergeError("Chọn ít nhất 1 ứng viên để xem trước.");
      return;
    }
    setPreviewTargetId(target);
    setPreviewLoading(true);
    setMergeError(null);
    try {
      const res = await fetch("/api/document-merge/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          applicationId: target,
          templateId: autoRoute ? undefined : templateId,
          autoRoute,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Không xem trước được");
      setPreview(data);
    } catch (error) {
      setPreview(null);
      setMergeError(error instanceof Error ? error.message : "Lỗi xem trước");
    } finally {
      setPreviewLoading(false);
    }
  };

  const execute = async (dispatchToApplicant: boolean) => {
    if (selectedIds.size === 0) {
      setMergeError("Chọn danh sách ứng viên đã xếp việc trước khi merge.");
      return;
    }
    setIsMerging(true);
    setMergeError(null);
    setMergeSuccess(null);
    try {
      const res = await fetch("/api/document-merge/merge/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templateId: autoRoute ? undefined : templateId,
          autoRoute,
          mergeMode: batchPrint ? "ONE_DOCUMENT" : "INDIVIDUAL_DOCUMENTS",
          batchPrint,
          dispatchToApplicant,
          records: {
            entityType: "daily_applications",
            recordIds: Array.from(selectedIds),
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.details || "Merge thất bại");
      setMergeSuccess({
        jobId: data.jobId,
        outputUrl: data.outputUrl,
        printUrl: data.printUrl,
        dispatchedCount: data.dispatchedCount ?? 0,
      });
    } catch (error) {
      setMergeError(error instanceof Error ? error.message : "Lỗi merge");
    } finally {
      setIsMerging(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-slate-200/80 bg-white p-5 shadow-xs">
        <h2 className="text-base font-bold text-slate-900">Xử lý Merge tài liệu Tập nghề</h2>
        <p className="mt-1 text-xs text-slate-500">
          Chọn ứng viên đã xếp việc. Hệ thống tự áp dụng <b>Tài liệu A</b> (DW Cũ — Cam kết / Tái ký)
          hoặc <b>Tài liệu B</b> (DW Mới — Hợp đồng đào tạo nghề).
        </p>
      </div>

      {mergeSuccess && (
        <div className="rounded-2xl border border-emerald-300 bg-emerald-50/80 p-5">
          <div className="flex items-start gap-3">
            <CheckCircle2 className="mt-0.5 h-6 w-6 text-emerald-700" />
            <div className="flex-1">
              <p className="font-bold text-emerald-950">Hoàn tất merge</p>
              <p className="mt-1 text-xs text-emerald-800">
                Job {mergeSuccess.jobId}
                {mergeSuccess.dispatchedCount > 0
                  ? ` — đã đẩy ${mergeSuccess.dispatchedCount} tài liệu đến hồ sơ tra cứu.`
                  : ""}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {mergeSuccess.printUrl && (
                  <a
                    href={mergeSuccess.printUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-bold text-white"
                  >
                    <ExternalLink className="h-3.5 w-3.5" /> Mở file in (page break)
                  </a>
                )}
                {mergeSuccess.outputUrl && !mergeSuccess.printUrl && (
                  <a
                    href={mergeSuccess.outputUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-bold text-white"
                  >
                    <ExternalLink className="h-3.5 w-3.5" /> Mở Google Docs
                  </a>
                )}
                <button
                  type="button"
                  onClick={onSwitchToHistory}
                  className="rounded-lg border border-emerald-300 bg-white px-3 py-1.5 text-xs font-semibold text-emerald-800"
                >
                  Xem lịch sử
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {mergeError && (
        <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          {mergeError}
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="space-y-4 rounded-xl border border-slate-200/80 bg-white p-4 shadow-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-bold text-slate-900">Danh sách đã xếp việc</h3>
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-bold text-emerald-800">
              {selectedIds.size}/{filtered.length}
            </span>
          </div>

          <label className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50/60 p-3 text-xs">
            <input type="checkbox" checked={autoRoute} onChange={(e) => setAutoRoute(e.target.checked)} className="mt-0.5" />
            <span>
              <b>Tự động áp dụng mẫu theo phân loại DW</b>
              <span className="mt-0.5 block text-[11px] text-slate-500">
                DW Cũ → Tài liệu A (Cam kết / Tái ký). DW Mới → Tài liệu B (Hợp đồng đào tạo nghề).
              </span>
            </span>
          </label>

          {!autoRoute && (
            <select
              value={templateId}
              onChange={(e) => {
                setTemplateId(e.target.value);
                onSelectTemplateId(e.target.value);
              }}
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs"
            >
              <option value="">-- Chọn template --</option>
              {templates.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} ({documentKindLabel(item.documentKind)})
                </option>
              ))}
            </select>
          )}

          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Tìm họ tên / CCCD / SĐT"
              className="w-full rounded-lg border border-slate-200 py-1.5 pl-8 pr-3 text-xs"
            />
          </div>

          <div className="flex items-center justify-between text-[11px]">
            <button type="button" onClick={toggleAll} className="font-semibold text-emerald-800">
              {selectedIds.size === filtered.length && filtered.length > 0 ? "Bỏ chọn tất cả" : "Chọn tất cả"}
            </button>
            {selectedTemplate && !autoRoute && (
              <span className="text-slate-500">Mẫu: {selectedTemplate.name}</span>
            )}
          </div>

          <div className="max-h-[460px] overflow-y-auto rounded-lg border border-slate-100">
            {loadingRecords ? (
              <p className="p-6 text-center text-xs text-slate-400">Đang tải ứng viên đã xếp việc...</p>
            ) : filtered.length === 0 ? (
              <p className="p-6 text-center text-xs text-slate-500">
                Không có ứng viên đã xếp việc (có bộ phận) trong 14 ngày gần đây.
              </p>
            ) : (
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="px-3 py-2"> </th>
                    <th className="px-3 py-2">Ứng viên</th>
                    <th className="px-3 py-2">DW / Mẫu</th>
                    <th className="px-3 py-2">Bộ phận</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filtered.map((row) => {
                    const kind = resolveDocumentKind({ declaredType: row.declaredType, dwMatch: row.dwMatch });
                    const dw = resolveDwClassification({ declaredType: row.declaredType, dwMatch: row.dwMatch });
                    const selected = selectedIds.has(row.id);
                    return (
                      <tr
                        key={row.id}
                        onClick={() => {
                          toggleOne(row.id);
                          void loadPreview(row.id);
                        }}
                        className={`cursor-pointer ${selected ? "bg-emerald-50/70" : "hover:bg-slate-50"} ${
                          previewTargetId === row.id ? "ring-1 ring-inset ring-emerald-300" : ""
                        }`}
                      >
                        <td className="px-3 py-2">
                          <input type="checkbox" checked={selected} readOnly className="accent-emerald-700" />
                        </td>
                        <td className="px-3 py-2">
                          <div className="font-semibold text-slate-900">{row.fullName}</div>
                          <div className="font-mono text-[10px] text-slate-500">{row.cccd}</div>
                          {row.signatureConfirmedAt && (
                            <div className="text-[10px] font-bold text-emerald-700">Đã ký</div>
                          )}
                          {row.documentSentAt && !row.signatureConfirmedAt && (
                            <div className="text-[10px] text-amber-700">Đã gửi, chờ ký</div>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold ${
                              dw === "OLD" ? "bg-sky-100 text-sky-800" : "bg-amber-100 text-amber-800"
                            }`}
                          >
                            {dw === "OLD" ? "DW Cũ" : "DW Mới"}
                          </span>
                          <div className="mt-1 text-[10px] font-semibold text-slate-600">Tài liệu {kind}</div>
                        </td>
                        <td className="px-3 py-2 text-slate-600">
                          {row.deptName || "—"}
                          {row.startingDate && <div className="text-[10px] text-slate-400">{row.startingDate}</div>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <section className="flex min-h-[520px] flex-col rounded-xl border border-slate-200/80 bg-white p-4 shadow-xs">
          <div className="flex items-center justify-between gap-2 border-b border-slate-100 pb-3">
            <h3 className="text-sm font-bold text-slate-900">Preview tài liệu</h3>
            <button
              type="button"
              onClick={() => void loadPreview()}
              disabled={previewLoading}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              <Eye className="h-3.5 w-3.5" />
              {previewLoading ? "Đang tải..." : "Preview"}
            </button>
          </div>

          <div className="mt-3 flex-1 overflow-y-auto rounded-lg bg-slate-50 p-4 text-xs leading-relaxed text-slate-800">
            {!preview && !previewLoading && (
              <p className="text-center text-slate-400">
                Chọn một ứng viên rồi nhấn Preview để xem nội dung merge với dữ liệu thật.
              </p>
            )}
            {previewLoading && <p className="text-center text-slate-400">Đang merge thử...</p>}
            {preview && (
              <div className="space-y-3">
                <div className="rounded-lg bg-white p-3 shadow-xs">
                  <p className="font-bold text-slate-900">{preview.fullName}</p>
                  <p className="font-mono text-[11px] text-slate-500">{preview.cccd}</p>
                  <p className="mt-1 text-[11px] text-emerald-800">
                    {preview.dwClassification === "OLD" ? "DW Cũ" : "DW Mới"} → {preview.documentKindLabel}
                  </p>
                  <p className="text-[11px] text-slate-500">Mẫu: {preview.templateName}</p>
                </div>
                <pre className="whitespace-pre-wrap font-sans text-[12px] text-slate-800">{preview.content}</pre>
                {(preview.missingFields.length > 0 || preview.unreplaced.length > 0) && (
                  <p className="rounded-lg bg-amber-50 p-2 text-[11px] text-amber-800">
                    Trường thiếu / chưa thay: {[...preview.missingFields, ...preview.unreplaced].join(", ")}
                  </p>
                )}
              </div>
            )}
          </div>

          <div className="mt-4 space-y-3 border-t border-slate-100 pt-4">
            <label className="flex items-start gap-2 rounded-lg border border-slate-200 p-3 text-xs">
              <input
                type="checkbox"
                checked={batchPrint}
                onChange={(e) => setBatchPrint(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                <b>Merge toàn bộ danh sách để xuất file in (Có Page Break)</b>
                <span className="mt-0.5 block text-[11px] text-slate-500">
                  Gộp toàn bộ danh sách vào 1 file Google Docs, tự chèn dấu ngắt trang giữa từng người.
                </span>
              </span>
            </label>

            <div className="grid gap-2 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => void loadPreview()}
                disabled={previewLoading || selectedIds.size === 0}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 bg-white py-2.5 text-xs font-semibold text-slate-700 disabled:opacity-50"
              >
                <FileCheck className="h-3.5 w-3.5" /> Preview
              </button>
              <button
                type="button"
                onClick={() => void execute(true)}
                disabled={isMerging || selectedIds.size === 0}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-emerald-700 py-2.5 text-xs font-bold text-white shadow-sm hover:bg-emerald-800 disabled:opacity-50"
              >
                <Send className="h-3.5 w-3.5" />
                {isMerging ? "Đang đẩy..." : "Đẩy tài liệu merge đến Người tìm việc"}
              </button>
            </div>
            <button
              type="button"
              onClick={() => void execute(false)}
              disabled={isMerging || selectedIds.size === 0}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 py-2 text-xs font-semibold text-emerald-800 disabled:opacity-50"
            >
              <Sparkles className="h-3.5 w-3.5" />
              Chỉ xuất file (không gửi ứng viên)
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
