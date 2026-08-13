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
    questions = await db.select().from(formQuestions).where(and(eq(formQuestions.isActive, true), eq(formQuestions.visibleToApplicants, true), sql`(${formQuestions.applyFrom} IS NULL OR ${formQuestions.applyFrom} <= ${todayStr()}::date)`)).orderBy(asc(formQuestions.sortOrder));
  }

  return (
    <main className="min-h-screen w-full overflow-x-hidden bg-[#f7f3e9] text-fg">
      <div className="border-b border-[#eadfc8] bg-[#fff9eb] px-4 py-2.5 text-center text-[11px] font-bold uppercase tracking-widest text-[#8a5414]">
        <Sprout className="mr-1.5 inline h-3.5 w-3.5" aria-hidden />
        Thu nhập ~15 tháng lương/năm • Xe đưa đón Đà Lạt → Đạ Ròn & Lâm Hà • BHXH/BHYT đầy đủ
      </div>

      <header className="relative w-full bg-white">
        <div className="mx-auto grid min-h-[560px] w-full max-w-[1600px] lg:grid-cols-[0.82fr_1.18fr]">
          <div className="relative z-10 flex flex-col justify-between bg-[#174f2b] px-6 py-7 text-white md:px-10 lg:px-14 lg:py-10">
            <div className="flex items-start justify-between gap-4 lg:block">
              <BrandLogo light size="xl" />
              <div className="flex items-center gap-2 lg:hidden">
                <Link href="/lookup" className="hidden rounded-full border border-white/35 px-4 py-2 text-xs font-bold sm:block">Tra cứu</Link>
                <Link href="/login" className="rounded-full bg-white px-4 py-2 text-xs font-black text-primary shadow-lg">Đăng nhập</Link>
              </div>
            </div>

            <div className="my-12 max-w-[600px] lg:my-16">
              <p className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.22em] text-[#ffd16b]">
                <Leaf className="h-4 w-4" aria-hidden /> Hệ thống tuyển dụng chính thức Dalat Hasfarm
              </p>
              <h1 className="mt-5 text-[38px] font-black leading-[1.04] tracking-[-0.035em] md:text-[54px] lg:text-[62px]">
                Đăng ký Tập nghề
                <span className="mt-2 block text-[#ffd16b]">cùng mùa hoa</span>
              </h1>
              <div className="mt-6 h-1.5 w-24 rounded-full bg-[#f58220]" aria-hidden />
              <p className="mt-6 max-w-[50ch] text-[15px] leading-7 text-white/82 md:text-[17px]">
                Điền thông tin một lần, hệ thống tự động nhận diện người tập nghề cũ hay mới và đưa hồ sơ đến đúng bộ phận tiếp nhận.
              </p>
            </div>

            <div className="hidden items-center gap-3 lg:flex">
              <Link href="/lookup" className="flex items-center gap-2 rounded-full border border-white/35 px-5 py-2.5 text-xs font-bold transition hover:bg-white/10"><Search className="h-4 w-4" /> Tra cứu kết quả</Link>
              <Link href="/login" className="rounded-full bg-white px-5 py-2.5 text-xs font-black text-primary shadow-lg transition hover:-translate-y-0.5">Đăng nhập nội bộ</Link>
            </div>
          </div>

          <div className="relative min-h-[360px] overflow-hidden bg-[#f1ede3] lg:min-h-[560px]">
            <div className="absolute inset-0 bg-[url('/brand/dalat-hasfarm-chrysanthemum-hero.png')] bg-cover bg-center" aria-hidden />
            <div className="absolute bottom-0 left-0 right-0 h-2 bg-[#f58220]" aria-hidden />
          </div>
        </div>
      </header>

      <section className="mx-auto grid w-full max-w-[1400px] gap-8 px-4 py-10 md:px-6 lg:grid-cols-[1.15fr_0.85fr] lg:py-14">
        <ApplicantPortal questions={questions} />
        <div className="space-y-5">
          <div className="rounded-[28px] border border-[#e5ddcf] bg-white p-6 shadow-[0_16px_42px_rgba(36,55,38,0.08)]">
            <p className="flex items-center gap-2 text-xs font-black uppercase tracking-widest text-primary"><ShieldCheck className="h-4 w-4 text-accent" aria-hidden /> Quy trình sau khi bạn đăng ký</p>
            <ol className="mt-5 space-y-1">
              {["Tiếp nhận thông tin đăng ký", "Đối chiếu hồ sơ", "Xếp bộ phận phù hợp", "Thông báo kết quả tiếp nhận"].map((s, i) => (
                <li key={s} className="relative flex gap-4 py-3">
                  {i < 3 ? <span className="absolute left-[15px] top-10 h-[24px] w-px bg-[#d8e5da]" aria-hidden /> : null}
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#174f2b] text-[11px] font-black text-white">{String(i + 1).padStart(2, "0")}</span>
                  <div><p className="text-sm font-bold text-fg">{s}</p><p className="mt-1 text-xs leading-5 text-fg-secondary">{i === 0 ? "Thông tin được ghi nhận ngay trên hệ thống." : i === 1 ? "Đối chiếu dữ liệu để xác định hồ sơ cũ hoặc mới." : i === 2 ? "Sắp xếp theo nhu cầu tuyển dụng thực tế." : "Theo dõi kết quả tiếp nhận nhanh chóng."}</p></div>
                </li>
              ))}
            </ol>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Link href="/lookup" className="rounded-[22px] bg-[#174f2b] p-5 text-white shadow-[0_12px_30px_rgba(23,79,43,0.22)] transition hover:-translate-y-0.5"><Search className="h-6 w-6 text-[#ffd16b]" aria-hidden /><p className="mt-3 text-sm font-black">Tra cứu trạng thái</p><p className="mt-1 text-[11px] text-white/70">Xem kết quả tiếp nhận</p></Link>
            <a href="tel:+842633620295" className="rounded-[22px] border border-[#f4c49e] bg-[#fff7ef] p-5 shadow-[0_12px_30px_rgba(226,109,28,0.09)] transition hover:-translate-y-0.5"><Phone className="h-6 w-6 text-[#e66b13]" aria-hidden /><p className="mt-3 text-sm font-black">Hỗ trợ nhân sự</p><p className="mt-1 text-[11px] text-fg-secondary">0263 3620295 • 7h–17h</p></a>
          </div>
          <p className="text-center text-[10px] font-bold uppercase tracking-widest text-fg-muted">© {new Date().getFullYear()} Dalat Hasfarm — Seasonal Internship</p>
        </div>
      </section>
    </main>
  );
}
