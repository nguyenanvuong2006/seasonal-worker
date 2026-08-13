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
      {/* Benefit strip */}
      <div className="border-b border-[#eadfcb] bg-[#fffaf0] px-3 py-2 sm:px-4 sm:py-2.5">
        <div className="mx-auto flex max-w-[1440px] items-center gap-5 overflow-x-auto whitespace-nowrap text-[8.5px] font-black uppercase tracking-[0.07em] text-[#31583f] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:justify-center sm:gap-8 sm:text-[11px]">
          <span className="inline-flex shrink-0 items-center gap-1.5"><Sprout className="h-3 w-3 text-[#f58220] sm:h-3.5 sm:w-3.5" aria-hidden /> Thu nhập ~15 tháng lương/năm</span>
          <span className="inline-flex shrink-0 items-center gap-1.5"><BusFront className="h-3 w-3 text-[#f58220] sm:h-3.5 sm:w-3.5" aria-hidden /> Xe đưa đón Đà Lạt</span>
          <span className="inline-flex shrink-0 items-center gap-1.5"><Leaf className="h-3 w-3 text-[#f58220] sm:h-3.5 sm:w-3.5" aria-hidden /> Đạ Ròn &amp; Lâm Hà</span>
          <span className="inline-flex shrink-0 items-center gap-1.5"><ShieldCheck className="h-3 w-3 text-[#f58220] sm:h-3.5 sm:w-3.5" aria-hidden /> BHXH/BHYT đầy đủ</span>
        </div>
      </div>

      {/* MOBILE/TABLET HERO — composition riêng, không dùng desktop grid để tránh khoảng trắng chết. */}
      <header className="bg-[#fffdf8] lg:hidden">
        <div className="mx-auto w-full max-w-3xl px-4 pb-5 pt-4 sm:px-6 sm:pt-6">
          <div className="flex items-center justify-between gap-3">
            <BrandLogo size="lg" />
            <div className="flex shrink-0 items-center gap-2">
              <Link href="/lookup" className="rounded-xl border border-[#dce4dc] bg-white px-3 py-2 text-[10px] font-bold text-[#174f2b] shadow-sm sm:px-3.5 sm:text-[11px]">Tra cứu</Link>
              <Link href="/login" className="rounded-xl bg-[#f58220] px-3 py-2 text-[10px] font-black text-white shadow-[0_7px_18px_rgba(245,130,32,0.20)] sm:px-3.5 sm:text-[11px]">Đăng nhập</Link>
            </div>
          </div>

          <div className="pt-8 sm:pt-10">
            <p className="flex items-center gap-1.5 text-[9px] font-black uppercase tracking-[0.14em] text-[#31583f] sm:text-[10px]">
              <Leaf className="h-3.5 w-3.5 text-[#f58220]" aria-hidden /> Hệ thống tuyển dụng chính thức Dalat Hasfarm
            </p>
            <h1 className="mt-3 max-w-[620px] text-[36px] font-black leading-[0.98] tracking-[-0.045em] text-[#154c2b] min-[430px]:text-[40px] sm:text-[48px]">
              Đăng ký tập nghề
              <span className="mt-1 block text-[#ef6c00]">cùng Dalat Hasfarm</span>
            </h1>
            <div className="mt-4 h-1 w-16 rounded-full bg-[#f58220]" aria-hidden />
            <p className="mt-4 max-w-[52ch] text-[12.5px] font-medium leading-6 text-[#34483a] sm:text-[14px]">
              Điền thông tin một lần, hệ thống tự động nhận diện người tập nghề cũ hay mới và đưa hồ sơ đến đúng bộ phận tiếp nhận.
            </p>
          </div>

          {/* Ảnh nằm ngay trong hero mobile, tỷ lệ thấp/gọn, không còn khối ảnh tách rời sau khoảng trắng lớn. */}
          <div className="relative mt-6 aspect-[16/10] overflow-hidden rounded-[24px] border border-[#eee3d3] bg-[#f4efe5] shadow-[0_14px_35px_rgba(38,56,39,0.10)] sm:aspect-[16/9]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={heroImage} alt="Người tập nghề tại Dalat Hasfarm" className="h-full w-full object-cover object-center" />
            <div className="absolute inset-x-0 bottom-0 h-1 bg-[#f58220]" aria-hidden />
          </div>
        </div>
      </header>

      {/* DESKTOP HERO — giữ composition editorial 2 cột đã duyệt. */}
      <header className="relative hidden overflow-hidden bg-[#fffdf8] lg:block">
        <div className="mx-auto grid min-h-[610px] w-full max-w-[1536px] grid-cols-[0.82fr_1.18fr]">
          <div className="relative z-20 flex flex-col px-14 pb-44 pt-10">
            <BrandLogo size="xl" />

            <div className="my-auto max-w-[620px] py-16">
              <p className="flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.17em] text-[#31583f]">
                <Leaf className="h-4 w-4 text-[#f58220]" aria-hidden /> Hệ thống tuyển dụng chính thức Dalat Hasfarm
              </p>
              <h1 className="mt-5 text-[64px] font-black leading-[1.02] tracking-[-0.045em] text-[#154c2b]">
                Đăng ký tập nghề
                <span className="mt-1 block text-[#ef6c00]">cùng Dalat Hasfarm</span>
              </h1>
              <div className="mt-6 h-1.5 w-20 rounded-full bg-[#f58220]" aria-hidden />
              <p className="mt-6 max-w-[48ch] text-[16px] font-medium leading-7 text-[#34483a]">
                Điền thông tin một lần, hệ thống tự động nhận diện người tập nghề cũ hay mới và đưa hồ sơ đến đúng bộ phận tiếp nhận.
              </p>
            </div>

            <div className="flex items-center gap-3">
              <Link href="/lookup" className="inline-flex items-center gap-2 rounded-xl border border-[#d9e2db] bg-white px-5 py-2.5 text-xs font-bold text-primary shadow-sm transition hover:-translate-y-0.5 hover:shadow-md">
                <Search className="h-4 w-4" aria-hidden /> Tra cứu kết quả
              </Link>
              <Link href="/login" className="rounded-xl bg-[#f58220] px-5 py-2.5 text-xs font-black text-white shadow-[0_8px_20px_rgba(245,130,32,0.22)] transition hover:-translate-y-0.5 hover:bg-[#df6f12]">
                Đăng nhập nội bộ
              </Link>
            </div>
          </div>

          <div className="relative min-h-[610px] overflow-hidden bg-[#f4efe5] [clip-path:polygon(11%_0,100%_0,100%_100%,0_100%)]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={heroImage} alt="Người tập nghề tại Dalat Hasfarm" className="absolute inset-0 h-full w-full object-cover object-center" />
            <div className="absolute inset-x-0 bottom-0 h-1.5 bg-[#f58220]" aria-hidden />
          </div>
        </div>
      </header>

      {/* Mobile/tablet: form nối ngay sau hero. Desktop: overlap đúng concept. */}
      <section className="relative z-30 mx-auto grid w-full max-w-[1400px] gap-5 px-3 pb-10 pt-1 sm:px-5 sm:pt-3 md:px-6 lg:-mt-28 lg:grid-cols-[1.12fr_0.88fr] lg:gap-8 lg:px-6 lg:pb-16 lg:pt-0">
        <div className="min-w-0">
          <ApplicantPortal questions={questions} />
        </div>

        <aside className="space-y-4">
          <div className="rounded-[22px] border border-[#e7dece] bg-[#fffdf9] p-5 shadow-[0_14px_36px_rgba(35,55,38,0.08)] sm:rounded-[26px] sm:p-6 md:p-7">
            <p className="flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.10em] text-[#174f2b] sm:text-xs">
              <ShieldCheck className="h-4 w-4 text-[#f58220]" aria-hidden /> Quy trình sau khi bạn đăng ký
            </p>
            <ol className="mt-4 space-y-0 sm:mt-5">
              {PROCESS_STEPS.map((step, i) => (
                <li key={step.title} className="relative flex gap-3 pb-4 last:pb-0 sm:gap-4 sm:pb-5">
                  {i < PROCESS_STEPS.length - 1 ? <span className="absolute left-[13px] top-7 h-[calc(100%-14px)] w-px bg-[#f2a25f] sm:left-[15px] sm:top-8 sm:h-[calc(100%-18px)]" aria-hidden /> : null}
                  <span className="relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#174f2b] text-[10px] font-black text-white sm:h-8 sm:w-8 sm:text-[11px]">{i + 1}</span>
                  <div className="pt-0.5">
                    <p className="text-[12px] font-black text-[#174f2b] sm:text-[13px]">{step.title}</p>
                    <p className="mt-0.5 text-[11px] leading-5 text-fg-secondary sm:mt-1 sm:text-[11.5px]">{step.desc}</p>
                  </div>
                </li>
              ))}
            </ol>

            <a href="tel:+842633620295" className="mt-5 flex items-center gap-3 rounded-[15px] border border-[#efd7bd] bg-[#fff8ef] p-3.5 transition hover:border-[#f58220]/50 sm:mt-6 sm:rounded-[16px] sm:p-4">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-[#174f2b] shadow-sm sm:h-10 sm:w-10"><Phone className="h-5 w-5" aria-hidden /></span>
              <span>
                <span className="block text-[11.5px] font-black text-[#174f2b] sm:text-[12px]">Hỗ trợ nhân sự</span>
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
