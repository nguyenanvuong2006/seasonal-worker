"use client";

import { useState } from "react";
import { Button, Card, CardContent, Input, Label, SearchableSelect, toast, cn } from "@/components/ui";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock,
  Loader2,
  Lock,
  ScanLine,
  Search,
  ShieldCheck,
  Sparkles,
  UserPlus,
  XCircle,
} from "lucide-react";
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

/** Progress journey shared by every stage (1 Xác thực → 2 Đăng ký → 3 Hoàn tất). */
function Journey({ current }: { current: 1 | 2 | 3 }) {
  const steps = [
    { n: 1, label: "Xác thực" },
    { n: 2, label: "Đăng ký" },
    { n: 3, label: "Hoàn tất" },
  ];
  return (
    <ol className="flex items-center gap-2" aria-label="Tiến trình đăng ký">
      {steps.map((s, i) => (
        <li key={s.n} className="flex items-center gap-2">
          {i > 0 ? <span className={cn("h-px w-5", current > i ? "bg-accent" : "bg-white/25")} aria-hidden /> : null}
          <span
            className={cn(
              "flex items-center gap-1.5 rounded-full px-2 py-1 text-[10.5px] font-bold uppercase tracking-wider",
              current === s.n ? "bg-accent text-white" : current > s.n ? "bg-white/15 text-white" : "bg-white/10 text-white/60",
            )}
            aria-current={current === s.n ? "step" : undefined}
          >
            <span className="flex h-4 w-4 items-center justify-center rounded-full bg-white/25 text-[9px]">{s.n}</span>
            {s.label}
          </span>
        </li>
      ))}
    </ol>
  );
}

function StageHeader({
  kicker,
  title,
  subtitle,
  current,
  icon,
  iconClassName = "bg-white/15",
}: {
  kicker: string;
  title: string;
  subtitle?: string;
  current: 1 | 2 | 3;
  icon: React.ReactNode;
  iconClassName?: string;
}) {
  return (
    <div className="hasfarm-hero field-rows px-6 py-6 text-white md:px-8">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <div className={cn("flex h-12 w-12 shrink-0 items-center justify-center rounded-[14px] backdrop-blur ring-1 ring-white/20", iconClassName)}>
            {icon}
          </div>
          <div>
            <p className="text-[10.5px] font-bold uppercase tracking-[0.22em] text-gold-200">{kicker}</p>
            <h2 className="mt-1.5 text-[26px] font-black leading-tight tracking-[-0.015em] md:text-[30px]">{title}</h2>
            {subtitle ? <p className="mt-2 max-w-xl text-[13.5px] leading-6 text-white/80">{subtitle}</p> : null}
          </div>
        </div>
        <div className="hidden shrink-0 md:block">
          <Journey current={current} />
        </div>
      </div>
    </div>
  );
}

function TrustNote() {
  return (
    <p className="flex items-center justify-center gap-1.5 pt-4 text-[11px] font-medium text-fg-muted">
      <Lock className="h-3 w-3" aria-hidden />
      Thông tin được bảo mật và chỉ dùng cho mục đích tuyển dụng của Dalat Hasfarm.
    </p>
  );
}

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
    <div className="space-y-6 border-t border-border pt-8">
      <div className="flex items-center gap-3">
        <div className="h-8 w-1 rounded-full bg-accent" />
        <div>
          <h3 className="text-xl font-black text-fg">{title}</h3>
          <p className="mt-1 text-sm text-fg-secondary">Vui lòng hoàn thành các câu hỏi áp dụng cho hồ sơ của bạn.</p>
        </div>
      </div>

      {questions.map((question) => (
        <div
          key={question.id}
          className="rounded-[20px] border border-border bg-botanical-50/60 p-5 transition-all duration-200 hover:border-primary/30 hover:shadow-sm md:p-6"
        >
          <Label className="mb-3 block text-[15px] font-semibold leading-7 text-fg">
            {question.questionText}
            {question.isRequired && <span className="ml-1 text-danger">*</span>}
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
              className="h-14 rounded-2xl border-border bg-surface-raised px-5 text-[15px]"
            />
          )}

          {question.isRequired && <p className="mt-3 text-xs text-fg-muted">Trường này là bắt buộc.</p>}
        </div>
      ))}
    </div>
  );
}

