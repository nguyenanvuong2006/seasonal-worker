"use client";

/**
 * Admin status panel for "Hồ sơ xác nhận điện tử" (candidate document
 * issuance + consent). Read-only status + Thu hồi (revoke) — actual
 * generation is triggered by the "Tạo & gửi hồ sơ xác nhận" button in
 * MergeWorkspace. Polls GET /api/document-merge/candidate-documents, which
 * also lazily promotes any row still GENERATING (see promote.ts) — so this
 * panel reflects live progress without a separate cron.
 */

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, ShieldCheck, XCircle } from "lucide-react";

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
  READY: "bg-slate-100 text-slate-600",
  ISSUED: "bg-blue-100 text-blue-700",
  VIEWED: "bg-amber-100 text-amber-700",
  CONFIRMED: "bg-emerald-100 text-emerald-700",
  REVOKED: "bg-red-100 text-red-700",
  SUPERSEDED: "bg-slate-200 text-slate-600",
  EXPIRED: "bg-slate-200 text-slate-600",
  FAILED: "bg-red-100 text-red-700",
};

type CandidateDocumentRow = {
  id: string;
  applicationId: string;
  status: string;
  applicantFullName: string | null;
  templateName: string | null;
  issuedAt: string | null;
  viewedAt: string | null;
  errorMessage: string | null;
  confirmation: { confirmedAtServer: string; receiptId: string } | null;
};

type Summary = { total: number; generating: number; ready: number; issued: number; viewed: number; confirmed: number; failed: number };

export function CandidateDocumentsStatusPanel() {
  const [documents, setDocuments] = useState<CandidateDocumentRow[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

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

  if (documents.length === 0 && !loading && !summary) return null;

  return (
    <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-bold text-slate-900">
          <ShieldCheck className="h-4 w-4 text-indigo-700" /> Hồ sơ xác nhận điện tử
        </h3>
        <button type="button" onClick={() => void load()} disabled={loading} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-50">
          <RefreshCw className={`h-3 w-3 ${loading ? "animate-spin" : ""}`} /> Làm mới
        </button>
      </div>

      {summary && (
        <div className="mt-2 flex flex-wrap gap-2 text-[10px] font-semibold">
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">Tổng {summary.total}</span>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-600">Đang tạo {summary.generating}</span>
          <span className="rounded-full bg-blue-100 px-2 py-0.5 text-blue-700">Đã phát hành {summary.issued}</span>
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-700">Đã xem {summary.viewed}</span>
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-emerald-700">Đã xác nhận {summary.confirmed}</span>
          {summary.failed > 0 && <span className="rounded-full bg-red-100 px-2 py-0.5 text-red-700">Lỗi {summary.failed}</span>}
        </div>
      )}

      <div className="mt-3 max-h-80 overflow-y-auto">
        <table className="w-full text-left text-[11px]">
          <thead className="sticky top-0 bg-white text-slate-400">
            <tr>
              <th className="py-1.5 pr-2 font-semibold">Ứng viên</th>
              <th className="py-1.5 pr-2 font-semibold">Mẫu</th>
              <th className="py-1.5 pr-2 font-semibold">Trạng thái</th>
              <th className="py-1.5 pr-2 font-semibold">Xác nhận</th>
              <th className="py-1.5 font-semibold"></th>
            </tr>
          </thead>
          <tbody>
            {documents.map((doc) => (
              <tr key={doc.id} className="border-t border-slate-100">
                <td className="py-1.5 pr-2 text-slate-800">{doc.applicantFullName ?? "—"}</td>
                <td className="py-1.5 pr-2 text-slate-500">{doc.templateName ?? "—"}</td>
                <td className="py-1.5 pr-2">
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${STATUS_COLOR[doc.status] ?? "bg-slate-100 text-slate-600"}`}>
                    {STATUS_LABEL[doc.status] ?? doc.status}
                  </span>
                  {doc.status === "FAILED" && doc.errorMessage && <p className="mt-0.5 text-[10px] text-red-600">{doc.errorMessage}</p>}
                </td>
                <td className="py-1.5 pr-2 text-slate-500">{doc.confirmation ? doc.confirmation.receiptId : "—"}</td>
                <td className="py-1.5 text-right">
                  {["READY", "ISSUED", "VIEWED"].includes(doc.status) && (
                    <button
                      type="button"
                      onClick={() => void revoke(doc.id)}
                      disabled={revokingId === doc.id}
                      className="inline-flex items-center gap-1 rounded-lg border border-red-200 px-2 py-0.5 text-[10px] font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
                    >
                      <XCircle className="h-3 w-3" /> Thu hồi
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
