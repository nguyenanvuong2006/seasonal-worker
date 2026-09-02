"use client";

/**
 * Public candidate flow — "Xác nhận điện tử" (electronic consent). Separate
 * from the legacy /lookup page (single mutable signature field); this reads
 * candidate_documents/document_confirmations through the new access-session
 * cookie flow (see src/lib/candidate-consent/*). Mobile-first, Vietnamese.
 *
 * STEP 1 tra cứu (CCCD + SĐT) -> STEP 2 danh sách hồ sơ -> STEP 3 xem PDF +
 * tích đồng ý -> STEP 4 biên nhận xác nhận thành công.
 */

import { useEffect, useState } from "react";
import { Badge, Button, Card, CardContent, Input, Label, toast } from "@/components/ui";
import { BrandLogo } from "@/components/brand-logo";
import { CCCD_ERROR_MESSAGE, isValidCccd } from "@/lib/validators";
import { CheckCircle2, FileText, Search, ShieldCheck } from "lucide-react";

type DocumentRow = {
  id: string;
  templateName: string | null;
  templateVersion: number | null;
  regDate: string | null;
  issuedAt: string | null;
  status: string;
  receipt: { receiptId: string; confirmedAtServer: string } | null;
};

const STATUS_LABEL: Record<string, string> = {
  ISSUED: "CẦN XÁC NHẬN",
  VIEWED: "CẦN XÁC NHẬN",
  CONFIRMED: "ĐÃ XÁC NHẬN",
};

