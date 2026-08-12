"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button, FormField, Input, toast } from "@/components/ui";
import { BrandLogo } from "@/components/brand-logo";
import { ArrowLeft, Loader2, ShieldCheck } from "lucide-react";

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
    <main className="relative flex min-h-screen items-center justify-center bg-bg p-4">
      <div className="animate-fade-in-scale relative w-full max-w-[960px] overflow-hidden rounded-[20px] border border-border bg-surface shadow-[0_20px_60px_rgba(8,50,27,0.12)] md:grid md:grid-cols-[1.1fr_0.9fr]">
        <div className="hasfarm-hero relative hidden flex-col justify-between p-10 text-white md:flex">
          <BrandLogo light size="lg" />
          <div className="mt-10">
            <div className="inline-flex rounded-full bg-white/10 px-3 py-1 text-[10px] font-bold uppercase tracking-widest ring-1 ring-white/20">
              Dalat Hasfarm • Seasonal HR
            </div>
            <h1 className="mt-4 text-[30px] font-black leading-[1.1] md:text-[34px]">
              Hệ thống điều phối
              <br />
              lao động <span className="text-gold-300">thời vụ</span>
            </h1>
            <p className="mt-4 max-w-[36ch] text-sm leading-relaxed text-white/75">
              Phân quyền theo vai trò — Quản trị viên, HR tuyển dụng, Quản đốc bộ phận. Mỗi vai trò chỉ thấy đúng phần
              việc của mình.
            </p>

            <div className="mt-8 grid grid-cols-1 gap-2.5">
              {[
                { role: "Quản trị viên", desc: "Phân quyền RBAC, quota xưởng, câu hỏi động, audit log" },
                { role: "HR tuyển dụng", desc: "Xử lý đăng ký, xếp lao động, xuất dữ liệu, quản lý hồ sơ" },
                { role: "Quản đốc bộ phận", desc: "Theo dõi lao động được nhận, xuất danh sách theo ngày" },
              ].map((r) => (
                <div key={r.role} className="flex items-start gap-3 rounded-xl bg-white/[0.06] p-3 ring-1 ring-white/10">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-gold-300" />
                  <div>
                    <p className="text-[13px] font-semibold">{r.role}</p>
                    <p className="text-[11px] text-white/65">{r.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <p className="mt-10 text-[10px] font-semibold uppercase tracking-[0.2em] text-white/40">
            EST. 1994 • DA LAT — NETHERLANDS — JAPAN
          </p>
        </div>

        <div className="p-7 md:p-9">
          <div className="mb-1 flex justify-center md:hidden">
            <BrandLogo size="md" />
          </div>
          <h2 className="text-center text-xl font-bold text-fg md:text-left">Đăng nhập</h2>
          <p className="mt-1.5 text-center text-sm text-fg-secondary md:text-left">
            Vào không gian làm việc dành riêng cho vai trò của bạn.
          </p>

          <form onSubmit={submit} className="mt-6 space-y-4">
            <FormField label="Tên tài khoản" required>
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Nhập tên tài khoản"
                autoComplete="username"
                autoCapitalize="none"
                autoFocus
                required
              />
            </FormField>
            <FormField label="Mật khẩu" required>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
                required
              />
            </FormField>
            <Button type="submit" loading={loading} variant="primary" size="xl" className="w-full">
              {loading ? "Đang đăng nhập…" : "Đăng nhập"}
            </Button>
          </form>

          <Link
            href="/"
            className="mt-6 flex items-center justify-center gap-1.5 text-xs font-semibold text-fg-secondary hover:text-primary md:justify-start"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Về cổng đăng ký lao động thời vụ
          </Link>
        </div>
      </div>
    </main>
  );
}
