"use client";

/**
 * PUBLIC, unauthenticated, read-only third-party verification page.
 * "HỒ SƠ XÁC NHẬN ĐIỆN TỬ" — fetches the safe DTO from
 * GET /api/xac-thuc-ho-so/[token] and renders it. NOT PKI, NOT a
 * certificate-based digital signature — see verification-service.ts's own
 * docblock. Never displays CCCD/phone/IP/User-Agent/HMAC/storage_key/any
 * internal database id — only what the DTO itself carries.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import QRCode from "qrcode";
import { Badge, Card, CardContent } from "@/components/ui";
import { BrandLogo } from "@/components/brand-logo";
import { formatConfirmedAt, abbreviateHash, statusPresentation, type StatusTone } from "@/lib/candidate-consent/verification-display";
import { computeFileSha256Hex, comparePdfHash, type PdfHashCheckResult } from "@/lib/candidate-consent/pdf-hash-check";
import { CheckCircle2, Copy, FileText, ShieldAlert, ShieldCheck, ShieldX, Upload } from "lucide-react";

type VerificationDto = {
  status: "VALID" | "REVOKED" | "SUPERSEDED" | "INVALID" | "NOT_FOUND";
  receiptId: string;
  candidateDisplayName: string | null;
  documentName: string | null;
  documentVersion: number | null;
  confirmedAtServer: string;
  verificationMethodLabel: string;
  pdfSha256: string;
  documentIntegrityState: "OK" | "MISMATCH";
  evidenceIntegrityState: "VALID" | "INVALID";
  technicalAccessEvidencePresent: boolean;
  revokedAt: string | null;
};

const TONE_TO_BADGE: Record<StatusTone, "green" | "amber" | "red" | "gray"> = {
  green: "green",
  amber: "amber",
  red: "red",
  gray: "gray",
};

const TONE_ICON: Record<StatusTone, typeof ShieldCheck> = {
  green: ShieldCheck,
  amber: ShieldAlert,
  red: ShieldX,
  gray: ShieldAlert,
};

export default function VerificationPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token ?? "";

  const [loading, setLoading] = useState(true);
  const [dto, setDto] = useState<VerificationDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [hashChecking, setHashChecking] = useState(false);
  const [hashResult, setHashResult] = useState<PdfHashCheckResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/xac-thuc-ho-so/${encodeURIComponent(token)}`, { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.status === 429) {
          setError(data.error || "Bạn đã kiểm tra quá nhiều lần. Vui lòng thử lại sau.");
          return;
        }
        if (!res.ok && data.status !== "NOT_FOUND") {
          setError(data.error || "Không kiểm tra được. Vui lòng thử lại sau.");
          return;
        }
        setDto(data as VerificationDto);
      } catch {
        if (!cancelled) setError("Không thể kết nối đến máy chủ. Vui lòng thử lại sau.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (!token || typeof window === "undefined") return;
    const url = `${window.location.origin}/xac-thuc-ho-so/${encodeURIComponent(token)}`;
    QRCode.toDataURL(url, { margin: 1, width: 200 })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(null));
  }, [token]);

  const copyHash = useCallback(() => {
    if (!dto) return;
    void navigator.clipboard
      ?.writeText(dto.pdfSha256)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  }, [dto]);

  const checkFile = useCallback(
    async (file: File) => {
      if (!dto) return;
      setHashChecking(true);
      setHashResult(null);
      try {
        const computedHex = await computeFileSha256Hex(file);
        setHashResult(comparePdfHash(computedHex, dto.pdfSha256));
      } finally {
        setHashChecking(false);
      }
    },
    [dto],
  );

  return (
    <div className="mx-auto min-h-screen max-w-md bg-slate-50 px-4 py-6">
      <div className="mb-4 flex items-center justify-center">
        <BrandLogo />
      </div>
      <h1 className="mb-3 text-center text-sm font-bold uppercase tracking-wide text-slate-700">Hồ sơ xác nhận điện tử</h1>

      {loading && <p className="py-8 text-center text-xs text-slate-500">Đang kiểm tra...</p>}

      {!loading && error && (
        <Card>
          <CardContent className="space-y-2 p-4 text-center">
            <ShieldAlert className="mx-auto h-8 w-8 text-amber-600" />
            <p className="text-xs text-slate-600">{error}</p>
          </CardContent>
        </Card>
      )}

      {!loading && !error && dto && <VerificationResult dto={dto} token={token} qrDataUrl={qrDataUrl} copied={copied} onCopyHash={copyHash} />}

      {!loading && !error && dto && (
        <Card className="mt-3">
          <CardContent className="space-y-3 p-4">
            <h2 className="flex items-center gap-1.5 text-xs font-bold text-slate-800">
              <Upload className="h-3.5 w-3.5" /> Kiểm tra file PDF
            </h2>
            <p className="text-[11px] text-slate-500">
              Chọn file PDF bạn có để so sánh với tài liệu đã được xác nhận. File KHÔNG được tải lên máy chủ — mã băm SHA-256
              được tính ngay trên trình duyệt của bạn.
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf"
              className="block w-full text-[11px] text-slate-600 file:mr-2 file:rounded-lg file:border file:border-slate-200 file:bg-white file:px-2 file:py-1 file:text-[11px] file:font-semibold"
              onChange={(e) => {
                const file = e.target.files?.[0];
                setHashResult(null);
                if (file) void checkFile(file);
              }}
            />
            {hashChecking && <p className="text-[11px] text-slate-500">Đang tính mã băm...</p>}
            {hashResult === "MATCH" && (
              <p className="flex items-center gap-1 text-[11px] font-semibold text-emerald-700">
                <CheckCircle2 className="h-3.5 w-3.5" /> File PDF trùng khớp với tài liệu đã được xác nhận.
              </p>
            )}
            {hashResult === "MISMATCH" && (
              <p className="flex items-center gap-1 text-[11px] font-semibold text-red-700">
                <ShieldX className="h-3.5 w-3.5" /> File PDF không trùng khớp với tài liệu đã được xác nhận.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {!loading && !error && dto && dto.status !== "NOT_FOUND" && (
        <div className="mt-3 text-center">
          <a href={`/xac-thuc-ho-so/${encodeURIComponent(token)}/bien-nhan`} className="text-[11px] font-semibold text-indigo-700 underline">
            Xem biên nhận xác nhận điện tử
          </a>
        </div>
      )}
    </div>
  );
}

function VerificationResult({
  dto,
  token,
  qrDataUrl,
  copied,
  onCopyHash,
}: {
  dto: VerificationDto;
  token: string;
  qrDataUrl: string | null;
  copied: boolean;
  onCopyHash: () => void;
}) {
  const presentation = statusPresentation(dto.status);
  const Icon = TONE_ICON[presentation.tone];

  if (dto.status === "NOT_FOUND") {
    return (
      <Card>
        <CardContent className="space-y-2 p-4 text-center">
          <ShieldAlert className="mx-auto h-8 w-8 text-slate-400" />
          <p className="text-sm font-bold text-slate-700">{presentation.label}</p>
          <p className="text-xs text-slate-500">{presentation.description}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center justify-between">
          <Badge tone={TONE_TO_BADGE[presentation.tone]}>{presentation.label}</Badge>
          <Icon className={`h-5 w-5 ${presentation.tone === "green" ? "text-emerald-600" : presentation.tone === "red" ? "text-red-600" : presentation.tone === "amber" ? "text-amber-600" : "text-slate-500"}`} />
        </div>
        <p className="text-xs text-slate-600">{presentation.description}</p>

        <dl className="space-y-1.5 rounded-lg bg-slate-50 p-3 text-[11px]">
          <Row label="Mã xác nhận" value={dto.receiptId} mono />
          {dto.candidateDisplayName && <Row label="Ứng viên" value={dto.candidateDisplayName} />}
          {dto.documentName && <Row label="Tài liệu" value={dto.documentName} />}
          {dto.documentVersion !== null && <Row label="Phiên bản" value={`v${dto.documentVersion}`} />}
          <Row label="Thời gian xác nhận" value={formatConfirmedAt(dto.confirmedAtServer)} />
          <Row label="Phương thức xác thực" value={dto.verificationMethodLabel} />
          <Row label="Bằng chứng truy cập kỹ thuật" value={dto.technicalAccessEvidencePresent ? "PRESENT" : "—"} />
          <div className="flex items-start justify-between gap-2 pt-1">
            <span className="shrink-0 font-semibold text-slate-500">Mã băm PDF (SHA-256)</span>
            <span className="flex items-center gap-1 text-right font-mono text-slate-700">
              {abbreviateHash(dto.pdfSha256)}
              <button type="button" onClick={onCopyHash} title="Sao chép mã băm đầy đủ" className="text-slate-400 hover:text-slate-600">
                <Copy className="h-3 w-3" />
              </button>
            </span>
          </div>
          {copied && <p className="text-right text-[10px] text-emerald-600">Đã sao chép.</p>}
          <Row label="Tính toàn vẹn tài liệu" value={dto.documentIntegrityState === "OK" ? "OK" : "KHÔNG KHỚP"} />
          <Row label="Tính toàn vẹn bằng chứng" value={dto.evidenceIntegrityState === "VALID" ? "Hợp lệ" : "Không hợp lệ"} />
          {dto.revokedAt && <Row label="Thời gian thu hồi/thay thế" value={formatConfirmedAt(dto.revokedAt)} />}
        </dl>

        {qrDataUrl && (
          <div className="flex flex-col items-center gap-1 pt-1">
            {/* eslint-disable-next-line @next/next/no-img-element -- data: URL, no next/image loader needed */}
            <img src={qrDataUrl} alt="Mã QR xác thực" width={140} height={140} />
            <p className="flex items-center gap-1 text-[10px] text-slate-400">
              <FileText className="h-3 w-3" /> Quét để mở lại trang xác thực này
            </p>
          </div>
        )}
        <p className="text-center text-[10px] text-slate-400">Mã: {token}</p>
      </CardContent>
    </Card>
  );
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="shrink-0 font-semibold text-slate-500">{label}</span>
      <span className={`text-right text-slate-700 ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  );
}
