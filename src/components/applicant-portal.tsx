"use client";

import { useState } from "react";
import { Button, Card, CardContent, Input, Label, SearchableSelect, toast } from "@/components/ui";
import { AlertTriangle, CheckCircle2, Loader2, ShieldCheck, Sparkles, UserPlus } from "lucide-react";
import { CccdQrScanner, type CccdQrData } from "@/components/cccd-qr-scanner";
import type { FormQuestion } from "@/db/schema";

type Stage = "check" | "returning_autofilled" | "already_registered" | "new" | "success";

type WorkerInfo = {
  full_name?: string;
  phone?: string | null;
  dob?: string | null;
  address_current?: string | null;
  status?: string;
  dept_name?: string | null;
  dept_location?: string | null;
};

export default function ApplicantPortal({ questions }: { questions: FormQuestion[] }) {
  const [cccd, setCccd] = useState("");
  const [phone, setPhone] = useState("");
  const [loading, setLoading] = useState(false);
  const [stage, setStage] = useState<Stage>("check");
  const [workerInfo, setWorkerInfo] = useState<WorkerInfo | null>(null);
  const [customAnswers, setCustomAnswers] = useState<Record<string, string>>({});
  const [fullName, setFullName] = useState("");
  const [dob, setDob] = useState("");
  const [address, setAddress] = useState("");

  const reset = () => {
    setStage("check");
    setWorkerInfo(null);
    setCustomAnswers({});
    setFullName("");
    setDob("");
    setAddress("");
  };

  // QUÉT QR CCCD (#11) — tự điền form, không lưu ảnh ở đâu cả.
  const handleQrScanned = (data: CccdQrData) => {
    setCccd(data.cccd);
    if (stage === "new") {
      if (data.fullName) setFullName(data.fullName);
      if (data.dob) setDob(data.dob);
      if (data.address) setAddress(data.address);
      const genderQ = questions.find((q) => q.fieldKey === "gioi_tinh");
      if (genderQ && data.gender) {
        const normalized = data.gender.toLowerCase().includes("nữ") ? "Nữ" : "Nam";
        setCustomAnswers((prev) => ({ ...prev, [genderQ.fieldKey]: normalized }));
      }
    }
  };

  const handleCheck = async () => {
    if (!/^\d{9,12}$/.test(cccd)) {
      toast({ title: "CCCD phải chứa 9 - 12 chữ số hợp lệ", variant: "destructive" });
      return;
    }
    if (!/^\d{9,11}$/.test(phone)) {
      toast({ title: "Vui lòng nhập số điện thoại hợp lệ", variant: "destructive" });
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/registrations/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cccd, phone }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast({ title: data.error ?? "Có lỗi xảy ra", variant: "destructive" });
        return;
      }
      if (data.status === "ALREADY_REGISTERED_TODAY") {
        setWorkerInfo(data.reg);
        setStage("already_registered");
      } else if (data.status === "RETURNING_VERIFIED") {
        setWorkerInfo(data.worker);
        setStage("returning_autofilled");
      } else {
        if (data.worker) {
          setFullName(data.worker.full_name ?? "");
          setDob(data.worker.dob ?? "");
          setAddress(data.worker.address_current ?? "");
        }
        setStage("new");
      }
    } catch {
      toast({ title: "Không kết nối được máy chủ", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmReturning = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/registrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cccd,
          phone,
          full_name: workerInfo?.full_name,
          is_returning: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast({ title: data.error ?? "Lỗi gửi hồ sơ", variant: "destructive" });
        return;
      }
      setStage("success");
    } finally {
      setLoading(false);
    }
  };

  const handleNewSubmit = async () => {
    if (!fullName.trim() || !dob) {
      toast({ title: "Vui lòng nhập Họ Tên và Ngày Sinh", variant: "destructive" });
      return;
    }
    for (const q of questions) {
      if (q.isRequired && !customAnswers[q.fieldKey]) {
        toast({
          title: `Thiếu: ${q.questionText}`,
          variant: "destructive",
        });
        return;
      }
    }
    setLoading(true);
    try {
      const res = await fetch("/api/registrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cccd,
          phone,
          full_name: fullName,
          dob,
          address_current: address,
          custom_answers: customAnswers,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast({ title: data.error ?? "Lỗi gửi hồ sơ", variant: "destructive" });
        return;
      }
      setStage("success");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {stage === "check" && (
        <Card className="hasfarm-card animate-slide-up border-0 shadow-[0_12px_40px_rgba(8,50,27,0.12)]">
          <CardContent className="space-y-5 p-6 md:p-7">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gold-100 text-gold-700">
                <Sparkles className="h-4 w-4" />
              </div>
              <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-hasfarm-700">
                Bước 1/2 — Xác thực danh tính
              </p>
            </div>

            <div className="space-y-4">
              <div>
                <Label>Số CCCD / CMND *</Label>
                <div className="flex gap-2">
                  <Input
                    type="tel"
                    inputMode="numeric"
                    maxLength={12}
                    placeholder="Nhập 9 hoặc 12 số"
                    value={cccd}
                    onChange={(e) => setCccd(e.target.value.replace(/\D/g, ""))}
                    className="h-[56px] flex-1 rounded-[14px] border-2 bg-white text-[18px] font-bold tracking-widest shadow-inner"
                  />
                  <CccdQrScanner onResult={handleQrScanned} />
                </div>
                <p className="mt-1 text-[11px] text-gray-400">
                  Nhập chính xác — nếu sai sẽ cần HR sửa lại sau (tính năng sửa lỗi CCCD). Hoặc bấm “Quét QR CCCD” để tự điền.
                </p>
              </div>
              <div>
                <Label>Số điện thoại *</Label>
                <Input
                  type="tel"
                  inputMode="numeric"
                  maxLength={11}
                  placeholder="090..."
                  value={phone}
                  onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))}
                  className="h-[56px] rounded-[14px] text-[18px] font-semibold"
                />
              </div>
            </div>

            <Button onClick={handleCheck} disabled={loading} variant="gold" size="xl" className="w-full rounded-[14px]">
              {loading ? <Loader2 className="h-6 w-6 animate-spin" /> : "Tiếp Tục → Kiểm tra hồ sơ"}
            </Button>

            <div className="flex items-center gap-2 rounded-xl bg-hasfarm-50 p-3 text-[11px] font-medium text-hasfarm-800">
              <span className="text-base">🌱</span> Hệ thống tự nhận diện bạn là lao động cũ / mới của Dalat Hasfarm
              — lần đầu chỉ cần điền 1 lần, hôm sau auto-fill.
            </div>
          </CardContent>
        </Card>
      )}

      {stage === "already_registered" && (
        <Card className="animate-slide-up rounded-[20px] border-2 border-amber-300 bg-gradient-to-b from-amber-50 to-white shadow-xl">
          <CardContent className="space-y-4 p-7 text-center">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-amber-100">
              <AlertTriangle className="h-8 w-8 text-amber-600" />
            </div>
            <h2 className="text-[22px] font-black leading-tight text-hasfarm-900">ĐÃ XÁC NHẬN LÀM VIỆC HÔM NAY</h2>
            <div className="rounded-2xl border bg-white p-4 shadow-sm">
              <p className="text-sm text-gray-600">
                Hồ sơ <b className="text-hasfarm-900">{workerInfo?.full_name || cccd}</b> đang ở:
              </p>
              <p className="mt-2 inline-flex rounded-full bg-hasfarm-700 px-4 py-1.5 text-sm font-black uppercase text-white">
                {workerInfo?.status === "APPROVED"
                  ? `✅ Đã Nhận — ${workerInfo?.dept_name ?? "Chờ phân xưởng"}`
                  : workerInfo?.status === "REJECTED"
                    ? "Không nhận hôm nay"
                    : "⏳ Đang chờ HR xếp bộ phận"}
              </p>
              {workerInfo?.dept_location && (
                <p className="mt-2 text-xs text-gray-500">📍 {workerInfo.dept_location}</p>
              )}
            </div>
            <p className="text-xs text-gray-400">Bạn không cần gửi lại hồ sơ trong ngày. Vui lòng xem chi tiết ở trang Tra cứu.</p>
            <Button onClick={reset} variant="outline" className="w-full rounded-[14px]">
              Kiểm tra CCCD khác
            </Button>
          </CardContent>
        </Card>
      )}

      {stage === "returning_autofilled" && (
        <Card className="animate-slide-up rounded-[20px] border-2 border-emerald-400 bg-gradient-to-b from-emerald-50 to-white shadow-xl">
          <CardContent className="space-y-5 p-6">
            <div className="flex gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-600 text-white shadow">
                <ShieldCheck className="h-7 w-7" />
              </div>
              <div>
                <p className="text-[11px] font-bold uppercase tracking-widest text-emerald-700">Lao động đã xác minh</p>
                <p className="text-[22px] font-black leading-tight text-hasfarm-900">{workerInfo?.full_name}</p>
                <p className="text-xs text-gray-500">Hệ thống Dalat Hasfarm đã lưu hồ sơ của bạn</p>
              </div>
            </div>

            <div className="rounded-2xl border bg-white p-4">
              <p className="text-[10px] font-bold uppercase text-gray-400">Địa chỉ lưu trữ</p>
              <p className="mt-1 text-sm font-semibold text-gray-800">{workerInfo?.address_current || "Chưa cập nhật"}</p>
            </div>

            <Button onClick={handleConfirmReturning} disabled={loading} variant="gold" size="xl" className="w-full rounded-[14px] shadow-[0_8px_20px_rgba(217,163,39,0.35)]">
              {loading ? <Loader2 className="h-6 w-6 animate-spin" /> : "✓ Xác nhận đăng ký làm việc ngay"}
            </Button>
            <Button onClick={reset} variant="ghost" className="w-full">
              ← Hủy bỏ
            </Button>
          </CardContent>
        </Card>
      )}

      {stage === "new" && (
        <Card className="hasfarm-card animate-slide-up rounded-[20px] border-gold-300 shadow-[0_16px_48px_rgba(8,50,27,0.14)]">
          <CardContent className="space-y-5 p-6">
            <div className="flex items-start gap-3 rounded-2xl bg-gold-50 p-4 ring-1 ring-gold-200">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gold-500 text-white">
                <UserPlus className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm font-black text-hasfarm-900">Chào bạn mới! Điền thông tin lần đầu</p>
                <p className="mt-1 text-xs leading-relaxed text-gray-600">
                  Hồ sơ sẽ được lưu vào kho chung. Sau khi HR nhấn <b>“Xác nhận là người mới”</b>, bạn sẽ trở thành lao động chính thức
                  — lần sau hệ thống sẽ auto-fill cho bạn.
                </p>
              </div>
            </div>

            <div className="flex justify-end">
              <CccdQrScanner onResult={handleQrScanned} />
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <Label>Họ và Tên *</Label>
                <Input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Nguyễn Văn A" className="h-[48px] rounded-[12px]" />
              </div>
              <div>
                <Label>Ngày sinh *</Label>
                <Input type="date" value={dob} onChange={(e) => setDob(e.target.value)} className="h-[48px] rounded-[12px]" />
              </div>
            </div>

            <div>
              <Label>Địa chỉ hiện tại</Label>
              <Input
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="Số nhà, đường/phường, TP. Đà Lạt..."
                className="h-[48px] rounded-[12px]"
              />
            </div>

            {questions.length > 0 && (
              <div className="space-y-4 border-t border-dashed pt-5">
                <p className="flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.18em] text-hasfarm-700">
                  <span className="h-2 w-2 rounded-full bg-gold-500" /> Câu hỏi khảo sát (thêm bởi Quản trị viên)
                </p>
                {questions.map((q) => (
                  <div key={q.id} className="space-y-2 rounded-2xl bg-gray-50 p-4 ring-1 ring-gray-100">
                    <Label className="text-[13px]">
                      {q.questionText} {q.isRequired && <span className="text-red-500">*</span>}
                    </Label>
                    {q.fieldType === "SELECT" && (q.options?.length ?? 0) > 0 ? (
                      <SearchableSelect
                        value={customAnswers[q.fieldKey]}
                        onChange={(val) => setCustomAnswers({ ...customAnswers, [q.fieldKey]: val })}
                        options={(q.options ?? []).map((o) => ({ value: o, label: o }))}
                      />
                    ) : q.fieldType === "BOOLEAN" ? (
                      <div className="grid grid-cols-2 gap-2">
                        <Button
                          type="button"
                          size="lg"
                          variant={customAnswers[q.fieldKey] === "Có" ? "success" : "outline"}
                          onClick={() => setCustomAnswers({ ...customAnswers, [q.fieldKey]: "Có" })}
                          className="rounded-[12px]"
                        >
                          ✓ Có
                        </Button>
                        <Button
                          type="button"
                          size="lg"
                          variant={customAnswers[q.fieldKey] === "Không" ? "destructive" : "outline"}
                          onClick={() => setCustomAnswers({ ...customAnswers, [q.fieldKey]: "Không" })}
                          className="rounded-[12px]"
                        >
                          ✗ Không
                        </Button>
                      </div>
                    ) : (
                      <Input
                        value={customAnswers[q.fieldKey] || ""}
                        onChange={(e) => setCustomAnswers({ ...customAnswers, [q.fieldKey]: e.target.value })}
                        className="h-[48px] rounded-[12px] bg-white"
                        placeholder="Nhập câu trả lời..."
                      />
                    )}
                  </div>
                ))}
              </div>
            )}

            <Button onClick={handleNewSubmit} disabled={loading} variant="gold" size="xl" className="w-full rounded-[14px] shadow-[0_10px_24px_rgba(217,163,39,0.35)]">
              {loading ? <Loader2 className="h-6 w-6 animate-spin" /> : "🚀 Đăng ký hoàn tất"}
            </Button>
            <Button onClick={reset} variant="ghost" className="w-full">
              ← Quay lại
            </Button>
          </CardContent>
        </Card>
      )}

      {stage === "success" && (
        <Card className="animate-slide-up rounded-[20px] border-2 border-hasfarm-600 bg-gradient-to-b from-hasfarm-50 to-white text-center shadow-xl">
          <CardContent className="space-y-5 p-8">
            <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-hasfarm-600 text-white shadow-lg">
              <CheckCircle2 className="h-10 w-10" />
            </div>
            <div>
              <h1 className="text-[26px] font-black tracking-tight text-hasfarm-900">ĐĂNG KÝ THÀNH CÔNG</h1>
              <p className="mx-auto mt-2 max-w-[34ch] text-sm leading-relaxed text-gray-600">
                Yêu cầu của bạn đã ghi nhận. HR sẽ xếp bộ phận trong sáng nay. Nếu là người mới, sau khi HR nhấn{" "}
                <b className="text-hasfarm-700">Xác nhận là người mới</b> bạn sẽ vào kho lao động chính thức.
              </p>
            </div>
            <div className="rounded-2xl border border-dashed bg-white p-4 text-xs font-semibold text-gray-600 shadow-sm">
              Theo dõi kết quả tại{" "}
              <a href="/lookup" className="font-black text-gold-600 underline underline-offset-4">
                Tra Cứu Trạng Thái
              </a>{" "}
              sau 14h chiều.
            </div>
            <Button onClick={reset} variant="outline" className="w-full rounded-[14px]">
              Đăng ký cho người khác
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
