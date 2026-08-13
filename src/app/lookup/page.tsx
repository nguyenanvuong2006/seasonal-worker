"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge, Button, Card, CardContent, Input, Label, toast } from "@/components/ui";
import { BrandLogo } from "@/components/brand-logo";
import { formatDate, STATUS_META, todayStr } from "@/lib/helpers";
import { CCCD_ERROR_MESSAGE, isValidCccd } from "@/lib/validators";
import { ArrowLeft, CheckCircle2, Clock, Search, ShieldCheck, XCircle } from "lucide-react";

type HistoryRow = { id: string; regDate: string; status: string; deptName: string | null; startingDate: string | null };
type LookupResult = {
  worker: { fullName: string; isVerified: boolean };
  history: HistoryRow[];
};

export default function LookupPage() {
  const [cccd, setCccd] = useState("");
  const [phone, setPhone] = useState("");
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<LookupResult | null>(null);
  const [notFound, setNotFound] = useState(false);

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
    setData(null);
    setNotFound(false);
    try {
      const res = await fetch("/api/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cccd, phone }),
      });
      const json = await res.json();
      if (!res.ok) {
        setNotFound(true);
        toast({ title: json.error ?? "Không tìm thấy", variant: "destructive" });
        return;
      }
      setData(json);
    } finally {
      setLoading(false);
    }
  };

  const today = todayStr();
  const todayRow = data?.history.find((h) => h.regDate === today);

  return (
    <main className="min-h-screen bg-bg">
      <div className="border-b border-amber-200/60 bg-gold-50 px-4 py-2 text-center text-[11px] font-bold uppercase tracking-widest text-gold-800">
        Tra cứu trạng thái • Xuất hiện ngay sau khi HR xác nhận là người mới & xếp việc
      </div>

      <header className="hasfarm-hero px-4 pb-16 pt-6 text-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between">
          <BrandLogo light />
          <Link href="/" className="flex items-center gap-1.5 rounded-full border border-white/20 bg-white/10 px-4 py-2 text-xs font-bold backdrop-blur hover:bg-white/15">
            <ArrowLeft className="h-3.5 w-3.5" /> Trang đăng ký
          </Link>
        </div>
        <div className="mx-auto mt-8 max-w-4xl">
          <h1 className="text-[28px] font-black leading-[0.95] md:text-[36px]">Tra cứu trạng thái & bộ phận tiếp nhận Tập nghề</h1>
          <p className="mt-2 max-w-[50ch] text-sm text-white/75">
            Nhập CCCD để biết bạn đã được xếp vào bộ phận nào hôm nay — nếu chưa, HR vẫn đang điều phối.
          </p>
        </div>
      </header>

      <section className="mx-auto -mt-10 max-w-4xl space-y-5 px-4 pb-20">
        <Card className="rounded-[20px] border-0 shadow-[0_16px_40px_rgba(8,50,27,0.14)]">
          <CardContent className="space-y-4 p-6">
            <Label className="text-[12px] font-black uppercase tracking-widest">Số CCCD để tra cứu</Label>
            <Input
              type="tel"
              inputMode="numeric"
              maxLength={12}
              value={cccd}
              onChange={(e) => setCccd(e.target.value.replace(/\D/g, ""))}
              placeholder="Nhập đúng 12 chữ số CCCD"
              className="h-[56px] rounded-[14px] text-[18px] font-black tracking-widest"
            />
            <Label className="text-[12px] font-black uppercase tracking-widest">Số điện thoại đã đăng ký</Label>
            <div className="flex gap-2">
              <Input
                type="tel"
                inputMode="numeric"
                maxLength={11}
                value={phone}
                onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))}
                placeholder="VD: 0901234567"
                className="h-[56px] rounded-[14px] text-[18px] font-black tracking-widest"
                onKeyDown={(e) => e.key === "Enter" && search()}
              />
              <Button onClick={search} loading={loading} variant="gold" size="xl" className="h-[56px] rounded-[14px] px-6 shadow">
                <Search className="h-5 w-5" /> Tra cứu
              </Button>
            </div>
            <p className="flex items-start gap-1.5 text-[11px] text-fg-muted">
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              Cần đúng cả CCCD và số điện thoại đã đăng ký để tra cứu — bảo vệ thông tin cá nhân của bạn khỏi người khác.
            </p>
          </CardContent>
        </Card>

        {notFound && (
          <Card className="rounded-[18px]">
            <CardContent className="flex flex-col items-center gap-2 p-8 text-center">
              <XCircle className="h-8 w-8 text-fg-muted" aria-hidden />
              <p className="font-bold text-fg">Không tìm thấy hồ sơ</p>
              <p className="text-sm text-fg-secondary">Kiểm tra lại số CCCD và số điện thoại đã đăng ký.</p>
            </CardContent>
          </Card>
        )}

        {data && (
          <>
            <div className="grid gap-4 md:grid-cols-3">
              <Card className="rounded-[18px] border-0 bg-[#0F3D23] text-white shadow">
                <CardContent className="p-5">
                  <p className="text-[10px] font-black uppercase tracking-widest text-white/50">Hồ sơ</p>
                  <p className="mt-1 text-xl font-black">{data.worker.fullName}</p>
                  <p className="mt-2">
                    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-black ${data.worker.isVerified ? "bg-emerald-400 text-emerald-950" : "bg-amber-300 text-amber-950"}`}>
                      {data.worker.isVerified && <CheckCircle2 className="h-3 w-3" aria-hidden />}
                      {data.worker.isVerified ? "Đã xác minh" : "Chờ xác nhận người mới"}
                    </span>
                  </p>
                </CardContent>
              </Card>
              <Card className="rounded-[18px]">
                <CardContent className="p-5">
                  <p className="text-[10px] font-black uppercase tracking-widest text-fg-muted">Số lần đăng ký</p>
                  <p className="mt-1 text-3xl font-black text-fg">{data.history.length}</p>
                  <p className="text-xs text-fg-secondary">Lần gần nhất: {formatDate(data.history[0]?.regDate)}</p>
                </CardContent>
              </Card>
              <Card className={`rounded-[18px] border-2 ${todayRow?.status === "APPROVED" ? "border-emerald-400 bg-emerald-50" : "border-amber-300 bg-amber-50"}`}>
                <CardContent className="p-5 text-center">
                  <p className="text-[10px] font-black uppercase tracking-widest text-fg-secondary">Hôm nay {formatDate(today)}</p>
                  {!todayRow ? (
                    <p className="mt-2 font-bold text-fg-secondary">Chưa đăng ký hôm nay</p>
                  ) : todayRow.status === "APPROVED" ? (
                    <>
                      <p className="mt-2 flex items-center justify-center gap-1.5 text-lg font-black text-emerald-800">
                        <CheckCircle2 className="h-5 w-5" aria-hidden /> ĐÃ ĐƯỢC NHẬN!
                      </p>
                      <p className="text-sm font-bold text-emerald-900">
                        Bộ phận: {todayRow.deptName ?? "Chờ HR thông báo"}
                      </p>
                      <p className="mt-1 rounded-lg bg-surface px-2 py-1 text-[11px] font-bold text-emerald-700">
                        Vui lòng có mặt lúc 07h00 sáng mai
                      </p>
                    </>
                  ) : todayRow.status === "REJECTED" ? (
                    <p className="mt-2 flex items-center justify-center gap-1.5 font-black text-red-700">
                      <XCircle className="h-4 w-4" aria-hidden /> Rất tiếc, hôm nay đã đủ chỉ tiêu.
                    </p>
                  ) : (
                    <p className="mt-2 flex items-center justify-center gap-1.5 font-black text-amber-800">
                      <Clock className="h-4 w-4" aria-hidden /> {STATUS_META[todayRow.status]?.label ?? todayRow.status}...
                    </p>
                  )}
                </CardContent>
              </Card>
            </div>

            <Card className="overflow-hidden rounded-[18px] border border-border p-0 shadow-sm">
              <div className="border-b border-border bg-primary-tint px-5 py-3">
                <p className="text-[11px] font-black uppercase tracking-widest text-primary">Lịch sử 20 lần gần nhất</p>
              </div>
              <ul className="divide-y divide-border">
                {data.history.map((h) => (
                  <li key={h.id} className="flex items-center justify-between px-5 py-3">
                    <div>
                      <p className="text-sm font-bold text-fg">{formatDate(h.regDate)}</p>
                      <p className="text-xs text-fg-secondary">{h.deptName ?? "Chưa xếp bộ phận"}</p>
                    </div>
                    <Badge tone={STATUS_META[h.status]?.tone ?? "gray"}>{STATUS_META[h.status]?.label ?? h.status}</Badge>
                  </li>
                ))}
              </ul>
            </Card>
          </>
        )}
      </section>
    </main>
  );
}