function FieldError({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="mt-1.5 flex items-center gap-1 text-[12px] font-semibold text-danger">
      <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden /> {message}
    </p>
  );
}

const inputClass = "h-14 rounded-2xl border-border bg-surface-raised px-5 text-[16px] font-medium tracking-[0.02em] focus:border-accent focus:ring-2 focus:ring-accent/20";

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

  // Inline validation display (rules are unchanged — same checks as before)
  const [cccdError, setCccdError] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [dobError, setDobError] = useState<string | null>(null);

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
    setCccdError(null);
    setPhoneError(null);
    setNameError(null);
    setDobError(null);
  };

  // QUÉT QR CCCD (#11) — tự điền form, không lưu ảnh ở đâu cả.
  const handleQrScanned = (data: CccdQrData) => {
    setCccd(data.cccd);
    setCccdError(null);
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
    setCccdError(null);
    setPhoneError(null);
    if (!isValidCccd(cccd)) {
      setCccdError(CCCD_ERROR_MESSAGE);
      toast({ title: CCCD_ERROR_MESSAGE, variant: "destructive" });
      return;
    }
    if (!/^\d{9,11}$/.test(phone)) {
      setPhoneError("Vui lòng nhập số điện thoại hợp lệ");
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
    setNameError(null);
    setDobError(null);
    if (!fullName.trim() || !dob) {
      if (!fullName.trim()) setNameError("Vui lòng nhập Họ và Tên");
      if (!dob) setDobError("Vui lòng chọn Ngày sinh");
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
      {/* ================= BƯỚC 1: XÁC THỰC ================= */}
      {stage === "check" && (
        <Card className="overflow-hidden rounded-[24px] border-border shadow-[0_24px_70px_rgba(23,32,18,0.12)]">
          <StageHeader
            current={1}
            kicker="Bước 1 / 2 · Xác thực"
            title="Xác thực thông tin ứng viên"
            subtitle="Nhập số CCCD và số điện thoại để hệ thống kiểm tra bạn là người tập nghề mới hay đã có hồ sơ tại Dalat Hasfarm."
            icon={<ShieldCheck className="h-6 w-6" />}
          />
          <CardContent className="space-y-7 p-6 md:p-8">
            <div className="space-y-3">
              <Label className="text-[14px] font-bold text-fg">
                Số CCCD
                <span className="ml-1 text-danger">*</span>
              </Label>
              <Input
                type="tel"
                inputMode="numeric"
                maxLength={12}
                value={cccd}
                placeholder="Nhập đúng 12 chữ số"
                aria-invalid={Boolean(cccdError)}
                onChange={(e) => {
                  setCccd(e.target.value.replace(/\D/g, ""));
                  setCccdError(null);
                }}
                className={cn(inputClass, cccdError && "border-danger focus:border-danger focus:ring-danger/20")}
              />
              <div className="flex items-center justify-between gap-3">
                <FieldError message={cccdError} />
                <CccdQrScanner onResult={handleQrScanned} />
              </div>
              <div className="flex items-start gap-2.5 rounded-2xl border border-info/15 bg-info-tint px-4 py-3 text-[13px] leading-6 text-fg-secondary">
                <ScanLine className="mt-1 h-4 w-4 shrink-0 text-info" aria-hidden />
                <p>
                  <b className="text-fg">Mẹo:</b> bấm <b>Quét QR CCCD</b> để tự động điền thông tin, hạn chế sai sót khi nhập.
                </p>
              </div>
            </div>

            <div className="space-y-3">
              <Label className="text-[14px] font-bold text-fg">
                Số điện thoại
                <span className="ml-1 text-danger">*</span>
              </Label>
              <Input
                type="tel"
                inputMode="numeric"
                maxLength={11}
                value={phone}
                placeholder="Ví dụ: 0901234567"
                aria-invalid={Boolean(phoneError)}
                onChange={(e) => {
                  setPhone(e.target.value.replace(/\D/g, ""));
                  setPhoneError(null);
                }}
                className={cn(inputClass, phoneError && "border-danger focus:border-danger focus:ring-danger/20")}
              />
              <FieldError message={phoneError} />
            </div>

            <div className="flex items-start gap-3 rounded-[20px] border border-success/20 bg-success-tint/60 p-5">
              <span className="text-2xl" aria-hidden>🌱</span>
              <div>
                <p className="font-bold text-primary">Hệ thống nhận diện tự động</p>
                <p className="mt-1.5 text-[13.5px] leading-7 text-fg-secondary">
                  Nếu bạn đã từng làm việc tại Dalat Hasfarm, hệ thống sẽ tự động nhận diện và điền lại hồ sơ.
                  <br />
                  Nếu là lần đầu đăng ký, bạn chỉ cần khai báo thông tin một lần.
                </p>
              </div>
            </div>

            <Button onClick={handleCheck} disabled={loading} variant="primary" size="xl" className="h-14 w-full rounded-2xl text-[15px] font-black shadow-[0_14px_30px_rgba(226,109,28,0.35)] transition hover:-translate-y-0.5">
              {loading ? <Loader2 className="h-6 w-6 animate-spin" /> : <>Kiểm tra hồ sơ <ArrowRight className="h-5 w-5" aria-hidden /></>}
            </Button>
            <TrustNote />
          </CardContent>
        </Card>
      )}

      {/* ================= ĐÃ ĐĂNG KÝ HÔM NAY ================= */}
      {stage === "already_registered" && (
        <Card className="overflow-hidden rounded-[24px] border-border shadow-[0_24px_70px_rgba(23,32,18,0.12)]">
          <StageHeader
            current={3}
            kicker="Đã có hồ sơ hôm nay"
            title="Bạn đã đăng ký hôm nay"
            subtitle="Không cần đăng ký lại — hồ sơ của bạn đã được hệ thống ghi nhận."
            icon={<AlertTriangle className="h-6 w-6" />}
            iconClassName="bg-accent/25"
          />
          <CardContent className="space-y-6 p-6 md:p-8">
            <div className="rounded-[18px] border border-border bg-botanical-50 p-5">
              <p className="text-[10.5px] font-bold uppercase tracking-[0.18em] text-fg-muted">Ứng viên</p>
              <p className="mt-1.5 text-[22px] font-black text-fg">{workerInfo?.full_name || cccd}</p>
            </div>

            <div className="rounded-[18px] border border-border bg-surface-raised p-5">
              <p className="text-[10.5px] font-bold uppercase tracking-[0.18em] text-fg-muted">Trạng thái hồ sơ</p>
              <div className="mt-3">
                {workerInfo?.status === "APPROVED" && (
                  <span className="inline-flex items-center gap-2 rounded-full bg-success-tint px-4 py-1.5 font-bold text-success">
                    <CheckCircle2 className="h-4 w-4" aria-hidden /> Đã tiếp nhận
                  </span>
                )}
                {workerInfo?.status === "REJECTED" && (
                  <span className="inline-flex items-center gap-2 rounded-full bg-danger-tint px-4 py-1.5 font-bold text-danger">
                    <XCircle className="h-4 w-4" aria-hidden /> Không tiếp nhận hôm nay
                  </span>
                )}
                {workerInfo?.status !== "APPROVED" && workerInfo?.status !== "REJECTED" && (
                  <span className="inline-flex items-center gap-2 rounded-full bg-warning-tint px-4 py-1.5 font-bold text-warning">
                    <Clock className="h-4 w-4" aria-hidden /> Đang chờ sắp xếp
                  </span>
                )}
              </div>
              {workerInfo?.dept_name ? (
                <div className="mt-4 rounded-[14px] bg-primary-tint p-4">
                  <p className="text-[10.5px] uppercase tracking-wider text-fg-muted">Bộ phận</p>
                  <p className="mt-1 font-bold text-primary">{workerInfo.dept_name}</p>
                </div>
              ) : null}
              {workerInfo?.dept_location ? (
                <div className="mt-3 rounded-[14px] bg-botanical-50 p-4">
                  <p className="text-[10.5px] uppercase tracking-wider text-fg-muted">Địa điểm</p>
                  <p className="mt-1 font-semibold text-fg">📍 {workerInfo.dept_location}</p>
                </div>
              ) : null}
            </div>

            <div className="rounded-[18px] border border-warning/20 bg-warning-tint/70 p-5 text-[13.5px] leading-7 text-fg-secondary">
              Hồ sơ của bạn đã được ghi nhận trong ngày hôm nay. Vui lòng sử dụng chức năng{" "}
              <Link href="/lookup" className="font-bold text-primary underline-offset-2 hover:underline">
                Tra cứu kết quả
              </Link>{" "}
              để theo dõi tiến trình xử lý.
            </div>

            <Button onClick={reset} variant="outline" className="h-13 w-full rounded-2xl py-3.5 font-semibold">
              Kiểm tra CCCD khác
            </Button>
          </CardContent>
        </Card>
      )}

      {/* ================= NGƯỜI CŨ QUAY LẠI ================= */}
      {stage === "returning_autofilled" && (
        <Card className="overflow-hidden rounded-[24px] border-border shadow-[0_24px_70px_rgba(23,32,18,0.12)]">
          <StageHeader
            current={2}
            kicker="Hồ sơ đã xác minh · Bước 2 / 2"
            title="Chào mừng bạn quay trở lại"
            subtitle="Hệ thống đã tìm thấy hồ sơ của bạn. Chỉ cần xác nhận để gửi yêu cầu làm việc hôm nay."
            icon={<ShieldCheck className="h-6 w-6" />}
            iconClassName="bg-success/30"
          />
          <CardContent className="space-y-7 p-6 md:p-8">
            <div className="rounded-[18px] border border-border bg-botanical-50 p-5">
              <p className="text-[10.5px] uppercase tracking-[0.18em] text-fg-muted">Họ và tên</p>
              <p className="mt-1.5 text-[22px] font-black text-fg">{workerInfo?.full_name}</p>
            </div>

            <div className="rounded-[18px] border border-border bg-surface-raised p-5">
              <p className="text-[10.5px] uppercase tracking-[0.18em] text-fg-muted">Địa chỉ hiện tại</p>
              <p className="mt-2 leading-7 text-fg-secondary">{workerInfo?.address_current || "Chưa cập nhật"}</p>
            </div>

            {returningQuestions.length > 0 && (
              <DynamicQuestionFields questions={returningQuestions} answers={customAnswers} onChange={setAnswer} title="Thông tin cần cập nhật" />
            )}

            <div className="flex items-start gap-3 rounded-[20px] border border-success/20 bg-success-tint/60 p-5">
              <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-success" aria-hidden />
              <div>
                <p className="font-bold text-primary">Hệ thống đã nhận diện bạn là người tập nghề đã có hồ sơ.</p>
                <p className="mt-1.5 text-[13.5px] leading-7 text-fg-secondary">
                  Bạn chỉ cần xác nhận để gửi yêu cầu làm việc hôm nay. Không cần khai báo lại toàn bộ thông tin cá nhân.
                </p>
              </div>
            </div>

            <Button onClick={handleConfirmReturning} disabled={loading} variant="primary" size="xl" className="h-14 w-full rounded-2xl text-[15px] font-black shadow-[0_14px_30px_rgba(226,109,28,0.35)]">
              {loading ? <Loader2 className="h-6 w-6 animate-spin" /> : <>Xác nhận đăng ký làm việc <CheckCircle2 className="h-5 w-5" aria-hidden /></>}
            </Button>
            <Button onClick={reset} variant="ghost" className="h-12 w-full rounded-2xl">
              ← Quay lại
            </Button>
          </CardContent>
        </Card>
      )}

      {/* ================= NGƯỜI MỚI ================= */}
      {stage === "new" && (
        <Card className="overflow-hidden rounded-[24px] border-border shadow-[0_24px_70px_rgba(23,32,18,0.12)]">
          <StageHeader
            current={2}
            kicker="Hồ sơ mới · Bước 2 / 2"
            title="Đăng ký thông tin lần đầu"
            subtitle="Hoàn thành đầy đủ thông tin bên dưới để bộ phận tuyển dụng tiếp nhận hồ sơ và bố trí vị trí phù hợp."
            icon={<UserPlus className="h-6 w-6" />}
          />
          <CardContent className="space-y-8 p-6 md:p-8">
            {/* QR */}
            <div className="flex flex-col gap-4 rounded-[20px] border border-info/15 bg-info-tint p-5 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="font-bold text-fg">Quét mã QR trên CCCD</p>
                <p className="mt-1.5 text-[13.5px] leading-6 text-fg-secondary">
                  Hệ thống sẽ tự động điền Họ tên, Ngày sinh, Địa chỉ và Giới tính nếu đọc được dữ liệu.
                </p>
              </div>
              <div className="shrink-0">
                <CccdQrScanner onResult={handleQrScanned} />
              </div>
            </div>

            {/* Personal */}
            <div>
              <div className="mb-5 flex items-center gap-3">
                <div className="h-8 w-1 rounded-full bg-accent" />
                <h3 className="text-xl font-black text-fg">Thông tin cá nhân</h3>
              </div>
              <div className="grid gap-6 md:grid-cols-2">
                <div className="space-y-2">
                  <Label className="text-[14px] font-bold text-fg">
                    Họ và tên
                    <span className="ml-1 text-danger">*</span>
                  </Label>
                  <Input
                    value={fullName}
                    aria-invalid={Boolean(nameError)}
                    onChange={(e) => {
                      setFullName(e.target.value);
                      setNameError(null);
                    }}
                    placeholder="Nguyễn Văn A"
                    className={cn(inputClass, nameError && "border-danger focus:border-danger focus:ring-danger/20")}
                  />
                  <FieldError message={nameError} />
                </div>
                <div className="space-y-2">
                  <Label className="text-[14px] font-bold text-fg">
                    Ngày sinh
                    <span className="ml-1 text-danger">*</span>
                  </Label>
                  <Input
                    type="date"
                    value={dob}
                    aria-invalid={Boolean(dobError)}
                    onChange={(e) => {
                      setDob(e.target.value);
                      setDobError(null);
                    }}
                    className={cn(inputClass, dobError && "border-danger focus:border-danger focus:ring-danger/20")}
                  />
                  <FieldError message={dobError} />
                </div>
              </div>
            </div>

            {/* Address */}
            <div className="space-y-2">
              <Label className="text-[14px] font-bold text-fg">Địa chỉ hiện tại</Label>
              <Input
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="Ví dụ: 123 Trần Phú, Phường Xuân Hương, Đà Lạt..."
                className={inputClass}
              />
            </div>

            {newQuestions.length > 0 && <DynamicQuestionFields questions={newQuestions} answers={customAnswers} onChange={setAnswer} title="Thông tin bổ sung" />}

            {/* Confirmation */}
            <div className="rounded-[20px] border border-accent/20 bg-gradient-to-r from-accent-tint/70 to-surface-raised p-6">
              <div className="flex items-start gap-4">
                <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] bg-accent text-white shadow-[0_8px_16px_rgba(226,109,28,0.35)]">
                  <CheckCircle2 className="h-5 w-5" aria-hidden />
                </div>
                <div>
                  <h4 className="text-[16px] font-black text-fg">Kiểm tra thông tin trước khi gửi</h4>
                  <p className="mt-1.5 text-[13.5px] leading-7 text-fg-secondary">
                    Vui lòng kiểm tra lại toàn bộ thông tin đã nhập. Sau khi gửi hồ sơ, bộ phận tuyển dụng sẽ tiếp nhận và xử lý.
                    Nếu cần chỉnh sửa sau khi gửi, vui lòng liên hệ bộ phận Nhân sự.
                  </p>
                </div>
              </div>
            </div>

            {/* Submit */}
            <Button
              onClick={handleNewSubmit}
              disabled={loading}
              variant="primary"
              size="xl"
              className="h-14 w-full rounded-2xl text-[15px] font-black shadow-[0_14px_30px_rgba(226,109,28,0.35)] transition-all duration-300 hover:-translate-y-0.5"
            >
              {loading ? <Loader2 className="h-6 w-6 animate-spin" /> : <>Hoàn tất đăng ký <ArrowRight className="h-5 w-5" aria-hidden /></>}
            </Button>
            <Button onClick={reset} variant="outline" className="h-12 w-full rounded-2xl border-border-strong font-semibold">
              ← Quay lại bước trước
            </Button>
          </CardContent>
        </Card>
      )}

      {/* ================= THÀNH CÔNG ================= */}
      {stage === "success" && (
        <Card className="overflow-hidden rounded-[24px] border-border shadow-[0_24px_70px_rgba(23,32,18,0.12)]">
          <div className="hasfarm-hero field-rows px-6 py-8 text-white md:px-8">
            <div className="flex items-center gap-5">
              <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-[18px] bg-white/15 ring-1 ring-white/25 backdrop-blur">
                <CheckCircle2 className="h-9 w-9" />
              </div>
              <div>
                <p className="text-[10.5px] font-bold uppercase tracking-[0.22em] text-gold-200">Hoàn tất</p>
                <h2 className="mt-1.5 text-[28px] font-black leading-tight md:text-[32px]">Đăng ký thành công</h2>
                <p className="mt-1.5 text-[13.5px] leading-6 text-white/80">
                  Hồ sơ của bạn đã được ghi nhận vào hệ thống tuyển dụng Dalat Hasfarm.
                </p>
              </div>
            </div>
          </div>

          <CardContent className="space-y-7 p-6 md:p-8">
            <div className="flex gap-4 rounded-[20px] border border-success/20 bg-success-tint/60 p-6">
              <span className="text-3xl" aria-hidden>🎉</span>
              <div>
                <h3 className="text-[17px] font-black text-primary">Hồ sơ đã được tiếp nhận</h3>
                <p className="mt-1.5 text-[13.5px] leading-7 text-fg-secondary">
                  Bộ phận Nhân sự sẽ kiểm tra và phân công bộ phận làm việc.
                  <br />
                  Nếu bạn là người tập nghề mới, hồ sơ sẽ được xác minh trước khi đưa vào danh sách tiếp nhận chính thức.
                </p>
              </div>
            </div>

            <div className="rounded-[20px] border border-border bg-surface-raised p-6">
              <h3 className="text-[16px] font-black text-fg">Các bước tiếp theo</h3>
              <div className="mt-5 space-y-5">
                {[
                  ["Nhân sự tiếp nhận hồ sơ", "Kiểm tra thông tin và xác minh dữ liệu."],
                  ["Phân công bộ phận", "Sắp xếp vị trí làm việc phù hợp."],
                  ["Tra cứu kết quả", "Sau khi HR xử lý, bạn có thể xem kết quả ngay trên hệ thống."],
                ].map(([t, d], i) => (
                  <div key={t} className="flex gap-4">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-white">{i + 1}</div>
                    <div>
                      <p className="font-semibold text-fg">{t}</p>
                      <p className="text-[13px] text-fg-secondary">{d}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-[18px] border border-info/15 bg-info-tint p-5">
              <p className="text-[13.5px] leading-7 text-fg-secondary">
                <span className="font-bold text-info">Lưu ý:</span> trong thời gian chờ xử lý, vui lòng không đăng ký nhiều lần trong cùng một ngày.
                Nếu cần cập nhật thông tin, hãy liên hệ bộ phận Nhân sự.
              </p>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <Link href="/lookup">
                <Button variant="primary" className="h-14 w-full rounded-2xl text-[15px] font-black shadow-[0_14px_30px_rgba(226,109,28,0.35)]">
                  <Search className="h-4 w-4" aria-hidden /> Tra cứu kết quả
                </Button>
              </Link>
              <Button onClick={reset} variant="outline" className="h-14 w-full rounded-2xl border-border-strong">
                👤 Đăng ký cho người khác
              </Button>
            </div>

            <div className="border-t border-border pt-5 text-center">
              <p className="text-xs leading-6 text-fg-muted">
                Cảm ơn bạn đã đăng ký làm việc tại <b className="font-bold text-primary">Dalat Hasfarm.</b>
                <br />
                Chúc bạn có một ngày làm việc hiệu quả!
              </p>
            </div>
            <TrustNote />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
