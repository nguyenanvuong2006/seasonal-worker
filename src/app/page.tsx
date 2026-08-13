import Link from "next/link";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { formQuestions } from "@/db/schema";
import ApplicantPortal from "@/components/applicant-portal";
import { BrandLogo } from "@/components/brand-logo";
import { ensureSeed, tablesReady } from "@/lib/seed";
import { todayStr } from "@/lib/helpers";
import type { FormQuestion } from "@/db/schema";
import { Leaf, Phone, Search, ShieldCheck, Sprout } from "lucide-react";

export const dynamic = "force-dynamic";

export default async function ApplicantHomePage() {
  let questions: FormQuestion[] = [];

  if (await tablesReady()) {
    await ensureSeed();
    questions = await db
      .select()
      .from(formQuestions)
      .where(
        and(
          eq(formQuestions.isActive, true),
          eq(formQuestions.visibleToApplicants, true),
          sql`(${formQuestions.applyFrom} IS NULL OR ${formQuestions.applyFrom} <= ${todayStr()}::date)`,
        ),
      )
      .orderBy(asc(formQuestions.sortOrder));
  }

  return (
    <main className="min-h-screen bg-bg text-fg">
      {/* Utility strip */}
      <div className="border-b border-gold-200/60 bg-gold-50 px-4 py-2 text-center text-[11px] font-bold uppercase tracking-widest text-gold-700">
        <Sprout className="mr-1.5 inline h-3.5 w-3.5" aria-hidden />
        Thu nhập ~15 tháng lương/năm • Xe đưa đón Đà Lạt → Đạ Ròn & Lâm Hà • BHXH/BHYT đầy đủ
      </div>

      {/* BRAND HERO — deep-green greenhouse band.
          Official approved hero: public/brand/dalat-hasfarm-chrysanthemum-hero.png
          (PNG — do not convert to JPG). Rendered as a decorative cover background:
          background-size: cover + background-position keep the original aspect ratio
          (never squashed/stretched) while filling the band. When the file is absent
          (asset slot not yet supplied) a missing background renders nothing — the
          deep-green gradient + field-rows texture carry the hero, so there is never
          a broken image. */}
      <header className="hasfarm-hero field-rows relative z-0 overflow-hidden px-4 pb-24 pt-6 text-white md:pb-28">
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.16] mix-blend-screen"
          style={{
            backgroundImage: "url(/brand/dalat-hasfarm-chrysanthemum-hero.png)",
            backgroundSize: "cover",
            backgroundPosition: "center 62%",
            backgroundRepeat: "no-repeat",
          }}
          aria-hidden
        />
        <div className="relative mx-auto max-w-6xl">
          <div className="flex items-center justify-between">
            <BrandLogo light size="lg" />
            <div className="flex items-center gap-2">
              <Link
                href="/lookup"
                className="hidden items-center gap-1.5 rounded-full border border-white/30 bg-white/10 px-4 py-2 text-xs font-bold backdrop-blur transition-colors hover:bg-white/20 md:flex"
              >
                <Search className="h-3.5 w-3.5" /> Tra cứu kết quả
              </Link>
              <Link
                href="/login"
                className="rounded-full bg-white px-4 py-2 text-xs font-black text-primary shadow-[0_8px_20px_rgba(8,41,15,0.35)] transition-colors hover:bg-gold-100"
              >
                Đăng nhập nội bộ
              </Link>
            </div>
          </div>

          <div className="mt-10 max-w-3xl md:mt-14">
            <p className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.22em] text-gold-200">
              <Leaf className="h-3.5 w-3.5" aria-hidden />
              Hệ thống tuyển dụng chính thức Dalat Hasfarm
            </p>
            <h1 className="mt-3 text-[32px] font-black leading-[1.08] tracking-[-0.02em] md:text-[48px]">
              Đăng ký tập nghề
              <span className="relative mt-2 block w-fit">
                cùng mùa hoa
                <span className="absolute -bottom-1 left-0 h-[4px] w-full rounded-full bg-accent shadow-[0_2px_10px_rgba(226,109,28,0.6)]" aria-hidden />
              </span>
            </h1>
            <p className="mt-5 max-w-[54ch] text-[15px] leading-7 text-white/80 md:text-[16px]">
              Điền thông tin một lần, hệ thống tự động nhận diện người tập nghề cũ hay mới
              và đưa hồ sơ đến đúng bộ phận tiếp nhận.
            </p>
          </div>
        </div>
      </header>

      <section className="relative z-10 mx-auto grid max-w-6xl gap-8 px-4 pb-20 md:-mt-16 md:grid-cols-[1.15fr_0.85fr]">
        <ApplicantPortal questions={questions} />

        <div className="space-y-4">
          <div className="petal-arch border border-border bg-surface p-5 shadow-[0_10px_28px_rgba(23,32,18,0.07)]">
            <p className="flex items-center gap-2 text-xs font-black uppercase tracking-widest text-primary">
              <ShieldCheck className="h-4 w-4 text-accent" aria-hidden />
              Quy trình sau khi bạn đăng ký
            </p>
            <ol className="mt-3 space-y-2 text-[13px]">
              {[
                "Đơn vào hệ thống Daily Application của HR tiếp nhận",
                "HR đối chiếu DW Data → xác nhận bạn là người tập nghề cũ hay mới",
                "HR xếp Bộ phận từ cơ cấu tổ chức Location → Division → Department → Section → Group",
                "Bạn tra cứu buổi chiều để biết bộ phận & người phụ trách tiếp nhận",
              ].map((s, i) => (
                <li key={s} className="flex gap-2.5 rounded-xl bg-botanical-50 p-3">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary text-[10px] font-black text-white">
                    {i + 1}
                  </span>
                  <span className="text-fg-secondary">{s}</span>
                </li>
              ))}
            </ol>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Link
              href="/lookup"
              className="group rounded-[18px] border border-primary/15 bg-primary p-5 text-white shadow-[0_10px_24px_rgba(15,68,36,0.25)] transition hover:-translate-y-[1px] hover:bg-primary-hover"
            >
              <Search className="h-6 w-6 text-gold-200" aria-hidden />
              <p className="mt-2 text-sm font-black">Tra cứu trạng thái</p>
              <p className="text-[11px] text-white/70">Xem bộ phận được xếp</p>
            </Link>
            <a
              href="tel:02633842777"
              className="rounded-[18px] border-2 border-accent/25 bg-accent-tint p-5 text-fg shadow-[0_10px_24px_rgba(226,109,28,0.12)] transition hover:-translate-y-[1px] hover:border-accent/50"
            >
              <Phone className="h-6 w-6 text-accent" aria-hidden />
              <p className="mt-2 text-sm font-black">Hỗ trợ nhân sự</p>
              <p className="text-[11px] text-fg-secondary">0263 3842777 • 7h-17h</p>
            </a>
          </div>

          <p className="text-center text-[10px] font-bold uppercase tracking-widest text-fg-muted">
            © {new Date().getFullYear()} Dalat Hasfarm — Seasonal HR System
          </p>
        </div>
      </section>
    </main>
  );
}
