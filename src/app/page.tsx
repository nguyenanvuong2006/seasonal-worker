import Link from "next/link";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { formQuestions } from "@/db/schema";
import ApplicantPortal from "@/components/applicant-portal";
import { BrandLogo } from "@/components/brand-logo";
import { ensureSeed, tablesReady } from "@/lib/seed";
import { todayStr } from "@/lib/helpers";
import { getPublicBranding } from "@/lib/branding";
import type { FormQuestion } from "@/db/schema";
import { BusFront, Leaf, Phone, Search, ShieldCheck, Sprout } from "lucide-react";

export const dynamic = "force-dynamic";

const PROCESS_STEPS = [
  {
    title: "Tiếp nhận thông tin đăng ký",
    desc: "Hệ thống tiếp nhận và ghi nhận thông tin đăng ký của bạn.",
  },
  {
    title: "Đối chiếu hồ sơ",
    desc: "Thông tin được đối chiếu với hồ sơ đã có (nếu có).",
  },
  {
    title: "Xếp bộ phận phù hợp",
    desc: "Hồ sơ được chuyển đến bộ phận phù hợp với nhu cầu hiện tại.",
  },
  {
    title: "Thông báo kết quả tiếp nhận",
    desc: "Kết quả được thông báo theo thông tin liên hệ bạn đã đăng ký.",
  },
];

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

  const branding = await getPublicBranding();
  const heroImage = branding.yearThemeImage || "/brand/dalat-hasfarm-chrysanthemum-hero.png";

  return (
    <main className="min-h-screen w-full overflow-x-hidden bg-[#f8f4eb] text-fg">
      {/* Benefit strip — warm, compact, and intentionally not a dark banner. */}
      <div className="border-b border-[#eadfcb] bg-[#fffaf0] px-4 py-2.5">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-center gap-x-8 gap-y-2 text-[10px] font-black uppercase tracking-[0.09em] text-[#31583f] sm:text-[11px]">
          <span className="inline-flex items-center gap-1.5"><Sprout className="h-3.5 w-3.5 text-[#f58220]" aria-hidden /> Thu nhập ~15 tháng lương/năm</span>
          <span className="inline-flex items-center gap-1.5"><BusFront className="h-3.5 w-3.5 text-[#f58220]" aria-hidden /> Xe đưa đón Đà Lạt</span>
          <span className="inline-flex items-center gap-1.5"><Leaf className="h-3.5 w-3.5 text-[#f58220]" aria-hidden /> Đạ Ròn &amp; Lâm Hà</span>
          <span className="inline-flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5 text-[#f58220]" aria-hidden /> BHXH/BHYT đầy đủ</span>
        </div>
      </div>

      {/* Candidate-facing hero: bright editorial layout, no gradient and no color wash over people. */}
      <header className="relative overflow-hidden bg-[#fffdf8]">
        <div className="mx-auto grid min-h-[610px] w-full max-w-[1536px] lg:grid-cols-[0.82fr_1.18fr]">
          <div className="relative z-20 flex flex-col px-6 pb-36 pt-7 md:px-10 lg:px-14 lg:pb-44 lg:pt-10">
            <div className="flex items-start justify-between gap-4">
              <BrandLogo size="xl" />
              <div className="flex items-center gap-2 lg:hidden">
                <Link href="/lookup" className="hidden rounded-xl border border-[#dce4dc] bg-white px-3.5 py-2 text-[11px] font-bold text-primary shadow-sm sm:inline-flex">Tra cứu</Link>
                <Link href="/login" className="rounded-xl bg-[#f58220] px-3.5 py-2 text-[11px] font-black text-white shadow-[0_8px_20px_rgba(245,130,32,0.2)]">Đăng nhập</Link>
              </div>
            </div>

            <div className="my-auto max-w-[620px] py-12 lg:py-16">
              <p className="flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.17em] text-[#31583f]">
                <Leaf className="h-4 w-4 text-[#f58220]" aria-hidden /> Hệ thống tuyển dụng chính thức Dalat Hasfarm
              </p>
              <h1 className="mt-5 text-[42px] font-black leading-[1.02] tracking-[-0.045em] text-[#154c2b] md:text-[56px] lg:text-[64px]">
                Đăng ký tập nghề
                <span className="mt-1 block text-[#ef6c00]">cùng Dalat Hasfarm</span>
              </h1>
              <div className="mt-6 h-1.5 w-20 rounded-full bg-[#f58220]" aria-hidden />
              <p className="mt-6 max-w-[48ch] text-[15px] font-medium leading-7 text-[#34483a] md:text-[16px]">
                Điền thông tin một lần, hệ thống tự động nhận diện người tập nghề cũ hay mới và đưa hồ sơ đến đúng bộ phận tiếp nhận.
              </p>
            </div>

            <div className="hidden items-center gap-3 lg:flex">
              <Link href="/lookup" className="inline-flex items-center gap-2 rounded-xl border border-[#d9e2db] bg-white px-5 py-2.5 text-xs font-bold text-primary shadow-sm transition hover:-translate-y-0.5 hover:shadow-md">
                <Search className="h-4 w-4" aria-hidden /> Tra cứu kết quả
              </Link>
              <Link href="/login" className="rounded-xl bg-[#f58220] px-5 py-2.5 text-xs font-black text-white shadow-[0_8px_20px_rgba(245,130,32,0.22)] transition hover:-translate-y-0.5 hover:bg-[#df6f12]">
                Đăng nhập nội bộ
              </Link>
            </div>
          </div>

          <div className="relative min-h-[390px] overflow-hidden bg-[#f4efe5] lg:min-h-[610px] lg:[clip-path:polygon(11%_0,100%_0,100%_100%,0_100%)]">
            {/* Admin-configurable hero. yearThemeImage is already permissioned, audited and size/mime validated. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={heroImage} alt="Người tập nghề tại Dalat Hasfarm" className="absolute inset-0 h-full w-full object-cover object-center" />
            <div className="absolute inset-x-0 bottom-0 h-1.5 bg-[#f58220]" aria-hidden />
          </div>
        </div>
      </header>

      {/* Form + process overlap the hero like the approved concept, while ApplicantPortal keeps all existing business logic. */}
      <section className="relative z-30 mx-auto -mt-28 grid w-full max-w-[1400px] gap-6 px-4 pb-12 md:px-6 lg:grid-cols-[1.12fr_0.88fr] lg:gap-8 lg:pb-16">
        <div className="min-w-0">
          <ApplicantPortal questions={questions} />
        </div>

        <aside className="space-y-4">
          <div className="rounded-[26px] border border-[#e7dece] bg-[#fffdf9] p-6 shadow-[0_18px_45px_rgba(35,55,38,0.10)] md:p-7">
            <p className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.12em] text-[#174f2b]">
              <ShieldCheck className="h-4 w-4 text-[#f58220]" aria-hidden /> Quy trình sau khi bạn đăng ký
            </p>
            <ol className="mt-5 space-y-0">
              {PROCESS_STEPS.map((step, i) => (
                <li key={step.title} className="relative flex gap-4 pb-5 last:pb-0">
                  {i < PROCESS_STEPS.length - 1 ? <span className="absolute left-[15px] top-8 h-[calc(100%-18px)] w-px bg-[#f2a25f]" aria-hidden /> : null}
                  <span className="relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#174f2b] text-[11px] font-black text-white">{i + 1}</span>
                  <div className="pt-0.5">
                    <p className="text-[13px] font-black text-[#174f2b]">{step.title}</p>
                    <p className="mt-1 text-[11.5px] leading-5 text-fg-secondary">{step.desc}</p>
                  </div>
                </li>
              ))}
            </ol>

            <a href="tel:+842633620295" className="mt-6 flex items-center gap-3 rounded-[16px] border border-[#efd7bd] bg-[#fff8ef] p-4 transition hover:border-[#f58220]/50">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-white text-[#174f2b] shadow-sm"><Phone className="h-5 w-5" aria-hidden /></span>
              <span>
                <span className="block text-[12px] font-black text-[#174f2b]">Hỗ trợ nhân sự</span>
                <span className="mt-0.5 block text-[12px] font-black text-[#ef6c00]">0263 3620295</span>
              </span>
            </a>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
            <Link href="/lookup" className="rounded-[18px] border border-[#dfe8df] bg-white p-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md">
              <Search className="h-5 w-5 text-[#174f2b]" aria-hidden />
              <p className="mt-2 text-[12px] font-black text-[#174f2b]">Tra cứu trạng thái</p>
              <p className="mt-1 text-[10.5px] text-fg-secondary">Xem kết quả tiếp nhận</p>
            </Link>
            <div className="rounded-[18px] border border-[#f3dfca] bg-[#fff9f1] p-4 shadow-sm">
              <ShieldCheck className="h-5 w-5 text-[#f58220]" aria-hidden />
              <p className="mt-2 text-[12px] font-black text-[#174f2b]">Thông tin được bảo mật</p>
              <p className="mt-1 text-[10.5px] text-fg-secondary">Chỉ phục vụ quy trình tuyển dụng</p>
            </div>
          </div>
        </aside>
      </section>

      <footer className="border-t border-[#e9e0d2] bg-[#fffdf8] px-4 py-5 text-center text-[10px] font-bold uppercase tracking-[0.12em] text-fg-muted">
        © {new Date().getFullYear()} Dalat Hasfarm — Seasonal Internship
      </footer>
    </main>
  );
}
