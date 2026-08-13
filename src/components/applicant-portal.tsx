"use client";

import { useState } from "react";
import { Button, Card, CardContent, Input, Label, SearchableSelect, toast } from "@/components/ui";
import { AlertTriangle, CheckCircle2, Clock, Loader2, Search, ShieldCheck, Sparkles, UserPlus, XCircle } from "lucide-react";
import { CccdQrScanner, type CccdQrData } from "@/components/cccd-qr-scanner";
import type { FormQuestion } from "@/db/schema";
import { isQuestionForAudience } from "@/lib/form-targeting";
import { CCCD_ERROR_MESSAGE, isValidCccd } from "@/lib/validators";
import Link from "next/link";

type Stage = "check" | "returning_autofilled" | "already_registered" | "new" | "success";

type WorkerInfo = {
  full_name?: string;
  address_current?: string | null;
  status?: string;
  dept_name?: string | null;
  dept_location?: string | null;
};

function DynamicQuestionFields({
  questions,
  answers,
  onChange,
  title,
}: {
  questions: FormQuestion[];
  answers: Record<string, string>;
  onChange: (fieldKey: string, value: string) => void;
  title: string;
}) {
  return (
    <div className="space-y-6 border-t border-slate-200 pt-8">
      <div className="flex items-center gap-3">
        <div className="h-8 w-1 rounded-full bg-gold-500" />
        <div>
          <h3 className="text-xl font-black text-slate-900">{title}</h3>
          <p className="mt-1 text-sm text-slate-500">Vui lòng hoàn thành các câu hỏi áp dụng cho hồ sơ của bạn.</p>
        </div>
      </div>

      {questions.map((question) => (
        <div
          key={question.id}
          className="rounded-3xl border border-border bg-surface p-6 transition-all duration-200 hover:border-primary/40 hover:shadow-md"
        >
          <Label className="mb-4 block text-base font-semibold leading-7 text-slate-800">
            {question.questionText}
            {question.isRequired && <span className="ml-1 text-red-500">*</span>}
          </Label>

          {question.fieldType === "SELECT" && (question.options?.length ?? 0) > 0 ? (
            <SearchableSelect
              value={answers[question.fieldKey]}
              onChange={(value) => onChange(question.fieldKey, value)}
              options={(question.options ?? []).map((item) => ({ value: item, label: item }))}
            />
          ) : question.fieldType === "BOOLEAN" ? (
            <div className="grid grid-cols-2 gap-4">
              <Button
                type="button"
                size="lg"
                variant={answers[question.fieldKey] === "Có" ? "success" : "outline"}
                onClick={() => onChange(question.fieldKey, "Có")}
                className="h-12 rounded-2xl font-bold"
              >
                ✓ Có
              </Button>
              <Button
                type="button"
                size="lg"
                variant={answers[question.fieldKey] === "Không" ? "destructive" : "outline"}
                onClick={() => onChange(question.fieldKey, "Không")}
                className="h-12 rounded-2xl font-bold"
              >
                ✕ Không
              </Button>
            </div>
          ) : (
            <Input
              type={question.fieldType === "NUMBER" ? "number" : question.fieldType === "DATE" ? "date" : "text"}
              value={answers[question.fieldKey] || ""}
              onChange={(event) => onChange(question.fieldKey, event.target.value)}
              placeholder="Nhập câu trả lời..."
              className="h-14 rounded-2xl bg-slate-50 px-5"
            />
          )}

          {question.isRequired && <p className="mt-3 text-xs text-slate-400">Trường này là bắt buộc.</p>}
        </div>
      ))}
    </div>
  );
}

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

  const newQuestions = questions.filter((question) => isQuestionForAudience(question, "NEW"));
  const returningQuestions = questions.filter((question) => isQuestionForAudience(question, "RETURNING"));

  const setAnswer = (fieldKey: string, value: string) => {
    setCustomAnswers((current) => ({ ...current, [fieldKey]: value }));
  };

  const validateAnswers = (applicableQuestions: FormQuestion[]) => {
    const missing = applicableQuestions.find(
      (question) => question.isRequired && !customAnswers[question.fieldKey]?.trim(),
    );
    if (missing) {
      toast({ title: `Thiếu: ${missing.questionText}`, variant: "destructive" });
      return false;
    }
    return true;
  };

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
    if (!isValidCccd(cccd)) {
      toast({ title: CCCD_ERROR_MESSAGE, variant: "destructive" });
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
    if (!validateAnswers(returningQuestions)) return;
    setLoading(true);
    try {
      const res = await fetch("/api/registrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cccd,
          phone,
          full_name: workerInfo?.full_name,
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

  const handleNewSubmit = async () => {
    if (!fullName.trim() || !dob) {
      toast({ title: "Vui lòng nhập Họ Tên và Ngày Sinh", variant: "destructive" });
      return;
    }
    if (!validateAnswers(newQuestions)) return;
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
                  bạn là người tập nghề mới hay đã có hồ sơ tại
                  Dalat Hasfarm.
                </p>
      
              </div>
      
            </div>
      
          </div>
      
          <CardContent className="space-y-8 p-8">
      
            {/* CCCD */}
      
            <div className="space-y-3">
      
              <Label className="text-sm font-bold text-slate-700">
                Số CCCD
                <span className="ml-1 text-red-500">*</span>
              </Label>
      
              <div className="space-y-3">

                <Input
                  type="tel"
                  inputMode="numeric"
                  maxLength={12}
                  value={cccd}
                  placeholder="Nhập đúng 12 chữ số"
                  onChange={(e) =>
                    setCccd(e.target.value.replace(/\D/g, ""))
                  }
                  className="h-14 rounded-2xl border-slate-300 bg-slate-50 px-5 text-lg font-semibold tracking-[0.18em]"
                />
              
                <div className="flex justify-end">
                  <CccdQrScanner onResult={handleQrScanned} />
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

      <div className="rounded-3xl border border-border bg-surface p-6">

        <p className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">
          Trạng thái hồ sơ
        </p>

        <div className="mt-4">

          {workerInfo?.status === "APPROVED" && (
            <div className="inline-flex items-center gap-2 rounded-full bg-emerald-100 px-5 py-2 font-bold text-emerald-700">
              <CheckCircle2 className="h-4 w-4" aria-hidden /> Đã tiếp nhận
            </div>
          )}

          {workerInfo?.status === "REJECTED" && (
            <div className="inline-flex items-center gap-2 rounded-full bg-red-100 px-5 py-2 font-bold text-red-700">
              <XCircle className="h-4 w-4" aria-hidden /> Không tiếp nhận hôm nay
            </div>
          )}

          {workerInfo?.status !== "APPROVED" &&
            workerInfo?.status !== "REJECTED" && (
              <div className="inline-flex items-center gap-2 rounded-full bg-amber-100 px-5 py-2 font-bold text-amber-700">
                <Clock className="h-4 w-4" aria-hidden /> Đang chờ sắp xếp
              </div>
            )}

        </div>

        {workerInfo?.dept_name && (
          <div className="mt-6 rounded-2xl bg-primary-tint p-4">

            <p className="text-xs uppercase tracking-wider text-slate-500">
              Bộ phận
            </p>

            <p className="mt-2 font-bold text-primary">
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

      <div className="rounded-3xl border border-border bg-surface p-6">

        <p className="text-xs uppercase tracking-[0.2em] text-slate-500">
          Địa chỉ hiện tại
        </p>

        <p className="mt-3 leading-7 text-slate-700">
          {workerInfo?.address_current || "Chưa cập nhật"}
        </p>

      </div>

      {returningQuestions.length > 0 && (
        <DynamicQuestionFields
          questions={returningQuestions}
          answers={customAnswers}
          onChange={setAnswer}
          title="Thông tin cần cập nhật"
        />
      )}

      <div className="rounded-3xl border border-emerald-200 bg-emerald-50 p-5">

        <p className="font-bold text-emerald-900">
          Hệ thống đã nhận diện bạn là người tập nghề đã có hồ sơ.
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

      {newQuestions.length > 0 && (
        <DynamicQuestionFields
          questions={newQuestions}
          answers={customAnswers}
          onChange={setAnswer}
          title="Thông tin bổ sung"
        />
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

          

      {stage === "success" && (
  <Card className="overflow-hidden rounded-[32px] border-0 bg-white shadow-[0_25px_80px_rgba(15,23,42,.10)] ring-1 ring-emerald-200">

    {/* Header */}

    <div className="bg-gradient-to-r from-emerald-600 via-emerald-700 to-hasfarm-700 px-8 py-8 text-white">

      <div className="flex items-center gap-5">

        <div className="flex h-16 w-16 items-center justify-center rounded-3xl bg-white/15 backdrop-blur">
          <CheckCircle2 className="h-9 w-9" />
        </div>

        <div>

          <p className="text-xs font-bold uppercase tracking-[0.25em] text-emerald-100">
            HOÀN TẤT
          </p>

          <h2 className="mt-2 text-3xl font-black">
            Đăng ký thành công
          </h2>

          <p className="mt-2 text-sm leading-7 text-white/80">
            Hồ sơ của bạn đã được ghi nhận vào hệ thống tuyển dụng Dalat Hasfarm.
          </p>

        </div>

      </div>

    </div>

    <CardContent className="space-y-7 p-8">

      {/* Success Box */}

      <div className="rounded-3xl border border-emerald-200 bg-emerald-50 p-6">

        <div className="flex gap-4">

          <div className="text-3xl">
            🎉
          </div>

          <div>

            <h3 className="text-lg font-black text-emerald-900">
              Hồ sơ đã được tiếp nhận
            </h3>

            <p className="mt-2 text-sm leading-7 text-slate-700">

              Bộ phận Nhân sự sẽ kiểm tra và phân công bộ phận làm việc.

              <br />

              Nếu bạn là người tập nghề mới, hồ sơ sẽ được xác minh trước khi đưa vào
              danh sách tiếp nhận chính thức.

            </p>

          </div>

        </div>

      </div>

      {/* Timeline */}

      <div className="rounded-3xl border border-border bg-surface p-6">

        <h3 className="text-lg font-black text-slate-900">
          Các bước tiếp theo
        </h3>

        <div className="mt-6 space-y-5">

          <div className="flex gap-4">

            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-hasfarm-700 text-sm font-bold text-white">
              1
            </div>

            <div>

              <p className="font-semibold text-slate-900">
                Nhân sự tiếp nhận hồ sơ
              </p>

              <p className="text-sm text-slate-500">
                Kiểm tra thông tin và xác minh dữ liệu.
              </p>

            </div>

          </div>

          <div className="flex gap-4">

            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-hasfarm-700 text-sm font-bold text-white">
              2
            </div>

            <div>

              <p className="font-semibold text-slate-900">
                Phân công bộ phận
              </p>

              <p className="text-sm text-slate-500">
                Sắp xếp vị trí làm việc phù hợp.
              </p>

            </div>

          </div>

          <div className="flex gap-4">

            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-hasfarm-700 text-sm font-bold text-white">
              3
            </div>

            <div>

              <p className="font-semibold text-slate-900">
                Tra cứu kết quả
              </p>

              <p className="text-sm text-slate-500">
                Sau khi HR xử lý, bạn có thể xem kết quả ngay trên hệ thống.
              </p>

            </div>

          </div>

        </div>

      </div>

      {/* Notice */}

      <div className="rounded-3xl border border-blue-200 bg-blue-50 p-5">

        <p className="text-sm leading-7 text-slate-700">

          <span className="font-bold text-blue-900">
            Lưu ý:
          </span>

          {" "}Trong thời gian chờ xử lý, vui lòng không đăng ký nhiều lần trong cùng một ngày.
          Nếu cần cập nhật thông tin, hãy liên hệ bộ phận Nhân sự.

        </p>

      </div>

      {/* Action Buttons */}

      <div className="grid gap-4 md:grid-cols-2">

        <Link href="/lookup">

          <Button
            variant="gold"
            className="h-14 w-full rounded-2xl text-base font-black shadow-[0_15px_40px_rgba(217,163,39,.30)]"
          >
            <Search className="h-4 w-4" /> Tra cứu kết quả
          </Button>

        </Link>

        <Button
          onClick={reset}
          variant="outline"
          className="h-14 rounded-2xl"
        >
          👤 Đăng ký cho người khác
        </Button>

      </div>

      {/* Footer */}

      <div className="border-t border-slate-200 pt-5 text-center">

        <p className="text-xs leading-6 text-slate-500">
          Cảm ơn bạn đã đăng ký làm việc tại
          <span className="font-bold text-hasfarm-700">
            {" "}Dalat Hasfarm.
          </span>

          <br />

          Chúc bạn có một ngày làm việc hiệu quả!

        </p>

      </div>

    </CardContent>

  </Card>
)}
    </div>
  );
}
