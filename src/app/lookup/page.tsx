"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge, Button, Card, CardContent, Input, Label, toast } from "@/components/ui";
import { BrandLogo } from "@/components/brand-logo";
import { formatDate, STATUS_META, todayStr } from "@/lib/helpers";
import { Loader2 } from "lucide-react";

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

  const search = async () => {
    if (!/^\d{9,12}$/.test(cccd)) {
      toast({ title: "CCCD phải chứa 9 - 12 chữ số", variant: "destructive" });
      return;
    }
    if (!/^0\d{8,10}$/.test(phone)) {
      toast({ title: "Vui lòng nhập đúng số điện thoại đã đăng ký", variant: "destructive" });
      return;
    }
    setLoading(true);
    setData(null);
    try {
      const res = await fetch("/api/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cccd, phone }),
      });
      const json = await res.json();
      if (!res.ok) {
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
    <main className="min-h-screen bg-[#fcfcf7]">
      <div className="border-b border-amber-200/60 bg-gold-50 px-4 py-2 text-center text-[11px] font-bold uppercase tracking-widest text-gold-800">
        Tra cứu trạng thái • Xuất hiện ngay sau khi HR xác nhận là người mới & xếp việc
      </div>

      <header className="hasfarm-hero px-4 pb-16 pt-6 text-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between">
          <BrandLogo light />
          <Link href="/" className="rounded-full border border-white/20 bg-white/10 px-4 py-2 text-xs font-bold backdrop-blur hover:bg-white/15">
            ← Trang đăng ký
          </Link>
        </div>
        <div className="mx-auto mt-8 max-w-4xl">
          <h1 className="text-[28px] font-black leading-[0.95] md:text-[36px]">Tra cứu trạng thái & bộ phận làm việc</h1>
          <p className="mt-2 max-w-[50ch] text-sm text-white/75">
            Nhập CCCD để biết bạn đã được xếp vào xưởng nào hôm nay — nếu chưa, HR vẫn đang điều phối.
          </p>
        </div>
      </header>

      <section className="mx-auto -mt-10 max-w-4xl space-y-5 px-4 pb-20">
        <Card className="rounded-[20px] border-0 shadow-[0_16px_40px_rgba(8,50,27,0.14)]">
          <CardContent className="space-y-4 p-6">
            <Label className="text-[12px] font-black uppercase tracking-widest">Số CCCD / CMND để tra cứu</Label>
            <Input
              type="tel"
              inputMode="numeric"
              maxLength={12}
              value={cccd}
              onChange={(e) => setCccd(e.target.value.replace(/\D/g, ""))}
              placeholder="VD: 0790..."
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
              <Button onClick={search} disabled={loading} variant="gold" size="xl" className="h-[56px] rounded-[14px] px-6 shadow">
                {loading ? <Loader2 className="h-6 w-6 animate-spin" /> : "🔎 Tra cứu"}
              </Button>
            </div>
            <p className="text-[11px] text-gray-400">
              Cần đúng cả CCCD và số điện thoại đã đăng ký để tra cứu — bảo vệ thông tin cá nhân của bạn khỏi người khác.
            </p>
          </CardContent>
        </Card>

        {data && (
          <>
            <div className="grid gap-4 md:grid-cols-3">
              <Card className="rounded-[18px] border-0 bg-[#0F3D23] text-white shadow">
                <CardContent className="p-5">
                  <p className="text-[10px] font-black uppercase tracking-widest text-white/50">Hồ sơ</p>
                  <p className="mt-1 text-xl font-black">{data.worker.fullName}</p>
                  <p className="mt-2">
                    <span className={`rounded-full px-2.5 py-1 text-[11px] font-black ${data.worker.isVerified ? "bg-emerald-400 text-emerald-950" : "bg-amber-300 text-amber-950"}`}>
                      {data.worker.isVerified ? "✅ Đã xác minh" : "Chờ xác nhận người mới"}
                    </span>
                  </p>
                </CardContent>
              </Card>
              <Card className="rounded-[18px]">
                <CardContent className="p-5">
                  <p className="text-[10px] font-black uppercase tracking-widest text-gray-400">Số lần đăng ký</p>
                  <p className="mt-1 text-3xl font-black text-hasfarm-900">{data.history.length}</p>
                  <p className="text-xs text-gray-500">Lần gần nhất: {formatDate(data.history[0]?.regDate)}</p>
                </CardContent>
              </Card>
              <Card className={`rounded-[18px] border-2 ${todayRow?.status === "APPROVED" ? "border-emerald-400 bg-emerald-50" : "border-amber-300 bg-amber-50"}`}>
                <CardContent className="p-5 text-center">
                  <p className="text-[10px] font-black uppercase tracking-widest text-gray-500">Hôm nay {formatDate(today)}</p>
                  {!todayRow ? (
                    <p className="mt-2 font-bold text-gray-700">Chưa đăng ký hôm nay</p>
                  ) : todayRow.status === "APPROVED" ? (
                    <>
                      <p className="mt-2 text-lg font-black text-emerald-800">
                        ✅ ĐÃ ĐƯỢC NHẬN!
                      </p>
                      <p className="text-sm font-bold text-emerald-900">
                        Bộ phận: {todayRow.deptName ?? "Chờ HR thông báo"}
                      </p>
                      <p className="mt-1 rounded-lg bg-white px-2 py-1 text-[11px] font-bold text-emerald-700">
                        Vui lòng có mặt lúc 07h00 sáng mai
                      </p>
                    </>
                  ) : todayRow.status === "REJECTED" ? (
                    <p className="mt-2 font-black text-red-700">❌ Rất tiếc, hôm nay đã đủ chỉ tiêu.</p>
                  ) : (
                    <p className="mt-2 font-black text-amber-800">
                      ⏳ {STATUS_META[todayRow.status]?.label ?? todayRow.status}...
                    </p>
                  )}
                </CardContent>
              </Card>
            </div>

            <Card className="overflow-hidden rounded-[18px] border border-black/5 p-0 shadow-sm">
              <div className="border-b bg-hasfarm-50 px-5 py-3">
                <p className="text-[11px] font-black uppercase tracking-widest text-hasfarm-700">Lịch sử 20 lần gần nhất</p>
              </div>
              <ul className="divide-y">
                {data.history.map((h) => (
                  <li key={h.id} className="flex items-center justify-between px-5 py-3">
                    <div>
                      <p className="text-sm font-bold">{formatDate(h.regDate)}</p>
                      <p className="text-xs text-gray-500">{h.deptName ?? "Chưa xếp bộ phận"}</p>
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
