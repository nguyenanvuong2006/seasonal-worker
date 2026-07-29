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
        <Card className="overflow-hidden rounded-[32px] border-0 bg-white shadow-[0_25px_80px_rgba(15,23,42,.10)] ring-1 ring-slate-200/70">
      
          {/* Header */}
      
          <div className="bg-gradient-to-r from-hasfarm-700 via-hasfarm-600 to-hasfarm-700 px-8 py-7 text-white">
      
            <div className="flex items-start gap-4">
      
              <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-white/15 backdrop-blur">
      
                <ShieldCheck className="h-7 w-7" />
      
              </div>
      
              <div>
      
                <p className="text-xs font-bold uppercase tracking-[0.25em] text-gold-200">
                  BƯỚC 1 / 2
                </p>
      
                <h2 className="mt-2 text-3xl font-black">
                  Xác thực thông tin ứng viên
                </h2>
      
                <p className="mt-3 max-w-xl text-sm leading-7 text-white/80">
                  Nhập số CCCD và số điện thoại để hệ thống kiểm tra
                  bạn là lao động mới hay lao động đã có hồ sơ tại
                  Dalat Hasfarm.
                </p>
      
              </div>
      
            </div>
      
          </div>
      
          <CardContent className="space-y-8 p-8">
      
            {/* CCCD */}
      
            <div className="space-y-3">
      
              <Label className="text-sm font-bold text-slate-700">
                Số CCCD / CMND
                <span className="ml-1 text-red-500">*</span>
              </Label>
      
              <div className="flex gap-3">
      
                <Input
                  type="tel"
                  inputMode="numeric"
                  maxLength={12}
                  value={cccd}
                  placeholder="Nhập 9 hoặc 12 chữ số"
      
                  onChange={(e) =>
                    setCccd(
                      e.target.value.replace(/\D/g, "")
                    )
                  }
      
                  className="h-14 flex-1 rounded-2xl border-slate-300 bg-slate-50 px-5 text-lg font-semibold tracking-[0.18em] shadow-none focus:bg-white"
                />
      
                <div className="shrink-0">
                  <CccdQrScanner
                    onResult={handleQrScanned}
                  />
                </div>
      
              </div>
      
              <div className="rounded-2xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm leading-6 text-slate-600">
      
                <span className="font-semibold text-slate-800">
                  Mẹo:
                </span>
      
                {" "}
                Bạn có thể bấm
                {" "}
                <b>Quét QR CCCD</b>
                {" "}
                để tự động điền thông tin, hạn chế sai sót khi nhập.
      
              </div>
      
            </div>
      
            {/* PHONE */}
      
            <div className="space-y-3">
      
              <Label className="text-sm font-bold text-slate-700">
                Số điện thoại
                <span className="ml-1 text-red-500">*</span>
              </Label>
      
              <Input
      
                type="tel"
      
                inputMode="numeric"
      
                maxLength={11}
      
                value={phone}
      
                placeholder="Ví dụ: 0901234567"
      
                onChange={(e) =>
                  setPhone(
                    e.target.value.replace(/\D/g, "")
                  )
                }
      
                className="h-14 rounded-2xl border-slate-300 bg-slate-50 px-5 text-lg font-semibold shadow-none focus:bg-white"
      
              />
      
            </div>
      
            {/* NOTE */}
      
            <div className="rounded-3xl border border-emerald-200 bg-emerald-50 p-5">
      
              <div className="flex gap-3">
      
                <div className="text-2xl">
                  🌱
                </div>
      
                <div>
      
                  <p className="font-bold text-emerald-900">
                    Hệ thống nhận diện tự động
                  </p>
      
                  <p className="mt-2 text-sm leading-7 text-slate-600">
      
                    Nếu bạn đã từng làm việc tại
                    Dalat Hasfarm,
                    hệ thống sẽ tự động nhận diện và
                    điền lại hồ sơ.
      
                    <br />
      
                    Nếu là lần đầu đăng ký,
                    bạn chỉ cần khai báo thông tin
                    một lần.
      
                  </p>
      
                </div>
      
              </div>
      
            </div>
      
            {/* BUTTON */}
      
            <Button
      
              onClick={handleCheck}
      
              disabled={loading}
      
              variant="gold"
      
              size="xl"
      
              className="h-14 w-full rounded-2xl text-base font-black shadow-[0_15px_40px_rgba(217,163,39,.30)] transition hover:-translate-y-0.5"
      
            >
      
              {loading ? (
      
                <Loader2 className="h-6 w-6 animate-spin" />
      
              ) : (
      
                <>
                  Kiểm tra hồ sơ
                  <span className="ml-2 text-lg">
                    →
                  </span>
                </>
      
              )}
      
            </Button>
      
          </CardContent>
      
        </Card>
      )}

      {stage === "already_registered" && (
  <Card className="overflow-hidden rounded-[32px] border-0 bg-white shadow-[0_25px_80px_rgba(15,23,42,.10)] ring-1 ring-amber-200">

    <div className="bg-gradient-to-r from-amber-500 to-amber-600 px-8 py-7 text-white">

      <div className="flex items-center gap-4">

        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white/20 backdrop-blur">
          <AlertTriangle className="h-7 w-7" />
        </div>

        <div>

          <p className="text-xs font-bold uppercase tracking-[0.25em] text-amber-100">
            ĐÃ TỒN TẠI HỒ SƠ
          </p>

          <h2 className="mt-2 text-3xl font-black">
            Bạn đã đăng ký hôm nay
          </h2>

        </div>

      </div>

    </div>

    <CardContent className="space-y-6 p-8">

      <div className="rounded-3xl border border-slate-200 bg-slate-50 p-6">

        <p className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">
          Ứng viên
        </p>

        <p className="mt-2 text-2xl font-black text-slate-900">
          {workerInfo?.full_name || cccd}
        </p>

      </div>

      <div className="rounded-3xl border border-slate-200 bg-white p-6">

        <p className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">
          Trạng thái hồ sơ
        </p>

        <div className="mt-4">

          {workerInfo?.status === "APPROVED" && (
            <div className="inline-flex rounded-full bg-emerald-100 px-5 py-2 font-bold text-emerald-700">
              ✅ Đã tiếp nhận
            </div>
          )}

          {workerInfo?.status === "REJECTED" && (
            <div className="inline-flex rounded-full bg-red-100 px-5 py-2 font-bold text-red-700">
              ❌ Không tiếp nhận hôm nay
            </div>
          )}

          {workerInfo?.status !== "APPROVED" &&
            workerInfo?.status !== "REJECTED" && (
              <div className="inline-flex rounded-full bg-amber-100 px-5 py-2 font-bold text-amber-700">
                ⏳ Đang chờ sắp xếp
              </div>
            )}

        </div>

        {workerInfo?.dept_name && (
          <div className="mt-6 rounded-2xl bg-hasfarm-50 p-4">

            <p className="text-xs uppercase tracking-wider text-slate-500">
              Bộ phận
            </p>

            <p className="mt-2 font-bold text-hasfarm-800">
              {workerInfo.dept_name}
            </p>

          </div>
        )}

        {workerInfo?.dept_location && (
          <div className="mt-4 rounded-2xl bg-slate-50 p-4">

            <p className="text-xs uppercase tracking-wider text-slate-500">
              Địa điểm
            </p>

            <p className="mt-2 font-semibold text-slate-700">
              📍 {workerInfo.dept_location}
            </p>

          </div>
        )}

      </div>

      <div className="rounded-3xl border border-amber-200 bg-amber-50 p-5 text-sm leading-7 text-slate-700">
        Hồ sơ của bạn đã được ghi nhận trong ngày hôm nay.
        Không cần đăng ký lại.
        Vui lòng sử dụng chức năng
        <span className="font-bold text-hasfarm-700">
          {" "}Tra cứu kết quả
        </span>
        để theo dõi tiến trình xử lý.
      </div>

      <Button
        onClick={reset}
        variant="outline"
        className="h-14 w-full rounded-2xl"
      >
        Kiểm tra CCCD khác
      </Button>

    </CardContent>

  </Card>
)}

      {stage === "returning_autofilled" && (
  <Card className="overflow-hidden rounded-[32px] border-0 bg-white shadow-[0_25px_80px_rgba(15,23,42,.10)] ring-1 ring-emerald-200">

    <div className="bg-gradient-to-r from-emerald-600 to-emerald-700 px-8 py-7 text-white">

      <div className="flex items-center gap-4">

        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white/15">
          <ShieldCheck className="h-7 w-7" />
        </div>

        <div>

          <p className="text-xs font-bold uppercase tracking-[0.25em] text-emerald-100">
            HỒ SƠ ĐÃ XÁC MINH
          </p>

          <h2 className="mt-2 text-3xl font-black">
            Chào mừng bạn quay trở lại
          </h2>

        </div>

      </div>

    </div>

    <CardContent className="space-y-7 p-8">

      <div className="rounded-3xl border border-slate-200 bg-slate-50 p-6">

        <p className="text-xs uppercase tracking-[0.2em] text-slate-500">
          Họ và tên
        </p>

        <p className="mt-2 text-2xl font-black text-slate-900">
          {workerInfo?.full_name}
        </p>

      </div>

      <div className="rounded-3xl border border-slate-200 bg-white p-6">

        <p className="text-xs uppercase tracking-[0.2em] text-slate-500">
          Địa chỉ hiện tại
        </p>

        <p className="mt-3 leading-7 text-slate-700">
          {workerInfo?.address_current || "Chưa cập nhật"}
        </p>

      </div>

      <div className="rounded-3xl border border-emerald-200 bg-emerald-50 p-5">

        <p className="font-bold text-emerald-900">
          Hệ thống đã nhận diện bạn là lao động đã có hồ sơ.
        </p>

        <p className="mt-2 text-sm leading-7 text-slate-700">
          Bạn chỉ cần xác nhận để gửi yêu cầu làm việc hôm nay.
          Không cần khai báo lại toàn bộ thông tin cá nhân.
        </p>

      </div>

      <Button
        onClick={handleConfirmReturning}
        disabled={loading}
        variant="gold"
        size="xl"
        className="h-14 w-full rounded-2xl text-base font-black shadow-[0_15px_40px_rgba(217,163,39,.30)]"
      >
        {loading ? (
          <Loader2 className="h-6 w-6 animate-spin" />
        ) : (
          <>
            Xác nhận đăng ký làm việc
            <span className="ml-2">✓</span>
          </>
        )}
      </Button>

      <Button
        onClick={reset}
        variant="ghost"
        className="h-12 w-full rounded-2xl"
      >
        ← Quay lại
      </Button>

    </CardContent>

  </Card>
)}

      {stage === "new" && (
  <Card className="overflow-hidden rounded-[32px] border-0 bg-white shadow-[0_25px_80px_rgba(15,23,42,.10)] ring-1 ring-slate-200/70">

    {/* Header */}

    <div className="bg-gradient-to-r from-hasfarm-700 via-hasfarm-600 to-hasfarm-700 px-8 py-7 text-white">

      <div className="flex items-start gap-4">

        <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-white/15">

          <UserPlus className="h-7 w-7" />

        </div>

        <div>

          <p className="text-xs font-bold uppercase tracking-[0.25em] text-gold-200">
            HỒ SƠ MỚI
          </p>

          <h2 className="mt-2 text-3xl font-black">
            Đăng ký thông tin lần đầu
          </h2>

          <p className="mt-3 max-w-2xl text-sm leading-7 text-white/80">
            Hoàn thành đầy đủ thông tin bên dưới để bộ phận tuyển dụng
            tiếp nhận hồ sơ và bố trí vị trí phù hợp.
          </p>

        </div>

      </div>

    </div>

    <CardContent className="space-y-8 p-8">

      {/* QR */}

      <div className="flex flex-col gap-4 rounded-3xl border border-blue-100 bg-blue-50 p-5 md:flex-row md:items-center md:justify-between">

        <div>

          <p className="font-bold text-slate-900">
            Quét mã QR trên CCCD
          </p>

          <p className="mt-2 text-sm leading-6 text-slate-600">
            Hệ thống sẽ tự động điền Họ tên, Ngày sinh,
            Địa chỉ và Giới tính nếu đọc được dữ liệu.
          </p>

        </div>

        <div className="shrink-0">
          <CccdQrScanner
            onResult={handleQrScanned}
          />
        </div>

      </div>

      {/* Personal */}

      <div>

        <div className="mb-5 flex items-center gap-3">

          <div className="h-8 w-1 rounded-full bg-hasfarm-600" />

          <h3 className="text-xl font-black text-slate-900">
            Thông tin cá nhân
          </h3>

        </div>

        <div className="grid gap-6 md:grid-cols-2">

          <div className="space-y-3">

            <Label className="text-sm font-bold">
              Họ và tên
              <span className="ml-1 text-red-500">*</span>
            </Label>

            <Input
              value={fullName}
              onChange={(e) =>
                setFullName(e.target.value)
              }
              placeholder="Nguyễn Văn A"
              className="h-14 rounded-2xl bg-slate-50 px-5 text-base"
            />

          </div>

          <div className="space-y-3">

            <Label className="text-sm font-bold">
              Ngày sinh
              <span className="ml-1 text-red-500">*</span>
            </Label>

            <Input
              type="date"
              value={dob}
              onChange={(e) =>
                setDob(e.target.value)
              }
              className="h-14 rounded-2xl bg-slate-50 px-5"
            />

          </div>

        </div>

      </div>

      {/* Address */}

      <div className="space-y-3">

        <Label className="text-sm font-bold">
          Địa chỉ hiện tại
        </Label>

        <Input
          value={address}
          onChange={(e) =>
            setAddress(e.target.value)
          }
          placeholder="Ví dụ: 123 Trần Phú, Phường Xuân Hương, Đà Lạt..."
          className="h-14 rounded-2xl bg-slate-50 px-5"
        />

      </div>

      {questions.length > 0 && (
  <div className="space-y-6 border-t border-slate-200 pt-8">

    {/* Section Title */}

    <div className="flex items-center gap-3">

      <div className="h-8 w-1 rounded-full bg-gold-500" />

      <div>

        <h3 className="text-xl font-black text-slate-900">
          Thông tin bổ sung
        </h3>

        <p className="mt-1 text-sm text-slate-500">
          Vui lòng hoàn thành các câu hỏi dưới đây.
        </p>

      </div>

    </div>

    {questions.map((q) => (

      <div
        key={q.id}
        className="rounded-3xl border border-slate-200 bg-white p-6 transition-all duration-200 hover:border-hasfarm-300 hover:shadow-md"
      >

        {/* Question */}

        <Label className="mb-4 block text-base font-semibold leading-7 text-slate-800">

          {q.questionText}

          {q.isRequired && (
            <span className="ml-1 text-red-500">*</span>
          )}

        </Label>

        {/* SELECT */}

        {q.fieldType === "SELECT" &&
          (q.options?.length ?? 0) > 0 ? (

          <SearchableSelect
            value={customAnswers[q.fieldKey]}
            onChange={(value) =>
              setCustomAnswers({
                ...customAnswers,
                [q.fieldKey]: value,
              })
            }
            options={(q.options ?? []).map((item) => ({
              value: item,
              label: item,
            }))}
          />

        ) : q.fieldType === "BOOLEAN" ? (

          /* BOOLEAN */

          <div className="grid grid-cols-2 gap-4">

            <Button
              type="button"
              size="lg"
              variant={
                customAnswers[q.fieldKey] === "Có"
                  ? "success"
                  : "outline"
              }
              onClick={() =>
                setCustomAnswers({
                  ...customAnswers,
                  [q.fieldKey]: "Có",
                })
              }
              className="h-12 rounded-2xl font-bold"
            >
              ✓ Có
            </Button>

            <Button
              type="button"
              size="lg"
              variant={
                customAnswers[q.fieldKey] === "Không"
                  ? "destructive"
                  : "outline"
              }
              onClick={() =>
                setCustomAnswers({
                  ...customAnswers,
                  [q.fieldKey]: "Không",
                })
              }
              className="h-12 rounded-2xl font-bold"
            >
              ✕ Không
            </Button>

          </div>

        ) : (

          /* TEXT */

          <Input
            value={customAnswers[q.fieldKey] || ""}
            onChange={(e) =>
              setCustomAnswers({
                ...customAnswers,
                [q.fieldKey]: e.target.value,
              })
            }
            placeholder="Nhập câu trả lời..."
            className="h-14 rounded-2xl bg-slate-50 px-5"
          />

        )}

        {/* Required Hint */}

        {q.isRequired && (
          <p className="mt-3 text-xs text-slate-400">
            Trường này là bắt buộc.
          </p>
        )}

      </div>

    ))}

  </div>
)}

            {/* Confirmation */}

      <div className="rounded-3xl border border-gold-200 bg-gradient-to-r from-gold-50 to-white p-6">

        <div className="flex items-start gap-4">

          <div className="mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-gold-500 text-white">
            ✓
          </div>

          <div>

            <h4 className="text-lg font-black text-slate-900">
              Kiểm tra thông tin trước khi gửi
            </h4>

            <p className="mt-2 text-sm leading-7 text-slate-600">
              Vui lòng kiểm tra lại toàn bộ thông tin đã nhập.
              Sau khi gửi hồ sơ, bộ phận tuyển dụng sẽ tiếp nhận và xử lý.
              Nếu cần chỉnh sửa sau khi gửi, vui lòng liên hệ bộ phận Nhân sự.
            </p>

          </div>

        </div>

      </div>

      {/* Submit */}

      <Button
        onClick={handleNewSubmit}
        disabled={loading}
        variant="gold"
        size="xl"
        className="
          h-14
          w-full
          rounded-2xl
          text-base
          font-black
          shadow-[0_15px_40px_rgba(217,163,39,.30)]
          transition-all
          duration-300
          hover:-translate-y-0.5
        "
      >
        {loading ? (
          <Loader2 className="h-6 w-6 animate-spin" />
        ) : (
          <>
            Hoàn tất đăng ký
            <span className="ml-2 text-lg">
              →
            </span>
          </>
        )}
      </Button>

      {/* Back */}

      <Button
        onClick={reset}
        variant="outline"
        className="
          h-12
          w-full
          rounded-2xl
          border-slate-300
          font-semibold
          transition-all
          hover:bg-slate-50
        "
      >
        ← Quay lại bước trước
      </Button>

    </CardContent>

  </Card>
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
