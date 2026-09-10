"use client";

/**
 * Admin status panel for "Hồ sơ xác nhận điện tử" (candidate document
 * issuance + consent). GET status list is STRICTLY READ-ONLY (see the
 * route — it performs zero mutations).
 *
 * Two SEPARATE write-side actions advance a document, on purpose:
 *   1. GENERATING -> READY (SYSTEM decision): this panel polls the
 *      explicit write-side POST /finalize on an interval WHILE any row is
 *      GENERATING — that route only materializes the immutable PDF+SHA-256
 *      and stops. It NEVER releases anything to the candidate.
 *   2. READY -> ISSUED (STAFF decision): "Phát hành" (single, via
 *      POST .../[id]/issue) or "Phát hành hồ sơ đã sẵn sàng" (batch, via
 *      POST .../issue-ready) — an explicit click, never automatic. Only
 *      after this does the candidate's public document list expose it.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Eye, FileCheck2, Printer, RefreshCw, RotateCcw, Send, ShieldCheck, Timer, XCircle } from "lucide-react";
import { CONFIRMATION_DEADLINE_DAY_PRESETS, DEFAULT_CONFIRMATION_WINDOW_DAYS, formatDeadline, formatRemainingTime } from "@/lib/candidate-consent/confirmation-deadline";

const STATUS_LABEL: Record<string, string> = {
  GENERATING: "ĐANG TẠO",
  READY: "SẴN SÀNG",
  ISSUED: "ĐÃ PHÁT HÀNH",
  VIEWED: "ĐÃ XEM",
  CONFIRMED: "ĐÃ XÁC NHẬN",
  REVOKED: "ĐÃ THU HỒI",
  SUPERSEDED: "ĐÃ THAY THẾ",
  EXPIRED: "HẾT HẠN",
  FAILED: "LỖI",
};

const STATUS_COLOR: Record<string, string> = {
  GENERATING: "bg-slate-100 text-slate-600",
  READY: "bg-amber-100 text-amber-700",
  ISSUED: "bg-blue-100 text-blue-700",
  VIEWED: "bg-amber-100 text-amber-700",
  CONFIRMED: "bg-emerald-100 text-emerald-700",
  REVOKED: "bg-red-100 text-red-700",
  SUPERSEDED: "bg-slate-200 text-slate-600",
  EXPIRED: "bg-slate-200 text-slate-600",
  FAILED: "bg-red-100 text-red-700",
};

const REVOCABLE = new Set(["READY", "ISSUED", "VIEWED"]);
// A PDF exists (storageKey set) from READY onward — never for GENERATING/
// FAILED. Staff can preview READY documents BEFORE issuing them, unlike the
// candidate-facing route which requires ISSUED+ (see the pdf route's own
// docblock for why the gate deliberately differs).
const HAS_PDF_STATUSES = new Set(["READY", "ISSUED", "VIEWED", "CONFIRMED", "REVOKED", "SUPERSEDED", "EXPIRED"]);
// A confirmation deadline is only ever enforced/extendable while the
// PERSISTED status is still ISSUED/VIEWED (the same two statuses
// effectiveStatus() derives EXPIRED from) — matches extend-deadline/route.ts's
// own EXTENDABLE_STATUSES exactly.
const EXTENDABLE = new Set(["ISSUED", "VIEWED"]);
const FINALIZE_POLL_MS = 4000;

type CandidateDocumentRow = {
  id: string;
  applicationId: string;
  status: string;
  effectiveStatus: string;
  applicantFullName: string | null;
  templateName: string | null;
  issuedAt: string | null;
  viewedAt: string | null;
  confirmationDeadlineAt: string | null;
  engagementStartingDate: string | null;
  errorMessage: string | null;
  confirmation: { confirmedAtServer: string; receiptId: string } | null;
};

type Summary = { total: number; generating: number; ready: number; issued: number; viewed: number; confirmed: number; failed: number; expired: number };

/** "3 ngày" | "5 ngày" | ... | "Tuỳ chỉnh" — compact preset selector shared by single/batch issue AND Gia hạn, so every issuance in one admin session uses ONE deliberately-chosen policy instead of re-typing it per row. */
function useDeadlinePolicy() {
  const [days, setDays] = useState<number>(DEFAULT_CONFIRMATION_WINDOW_DAYS);
  const [customAt, setCustomAt] = useState<string>("");
  const [useCustom, setUseCustom] = useState(false);

  const body = useCustom && customAt ? { deadlineAt: new Date(customAt).toISOString() } : { deadlineDays: days };
  const label = useCustom && customAt ? `đến ${new Date(customAt).toLocaleString("vi-VN")}` : `${days} ngày`;

  const picker = (
    <div className="flex items-center gap-1.5 text-[11px]">
      <Timer className="h-3.5 w-3.5 text-slate-400" />
      <select
        aria-label="Hạn xác nhận"
        value={useCustom ? "custom" : String(days)}
        onChange={(e) => {
          if (e.target.value === "custom") {
            setUseCustom(true);
          } else {
            setUseCustom(false);
            setDays(Number(e.target.value));
          }
        }}
        className="rounded-lg border border-slate-200 px-1.5 py-0.5 text-[11px] font-semibold text-slate-600"
      >
        {CONFIRMATION_DEADLINE_DAY_PRESETS.map((d) => (
          <option key={d} value={d}>
            {d} ngày
          </option>
        ))}
        <option value="custom">Tuỳ chỉnh...</option>
      </select>
      {useCustom && (
        <input
          type="datetime-local"
          aria-label="Hạn xác nhận tuỳ chỉnh"
          value={customAt}
          onChange={(e) => setCustomAt(e.target.value)}
          className="rounded-lg border border-slate-200 px-1.5 py-0.5 text-[11px]"
        />
      )}
    </div>
  );

  return { body, label, picker };
}

