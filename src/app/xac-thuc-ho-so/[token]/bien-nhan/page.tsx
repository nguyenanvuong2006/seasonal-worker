"use client";

/**
 * "BIÊN NHẬN XÁC NHẬN ĐIỆN TỬ" — printable/downloadable receipt. Public,
 * read-only, same DTO source as the verification page. NOT the original
 * signed PDF — an evidence SUMMARY only, so it never carries CCCD/phone/
 * IP/User-Agent/HMAC/secret, same privacy rules as the verification page.
 *
 * "Tải biên nhận" (download) reuses the browser's own print-to-PDF, same
 * convention already used by the admin PDF "In" action elsewhere in this
 * app (no new server-side PDF rendering pipeline needed for a one-page
 * text summary) — passing ?print=1 auto-opens the print dialog on load.
 */

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import QRCode from "qrcode";
import { formatConfirmedAt, abbreviateHash, statusPresentation } from "@/lib/candidate-consent/verification-display";
import { Printer } from "lucide-react";

type VerificationDto = {
  status: "VALID" | "REVOKED" | "SUPERSEDED" | "INVALID" | "NOT_FOUND";
  receiptId: string;
  candidateDisplayName: string | null;
  documentName: string | null;
  documentVersion: number | null;
  confirmedAtServer: string;
  verificationMethodLabel: string;
  pdfSha256: string;
  technicalAccessEvidencePresent: boolean;
};

export default function ReceiptPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token ?? "";
  // Lazy initializer — read once, synchronously, never via a setState-in-
  // effect cascade (window.location.search cannot change without a fresh
  // mount of this page).
  const [autoPrint] = useState(() => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("print") === "1");
  const verifyUrl = typeof window !== "undefined" ? `${window.location.origin}/xac-thuc-ho-so/${encodeURIComponent(token)}` : "";

  const [dto, setDto] = useState<VerificationDto | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/xac-thuc-ho-so/${encodeURIComponent(token)}`, { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.status === 404 || data.status === "NOT_FOUND") {
          setNotFound(true);
          return;
        }
        if (res.ok) setDto(data as VerificationDto);
      } catch {
        /* leave dto null — renders nothing rather than a broken receipt */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (!verifyUrl) return;
    QRCode.toDataURL(verifyUrl, { margin: 1, width: 160 })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(null));
  }, [verifyUrl]);

  useEffect(() => {
    if (autoPrint && dto) {
      const timer = setTimeout(() => window.print(), 300);
      return () => clearTimeout(timer);
    }
  }, [autoPrint, dto]);

  if (notFound) {
    return (
      <div className="mx-auto max-w-md p-6 text-center text-sm text-slate-500">
        Không tìm thấy hồ sơ xác nhận nào khớp với mã này.
      </div>
    );
  }
  if (!dto) {
    return <div className="mx-auto max-w-md p-6 text-center text-sm text-slate-500">Đang tải...</div>;
  }

  const presentation = statusPresentation(dto.status);

  return (
    <div className="mx-auto max-w-xl bg-white p-8 text-slate-900 print:p-0">
      <div className="mb-4 flex items-center justify-between print:hidden">
        <p className="text-xs text-slate-400">Xem trước biên nhận</p>
        <button
          type="button"
          onClick={() => window.print()}
          className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-indigo-700"
        >
          <Printer className="h-3.5 w-3.5" /> In / Tải biên nhận (PDF)
        </button>
      </div>

      <div className="border-2 border-slate-800 p-6">
        <div className="mb-4 border-b border-slate-300 pb-3 text-center">
          <p className="text-sm font-bold uppercase tracking-wide text-slate-800">Dalat Hasfarm — Chương trình tập nghề thời vụ</p>
          <h1 className="mt-1 text-lg font-black uppercase tracking-wide text-slate-900">Biên nhận xác nhận điện tử</h1>
        </div>

        <table className="w-full text-sm">
          <tbody>
            <ReceiptRow label="Mã biên nhận / xác nhận" value={dto.receiptId} mono />
            {dto.candidateDisplayName && <ReceiptRow label="Họ và tên ứng viên" value={dto.candidateDisplayName} />}
            {dto.documentName && <ReceiptRow label="Tên tài liệu" value={dto.documentName} />}
            {dto.documentVersion !== null && <ReceiptRow label="Phiên bản tài liệu" value={`v${dto.documentVersion}`} />}
            <ReceiptRow label="Thời gian xác nhận" value={formatConfirmedAt(dto.confirmedAtServer)} />
            <ReceiptRow label="Phương thức xác thực" value={dto.verificationMethodLabel} />
            <ReceiptRow label="Mã băm PDF (SHA-256)" value={abbreviateHash(dto.pdfSha256)} mono />
            <ReceiptRow label="Trạng thái xác thực" value={presentation.label} />
          </tbody>
        </table>

        <p className="mt-4 border-t border-slate-200 pt-3 text-xs leading-relaxed text-slate-600">
          Hệ thống ghi nhận người dùng đã xác minh thông tin và xác nhận đồng ý với nội dung tài liệu tại thời điểm nêu trên.
        </p>

        <div className="mt-4 flex items-end justify-between gap-4 border-t border-slate-200 pt-3">
          <div className="text-[10px] leading-snug text-slate-500">
            <p>Đây là bản tóm tắt bằng chứng xác nhận điện tử, không phải bản PDF gốc đã ký.</p>
            <p className="mt-0.5 break-all">{verifyUrl}</p>
          </div>
          {qrDataUrl && (
            // eslint-disable-next-line @next/next/no-img-element -- data: URL
            <img src={qrDataUrl} alt="Mã QR xác thực" width={90} height={90} />
          )}
        </div>
      </div>
    </div>
  );
}

function ReceiptRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <tr className="border-b border-slate-100 last:border-0">
      <td className="py-1.5 pr-3 align-top font-semibold text-slate-500">{label}</td>
      <td className={`py-1.5 text-slate-900 ${mono ? "font-mono" : ""}`}>{value}</td>
    </tr>
  );
}
