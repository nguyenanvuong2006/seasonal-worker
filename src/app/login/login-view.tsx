"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button, FormField, Input, toast } from "@/components/ui";
import { BrandLogo } from "@/components/brand-logo";
import { ArrowLeft } from "lucide-react";
import type { PublicBranding } from "@/lib/branding";

export function LoginView({ branding }: { branding: PublicBranding }) {
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
      toast({ title: "Đăng nhập thành công!" });
      router.push(data.redirect);
      router.refresh();
    } finally {
      setLoading(false);
    }
  };

  const hasTheme = Boolean(branding.yearThemeImage || branding.yearSlogan);

  return (
    <main className="relative flex min-h-screen items-center justify-center bg-bg p-4">
      <div className="animate-fade-in-scale relative w-full max-w-[960px] overflow-hidden rounded-[24px] border border-border bg-surface shadow-[0_24px_70px_rgba(28,36,24,0.10)] md:grid md:grid-cols-[1.1fr_0.9fr]">
        <div className="relative hidden flex-col justify-between bg-[#0b4527] p-10 text-white md:flex">
          <BrandLogo light size="lg" />

          <div className="mt-10">
            <h1 className="text-[30px] font-black leading-[1.1] md:text-[34px]">
              Hệ thống quản lý
              <br />
              lao động <span className="text-gold-300">thời vụ</span>
            </h1>
            <p className="mt-4 max-w-[38ch] text-sm leading-relaxed text-white/78">
              Quản lý thông tin lao động, kế hoạch nhân lực và các nghiệp vụ liên quan trên một nền tảng thống nhất.
            </p>
          </div>

          {hasTheme ? (
            <div className="mt-10 space-y-3">
              {branding.yearThemeImage ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={branding.yearThemeImage}
                  alt=""
                  className="h-16 w-auto max-w-[220px] object-contain opacity-90"
                />
              ) : null}
              {branding.yearSlogan ? (
                <p className="max-w-[34ch] text-[15px] font-extrabold leading-snug tracking-[-0.01em] text-white">
                  {branding.yearSlogan}
                </p>
              ) : null}
              {branding.themeSubtitle ? <p className="text-[11px] text-white/60">{branding.themeSubtitle}</p> : null}
            </div>
          ) : (
            <p className="mt-10 text-[10px] font-semibold uppercase tracking-[0.2em] text-white/45">
              Seasonal Internship • Dalat Hasfarm
            </p>
          )}
        </div>

        <div className="p-7 md:p-9">
          <div className="mb-1 flex justify-center md:hidden">
            <BrandLogo size="md" />
          </div>
          <h2 className="text-center text-xl font-bold text-fg md:text-left">Đăng nhập</h2>
          <p className="mt-1.5 text-center text-sm text-fg-secondary md:text-left">
            Nhập tên tài khoản và mật khẩu để vào hệ thống.
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