export function CandidateDocumentsStatusPanel() {
  const [documents, setDocuments] = useState<CandidateDocumentRow[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [reissuingId, setReissuingId] = useState<string | null>(null);
  const [issuingId, setIssuingId] = useState<string | null>(null);
  const [batchIssuing, setBatchIssuing] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkIssuing, setBulkIssuing] = useState(false);
  const [extendingId, setExtendingId] = useState<string | null>(null);
  const finalizingRef = useRef(false);
  const deadlinePolicy = useDeadlinePolicy();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/document-merge/candidate-documents", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setDocuments(data.documents ?? []);
      setSummary(data.summary ?? null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Prune the selection whenever the row set refreshes — a document that
  // left READY (issued by this action, by another staff member, or revoked)
  // must never remain selected, and a bulk request must never re-target it.
  useEffect(() => {
    setSelectedIds((prev) => {
      const readyNow = new Set(documents.filter((d) => d.status === "READY").map((d) => d.id));
      const next = new Set([...prev].filter((id) => readyNow.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [documents]);

  // Write-side finalizer poll: explicit POST, only while something is
  // GENERATING, never a passive side effect of the read-only GET above.
  // Stops strictly at READY — never advances to ISSUED on its own.
  useEffect(() => {
    if (!summary || summary.generating === 0) return;
    const timer = setTimeout(async () => {
      if (finalizingRef.current) return;
      finalizingRef.current = true;
      try {
        await fetch("/api/document-merge/candidate-documents/finalize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
      } finally {
        finalizingRef.current = false;
        await load();
      }
    }, FINALIZE_POLL_MS);
    return () => clearTimeout(timer);
  }, [summary, load]);

  const issueOne = async (id: string) => {
    setIssuingId(id);
    try {
      const res = await fetch(`/api/document-merge/candidate-documents/${id}/issue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(deadlinePolicy.body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || "Không phát hành được.");
        return;
      }
      await load();
    } finally {
      setIssuingId(null);
    }
  };

  const issueAllReady = async () => {
    if (!summary || summary.ready === 0) return;
    if (!confirm(`Phát hành ${summary.ready} hồ sơ đang SẴN SÀNG cho ứng viên? Hạn xác nhận: ${deadlinePolicy.label}.`)) return;
    setBatchIssuing(true);
    try {
      const res = await fetch("/api/document-merge/candidate-documents/issue-ready", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(deadlinePolicy.body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || "Không phát hành được.");
        return;
      }
      await load();
    } finally {
      setBatchIssuing(false);
    }
  };

  const extendDeadline = async (id: string) => {
    if (!confirm(`Gia hạn hồ sơ này thêm thời gian? Hạn mới: ${deadlinePolicy.label}.`)) return;
    setExtendingId(id);
    try {
      const res = await fetch(`/api/document-merge/candidate-documents/${id}/extend-deadline`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(deadlinePolicy.body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || "Không gia hạn được.");
        return;
      }
      await load();
    } finally {
      setExtendingId(null);
    }
  };

  const readyDocuments = documents.filter((d) => d.status === "READY");
  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const allReadySelected = readyDocuments.length > 0 && readyDocuments.every((d) => selectedIds.has(d.id));
  const toggleSelectAll = () => {
    setSelectedIds((prev) => {
      // Toggling never trusts client-side staleness blindly: it operates
      // strictly on the CURRENTLY VISIBLE READY rows, and the server still
      // independently re-checks status='READY' via its own CAS UPDATE
      // regardless of what this selection sends.
      if (allReadySelected) return new Set();
      return new Set(readyDocuments.map((d) => d.id));
    });
  };

  const issueSelected = async () => {
    if (selectedIds.size === 0) return;
    const ids = [...selectedIds];
    if (!confirm(`Phát hành ${ids.length} hồ sơ đã chọn cho ứng viên? Hạn xác nhận: ${deadlinePolicy.label}.`)) return;
    setBulkIssuing(true);
    try {
      const res = await fetch("/api/document-merge/candidate-documents/issue-ready", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, ...deadlinePolicy.body }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || "Không phát hành được.");
        return;
      }
      const data: { results?: { id: string; outcome: string }[] } = await res.json().catch(() => ({}));
      const notReady = (data.results ?? []).filter((r) => r.outcome === "not_ready").length;
      if (notReady > 0) {
        alert(`${notReady} hồ sơ trong số đã chọn không còn ở trạng thái SẴN SÀNG (có thể đã được phát hành/thu hồi bởi thao tác khác) — đã bỏ qua, các hồ sơ còn lại vẫn được phát hành.`);
      }
      setSelectedIds(new Set());
      await load();
    } finally {
      setBulkIssuing(false);
    }
  };

  const revoke = async (id: string) => {
    if (!confirm("Thu hồi hồ sơ này? Ứng viên sẽ không thể xem/xác nhận nữa.")) return;
    setRevokingId(id);
    try {
      const res = await fetch(`/api/document-merge/candidate-documents/${id}/revoke`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || "Không thu hồi được.");
        return;
      }
      await load();
    } finally {
      setRevokingId(null);
    }
  };

  const reissue = async (id: string) => {
    if (!confirm("Thu hồi hồ sơ này và tạo lại một hồ sơ mới cho ứng viên? Hồ sơ cũ sẽ được đánh dấu ĐÃ THAY THẾ (không xoá) và ứng viên sẽ cần xác nhận lại hồ sơ mới.")) return;
    setReissuingId(id);
    try {
      const res = await fetch(`/api/document-merge/candidate-documents/${id}/reissue`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || "Không tạo lại được hồ sơ.");
        return;
      }
      await load();
    } finally {
      setReissuingId(null);
    }
  };

  if (documents.length === 0 && !loading && !summary) return null;

  return (
    <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-bold text-slate-900">
          <ShieldCheck className="h-4 w-4 text-indigo-700" /> Hồ sơ xác nhận điện tử
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          {deadlinePolicy.picker}
          {selectedIds.size > 0 && (
            <button
              type="button"
              onClick={() => void issueSelected()}
              disabled={bulkIssuing}
              className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1 text-[11px] font-bold text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              <Send className="h-3 w-3" /> {bulkIssuing ? "Đang phát hành..." : `Phát hành đã chọn (${selectedIds.size})`}
            </button>
          )}
          {summary && summary.ready > 0 && (
            <button
              type="button"
              onClick={() => void issueAllReady()}
              disabled={batchIssuing}
              className="inline-flex items-center gap-1 rounded-lg bg-amber-600 px-2.5 py-1 text-[11px] font-bold text-white hover:bg-amber-700 disabled:opacity-50"
            >
              <Send className="h-3 w-3" /> {batchIssuing ? "Đang phát hành..." : `Phát hành hồ sơ đã sẵn sàng (${summary.ready})`}
            </button>
          )}
          <button type="button" onClick={() => void load()} disabled={loading} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50">
            <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} /> Làm mới
          </button>
        </div>
      </div>

      {selectedIds.size > 0 && (
        <p className="mt-2 text-[11px] font-semibold text-emerald-700">Đã chọn {selectedIds.size} hồ sơ SẴN SÀNG.</p>
      )}

      {summary && (
        <div className="mt-2 flex flex-wrap gap-2 text-[10px] font-semibold">
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">Tổng {summary.total}</span>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">Đang tạo {summary.generating}</span>
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-700">Sẵn sàng (chưa phát hành) {summary.ready}</span>
          <span className="rounded-full bg-blue-100 px-2 py-0.5 text-blue-700">Đã phát hành {summary.issued}</span>
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-700">Đã xem {summary.viewed}</span>
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-emerald-700">Đã xác nhận {summary.confirmed}</span>
          {summary.expired > 0 && <span className="rounded-full bg-slate-200 px-2 py-0.5 text-slate-700">Hết hạn chưa xác nhận {summary.expired}</span>}
          {summary.failed > 0 && <span className="rounded-full bg-red-100 px-2 py-0.5 text-red-700">Lỗi {summary.failed}</span>}
        </div>
      )}

      <div className="mt-3 max-h-80 overflow-y-auto">
        <table className="w-full text-left text-[11px]">
          <thead className="sticky top-0 bg-white text-slate-400">
            <tr>
              <th className="py-1.5 pr-2 font-semibold">
                {readyDocuments.length > 0 && (
                  <input
                    type="checkbox"
                    aria-label="Chọn tất cả hồ sơ sẵn sàng"
                    title="Chọn tất cả"
                    checked={allReadySelected}
                    onChange={toggleSelectAll}
                  />
                )}
              </th>
              <th className="py-1.5 pr-2 font-semibold">Ứng viên</th>
              <th className="py-1.5 pr-2 font-semibold">Mẫu</th>
              <th className="py-1.5 pr-2 font-semibold">Trạng thái</th>
              <th className="py-1.5 pr-2 font-semibold">Ngày bắt đầu</th>
              <th className="py-1.5 pr-2 font-semibold">Hạn xác nhận</th>
              <th className="py-1.5 pr-2 font-semibold">Xác nhận</th>
              <th className="py-1.5 font-semibold"></th>
            </tr>
          </thead>
          <tbody>
            {documents.map((doc) => {
              // Effective status (server-derived EXPIRED) drives the badge —
              // the raw persisted `status` (still ISSUED/VIEWED) is what
              // action availability (Gia hạn/Thu hồi/Tạo lại) is keyed off,
              // exactly matching effectiveStatus()'s own contract: a
              // document can be "EXPIRED" for display while its underlying
              // lifecycle status hasn't actually transitioned.
              const displayStatus = doc.effectiveStatus ?? doc.status;
              const isExpiredDisplay = displayStatus === "EXPIRED";
              return (
              <tr key={doc.id} className="border-t border-slate-100">
                <td className="py-1.5 pr-2">
                  {doc.status === "READY" && (
                    <input
                      type="checkbox"
                      aria-label={`Chọn hồ sơ của ${doc.applicantFullName ?? doc.id}`}
                      checked={selectedIds.has(doc.id)}
                      onChange={() => toggleSelected(doc.id)}
                    />
                  )}
                </td>
                <td className="py-1.5 pr-2 text-slate-800">{doc.applicantFullName ?? "—"}</td>
                <td className="py-1.5 pr-2 text-slate-500">{doc.templateName ?? "—"}</td>
                <td className="py-1.5 pr-2">
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${STATUS_COLOR[displayStatus] ?? "bg-slate-100 text-slate-600"}`}>
                    {STATUS_LABEL[displayStatus] ?? displayStatus}
                  </span>
                  {doc.status === "FAILED" && doc.errorMessage && <p className="mt-0.5 text-[10px] text-red-600">{doc.errorMessage}</p>}
                </td>
                <td className="py-1.5 pr-2 text-slate-500">{doc.engagementStartingDate ?? "—"}</td>
                <td className="py-1.5 pr-2 text-slate-500">
                  {doc.confirmationDeadlineAt ? (
                    <>
                      {formatDeadline(doc.confirmationDeadlineAt)}
                      {!isExpiredDisplay && EXTENDABLE.has(doc.status) && (
                        <span className="ml-1 text-slate-400">({formatRemainingTime(doc.confirmationDeadlineAt, new Date()) ?? "—"})</span>
                      )}
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="py-1.5 pr-2 text-slate-500">{doc.confirmation ? doc.confirmation.receiptId : "—"}</td>
                <td className="py-1.5 text-right">
                  <div className="flex justify-end gap-1">
                    {EXTENDABLE.has(doc.status) && (
                      <button
                        type="button"
                        onClick={() => void extendDeadline(doc.id)}
                        disabled={extendingId === doc.id}
                        title="Gia hạn"
                        className="inline-flex items-center gap-1 rounded-lg border border-amber-200 px-2 py-0.5 text-[10px] font-semibold text-amber-700 hover:bg-amber-50 disabled:opacity-50"
                      >
                        <Timer className="h-3 w-3" /> Gia hạn
                      </button>
                    )}
                    {HAS_PDF_STATUSES.has(doc.status) && (
                      <>
                        <a
                          href={`/api/document-merge/candidate-documents/${doc.id}/pdf?mode=view`}
                          target="_blank"
                          rel="noreferrer"
                          title="Xem PDF"
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-600 hover:bg-slate-50"
                        >
                          <Eye className="h-3 w-3" /> Xem
                        </a>
                        <a
                          href={`/api/document-merge/candidate-documents/${doc.id}/pdf?mode=download`}
                          title="Tải PDF"
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-600 hover:bg-slate-50"
                        >
                          <Download className="h-3 w-3" /> Tải
                        </a>
                        <a
                          href={`/api/document-merge/candidate-documents/${doc.id}/pdf?mode=view`}
                          target="_blank"
                          rel="noreferrer"
                          title="In PDF (mở PDF gốc — dùng nút In của trình xem PDF)"
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-0.5 text-[10px] font-semibold text-slate-600 hover:bg-slate-50"
                        >
                          <Printer className="h-3 w-3" /> In
                        </a>
                      </>
                    )}
                    {doc.status === "CONFIRMED" && doc.confirmation && (
                      <>
                        <a
                          href={`/xac-thuc-ho-so/${encodeURIComponent(doc.confirmation.receiptId)}/bien-nhan`}
                          target="_blank"
                          rel="noreferrer"
                          title="Xem biên nhận xác nhận điện tử"
                          className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 hover:bg-emerald-50"
                        >
                          <FileCheck2 className="h-3 w-3" /> Xem biên nhận
                        </a>
                        <a
                          href={`/xac-thuc-ho-so/${encodeURIComponent(doc.confirmation.receiptId)}/bien-nhan?print=1`}
                          target="_blank"
                          rel="noreferrer"
                          title="Tải biên nhận (mở hộp thoại in — chọn 'Lưu dưới dạng PDF')"
                          className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 hover:bg-emerald-50"
                        >
                          <Download className="h-3 w-3" /> Tải biên nhận
                        </a>
                        <a
                          href={`/xac-thuc-ho-so/${encodeURIComponent(doc.confirmation.receiptId)}`}
                          target="_blank"
                          rel="noreferrer"
                          title="Xác thực công khai (trang bên thứ ba dùng để kiểm tra)"
                          className="inline-flex items-center gap-1 rounded-lg border border-indigo-200 px-2 py-0.5 text-[10px] font-semibold text-indigo-700 hover:bg-indigo-50"
                        >
                          <ShieldCheck className="h-3 w-3" /> Xác thực
                        </a>
                      </>
                    )}
                    {doc.status === "READY" && (
                      <button
                        type="button"
                        onClick={() => void issueOne(doc.id)}
                        disabled={issuingId === doc.id}
                        className="inline-flex items-center gap-1 rounded-lg bg-amber-600 px-2 py-0.5 text-[10px] font-bold text-white hover:bg-amber-700 disabled:opacity-50"
                      >
                        <Send className="h-3 w-3" /> Phát hành
                      </button>
                    )}
                    {REVOCABLE.has(doc.status) && (
                      <>
                        <button
                          type="button"
                          onClick={() => void reissue(doc.id)}
                          disabled={reissuingId === doc.id}
                          title="Thu hồi & tạo lại"
                          className="inline-flex items-center gap-1 rounded-lg border border-indigo-200 px-2 py-0.5 text-[10px] font-semibold text-indigo-700 hover:bg-indigo-50 disabled:opacity-50"
                        >
                          <RotateCcw className="h-3 w-3" /> Tạo lại
                        </button>
                        <button
                          type="button"
                          onClick={() => void revoke(doc.id)}
                          disabled={revokingId === doc.id}
                          className="inline-flex items-center gap-1 rounded-lg border border-red-200 px-2 py-0.5 text-[10px] font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
                        >
                          <XCircle className="h-3 w-3" /> Thu hồi
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
