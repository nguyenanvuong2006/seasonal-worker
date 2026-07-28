"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button, Card, CardContent, Input, Label, toast } from "@/components/ui";
import { BrandLogo } from "@/components/brand-logo";
import { Loader2, ShieldCheck } from "lucide-react";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast({ title: data.error ?? "Đăng nhập thất bại", variant: "destructive" });
        return;
      }
      toast({ title: `Chào mừng ${data.role} — đăng nhập thành công!` });
      router.push(data.redirect);
      router.refresh();
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="relative flex min-h-screen items-center justify-center bg-[#f6f5ee] p-4">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(900px_500px_at_20%_-10%,rgba(217,163,39,0.18),transparent),radial-gradient(800px_500px_at_90%_0%,rgba(17,88,48,0.16),transparent)]" />
      <div className="relative w-full max-w-[980px] overflow-hidden rounded-[28px] border bg-white shadow-[0_24px_80px_rgba(8,50,27,0.18)] md:grid md:grid-cols-[1.1fr_0.9fr]">
        <div className="hasfarm-hero relative flex flex-col justify-between p-8 text-white md:p-10">
          <BrandLogo light size="lg" />
          <div className="mt-10">
            <div className="inline-flex rounded-full bg-white/10 px-3 py-1 text-[10px] font-black uppercase tracking-widest ring-1 ring-white/20">
              Dalat Hasfarm • Seasonal HR V3
            </div>
            <h1 className="mt-4 text-[30px] font-black leading-[0.95] md:text-[36px]">
              Hệ thống
              <br />
              điều phối lao động
              <br />
              <span className="text-gold-300">thời vụ</span>
            </h1>
            <p className="mt-4 max-w-[34ch] text-sm leading-relaxed text-white/75">
              Phân quyền theo vai trò: Quản trị viên • HR tuyển dụng • Quản đốc bộ phận nhận lao động. Mỗi vai trò thấy
              đúng phần việc của mình — dữ liệu inline edit như Google Sheet, export Excel 1 chạm.
            </p>

            <div className="mt-8 grid grid-cols-1 gap-3">
              {[
                { role: "Quản trị viên", desc: "Phân quyền RBAC, quota xưởng, câu hỏi động, audit log" },
                { role: "HR Tuyển dụng", desc: "Tick chọn hàng trăm người mới → Import 1 lần, sửa sai CCCD, gộp hồ sơ" },
                { role: "Bộ phận nhận LĐ", desc: "Xem danh sách hôm nay, xuất Excel gửi Zalo/Email" },
                { role: "Người xin việc", desc: "Đăng ký 30s, auto-fill nếu đã có CCCD, tra cứu xưởng chiều" },
              ].map((r) => (
                <div key={r.role} className="flex gap-3 rounded-2xl bg-white/10 p-3 ring-1 ring-white/10 backdrop-blur">
                  <div className="mt-0.5 flex h-6 w-6 items-center justify-center rounded-full bg-gold-400 text-[11px] font-black text-hasfarm-900">
                    ✓
                  </div>
                  <div>
                    <p className="text-[13px] font-black">{r.role}</p>
                    <p className="text-[11px] text-white/70">{r.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <p className="mt-10 text-[10px] font-bold uppercase tracking-[0.2em] text-white/40">
            EST. 1994 • DA LAT — NETHERLANDS — JAPAN
          </p>
        </div>

        <div className="p-7 md:p-8">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-hasfarm-700" />
            <h2 className="text-lg font-black text-hasfarm-900">Cổng nội bộ</h2>
          </div>
          <p className="mt-1 text-sm text-gray-500">Đăng nhập để vào không gian làm việc dành riêng cho vai trò của bạn.</p>

          <form onSubmit={submit} className="mt-6 space-y-4">
            <div>
              <Label>Tên tài khoản</Label>
              <Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="admin" className="h-[50px] rounded-xl font-mono" autoCapitalize="none" />
            </div>
            <div>
              <Label>Mật khẩu</Label>
              <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" className="h-[50px] rounded-xl" />
            </div>
            <Button type="submit" disabled={loading} variant="gold" size="xl" className="w-full rounded-xl shadow-[0_8px_20px_rgba(217,163,39,0.35)]">
              {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : "Đăng Nhập →"}
            </Button>
          </form>

          <div className="mt-6 rounded-2xl border border-dashed border-gold-300 bg-gold-50 p-4">
            <p className="text-xs font-black uppercase tracking-widest text-gold-800">Tài khoản demo phân quyền</p>
            <div className="mt-2 space-y-1.5 text-[12px] leading-relaxed text-gold-900">
              <p className="rounded-lg bg-white px-3 py-2 ring-1 ring-gold-200">
                <b>admin / admin123</b> — Quản trị viên: toàn quyền, phân quyền RBAC, quota, audit
              </p>
              <p className="rounded-lg bg-white px-3 py-2 ring-1 ring-gold-200">
                <b>hr / hr123</b> — Nhân sự tuyển dụng: điều phối, xác nhận người mới, sửa lỗi CCCD, gộp hồ sơ
              </p>
              <p className="rounded-lg bg-white px-3 py-2 ring-1 ring-gold-200">
                <b>xuonga / xuonga123</b> — Quản đốc Xưởng A: xem danh sách hôm nay & xuất Excel
              </p>
            </div>
          </div>

          <Link href="/" className="mt-6 block text-center text-xs font-bold text-hasfarm-700 hover:underline">
            ← Về cổng đăng ký lao động thời vụ (public)
          </Link>
        </div>
      </div>
    </main>
  );
}