export default function CandidateConsentPage() {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [cccd, setCccd] = useState("");
  const [phone, setPhone] = useState("");
  const [loading, setLoading] = useState(false);
  const [fullName, setFullName] = useState("");
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [activeDoc, setActiveDoc] = useState<DocumentRow | null>(null);
  const [agree, setAgree] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [receipt, setReceipt] = useState<{ receiptId: string; confirmedAtServer: string; documentVersion: number | null } | null>(null);
  const [viewed, setViewed] = useState(false);

  const loadDocuments = async () => {
    const res = await fetch("/api/candidate-consent/documents", { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    setDocuments(data.documents ?? []);
  };

  const search = async () => {
    if (!isValidCccd(cccd)) {
      toast({ title: CCCD_ERROR_MESSAGE, variant: "destructive" });
      return;
    }
    if (!/^0\d{8,10}$/.test(phone)) {
      toast({ title: "Vui lòng nhập đúng số điện thoại đã đăng ký", variant: "destructive" });
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/candidate-consent/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cccd, phone }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast({ title: data.error || "Không tra cứu được.", variant: "destructive" });
        return;
      }
      setFullName(data.fullName || "");
      await loadDocuments();
      setStep(2);
    } finally {
      setLoading(false);
    }
  };

  const openDocument = (doc: DocumentRow) => {
    setActiveDoc(doc);
    setAgree(false);
    setViewed(false);
    setReceipt(doc.receipt ? { ...doc.receipt, documentVersion: doc.templateVersion } : null);
    setStep(doc.status === "CONFIRMED" ? 4 : 3);
  };

  useEffect(() => {
    if (step === 3 && activeDoc) setViewed(true);
  }, [step, activeDoc]);

  const confirm = async () => {
    if (!activeDoc || !agree) return;
    setConfirming(true);
    try {
      const res = await fetch(`/api/candidate-consent/documents/${activeDoc.id}/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agree: true }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast({ title: data.error || "Không xác nhận được.", variant: "destructive" });
        return;
      }
      setReceipt({ receiptId: data.receiptId, confirmedAtServer: data.confirmedAtServer, documentVersion: data.documentVersion ?? null });
      setStep(4);
    } finally {
      setConfirming(false);
    }
  };

  return (
    <div className="mx-auto min-h-screen max-w-md bg-slate-50 px-4 py-6">
      <div className="mb-4 flex items-center justify-center">
        <BrandLogo />
      </div>

      {step === 1 && (
        <Card>
          <CardContent className="space-y-4 p-4">
            <h1 className="text-center text-base font-bold text-slate-900">TRA CỨU HỒ SƠ</h1>
            <div>
              <Label>CCCD</Label>
              <Input value={cccd} onChange={(e) => setCccd(e.target.value.replace(/\D/g, ""))} inputMode="numeric" maxLength={12} placeholder="Nhập số CCCD" />
            </div>
            <div>
              <Label>Số điện thoại</Label>
              <Input value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))} inputMode="numeric" placeholder="Nhập số điện thoại đã đăng ký" />
            </div>
            <Button className="w-full" onClick={() => void search()} disabled={loading}>
              <Search className="mr-1.5 h-4 w-4" /> {loading ? "Đang tra cứu..." : "Tiếp tục"}
            </Button>
          </CardContent>
        </Card>
      )}

      {step === 2 && (
        <div className="space-y-3">
          <p className="text-center text-sm font-semibold text-slate-700">Xin chào, {fullName || "bạn"}</p>
          <h2 className="text-sm font-bold text-slate-900">HỒ SƠ CỦA BẠN</h2>
          {documents.length === 0 && <p className="rounded-lg bg-white p-4 text-center text-xs text-slate-500">Chưa có hồ sơ nào cần xác nhận.</p>}
          {documents.map((doc) => (
            <Card key={doc.id} className="cursor-pointer" onClick={() => openDocument(doc)}>
              <CardContent className="flex items-center justify-between p-3">
                <div>
                  <p className="text-xs font-bold text-slate-900">{doc.templateName ?? "Hồ sơ tập nghề"}</p>
                  <p className="text-[11px] text-slate-500">Ngày phát hành: {doc.issuedAt ? new Date(doc.issuedAt).toLocaleDateString("vi-VN") : "—"}</p>
                </div>
                <Badge tone={doc.status === "CONFIRMED" ? "green" : "amber"}>{STATUS_LABEL[doc.status] ?? doc.status}</Badge>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {step === 3 && activeDoc && (
        <div className="space-y-3">
          <button onClick={() => setStep(2)} className="text-xs text-slate-500">← Quay lại</button>
          <h2 className="text-sm font-bold text-slate-900">{activeDoc.templateName ?? "Hồ sơ tập nghề"}</h2>
          <iframe
            title="Tài liệu"
            src={`/api/candidate-consent/documents/${activeDoc.id}/pdf`}
            className="h-[60vh] w-full rounded-lg border border-slate-200 bg-white"
          />
          <Card>
            <CardContent className="p-3">
              <label className="flex items-start gap-2 text-xs">
                <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} disabled={!viewed} className="mt-0.5" />
                <span>Tôi xác nhận đã đọc và đồng ý với toàn bộ nội dung của tài liệu này.</span>
              </label>
              <Button className="mt-3 w-full" onClick={() => void confirm()} disabled={!agree || confirming}>
                <ShieldCheck className="mr-1.5 h-4 w-4" /> {confirming ? "Đang gửi..." : "Xác nhận đồng ý"}
              </Button>
            </CardContent>
          </Card>
        </div>
      )}

      {step === 4 && (
        <Card>
          <CardContent className="space-y-3 p-4 text-center">
            <CheckCircle2 className="mx-auto h-10 w-10 text-emerald-600" />
            <h2 className="text-sm font-bold text-slate-900">XÁC NHẬN THÀNH CÔNG</h2>
            <p className="text-xs text-slate-600">Hồ sơ của bạn đã được ghi nhận.</p>
            {receipt && (
              <div className="rounded-lg bg-slate-100 p-3 text-left text-[11px] text-slate-700">
                <p>Thời gian xác nhận: {new Date(receipt.confirmedAtServer).toLocaleString("vi-VN")}</p>
                <p className="font-mono">Mã xác nhận: {receipt.receiptId}</p>
                {receipt.documentVersion !== null && <p>Phiên bản tài liệu: v{receipt.documentVersion}</p>}
                <p>Trạng thái: ĐÃ XÁC NHẬN</p>
              </div>
            )}
            <Button variant="outline" className="w-full" onClick={() => setStep(2)}>
              <FileText className="mr-1.5 h-4 w-4" /> Xem hồ sơ khác
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
