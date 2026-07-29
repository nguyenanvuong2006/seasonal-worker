import Link from "next/link";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { formQuestions } from "@/db/schema";
import ApplicantPortal from "@/components/applicant-portal";
import { BrandLogo } from "@/components/brand-logo";
import { ensureSeed, tablesReady } from "@/lib/seed";
import { todayStr } from "@/lib/helpers";
import type { FormQuestion } from "@/db/schema";

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
          sql`(${formQuestions.applyFrom} IS NULL OR ${formQuestions.applyFrom} <= ${todayStr()}::date)`
        )
      )
      .orderBy(asc(formQuestions.sortOrder));
  }

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900">

      {/* Top Notice */}
      <div className="border-b border-gold-200/40 bg-gradient-to-r from-gold-50 via-white to-gold-50 px-4 py-2 text-center text-[11px] font-bold uppercase tracking-[0.25em] text-gold-800">
        🌱 Thu nhập ổn định • Hỗ trợ cơm trưa • Được hướng dẫn trong thời gian tập nghề
      </div>

      {/* ================= HERO ================= */}

      <header className="hasfarm-hero relative overflow-hidden">

        {/* Background image */}

        <div
          className="absolute inset-0"
          style={{
            backgroundImage:
              "url(https://drive.google.com/thumbnail?id=1nP9OUZNL0eXTsOqCgGPaYHWJQRKKazRV&sz=w1600)",
            backgroundSize: "cover",
            backgroundPosition: "center",
          }}
        />

        {/* Overlay */}

        <div className="absolute inset-0 bg-gradient-to-br from-hasfarm-900/90 via-hasfarm-800/85 to-hasfarm-700/85" />

        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(255,255,255,.18),transparent_40%)]" />

        <div className="relative mx-auto max-w-7xl px-4 pt-8 pb-36">

          {/* Top Navigation */}

          <div className="flex items-start justify-between gap-8">

            {/* Brand */}

            <div className="flex items-center gap-5">

              <div className="rounded-3xl bg-white p-4 shadow-[0_25px_70px_rgba(0,0,0,.35)] ring-1 ring-white/20 transition duration-300 hover:scale-105">

                <BrandLogo
                  light={false}
                  size="xl"
                  withText={false}
                />

              </div>

              <div className="hidden md:block">

                <p className="text-3xl font-black tracking-wide text-white">
                  DALAT HASFARM
                </p>

                <p className="mt-1 text-base font-medium text-white/85">
                  Recruitment & Internship Portal
                </p>

                <div className="mt-2 inline-flex rounded-full border border-gold-300/30 bg-white/10 px-3 py-1 text-xs font-semibold tracking-wide text-gold-100 backdrop-blur">
                  Grow Happiness • Grow Together
                </div>

              </div>

            </div>

            {/* Actions */}

            <div className="flex items-center gap-3">

              <Link
                href="/lookup"
                className="hidden rounded-full border border-white/25 bg-white/10 px-5 py-2.5 text-sm font-bold text-white backdrop-blur transition-all hover:bg-white/20 md:inline-flex"
              >
                🔎 Tra cứu kết quả
              </Link>

              <Link
                href="/login"
                className="inline-flex rounded-full bg-white px-5 py-2.5 text-sm font-black text-hasfarm-800 shadow-xl transition-all hover:-translate-y-0.5 hover:bg-gold-100"
              >
                Đăng nhập nội bộ
              </Link>

            </div>

          </div>

          {/* Hero */}

          <div className="mt-16 max-w-3xl">

            <div className="inline-flex items-center rounded-full border border-gold-300/30 bg-white/10 px-4 py-2 text-xs font-bold uppercase tracking-[0.25em] text-gold-100 backdrop-blur">
              Cổng đăng ký tập nghề
            </div>

            <h1 className="mt-6 text-4xl font-black leading-tight tracking-tight text-white md:text-6xl">

              Đăng ký thông tin

              <span className="block bg-gradient-to-r from-gold-200 via-gold-300 to-gold-400 bg-clip-text text-transparent">
                Tập nghề tại Dalat Hasfarm
              </span>

            </h1>

            <p className="mt-6 max-w-2xl text-lg leading-8 text-white/85">

              Hoàn thành biểu mẫu đăng ký để bộ phận tuyển dụng tiếp nhận,
              xác nhận thông tin và sắp xếp vị trí phù hợp.
              Toàn bộ quy trình được thực hiện trực tuyến, nhanh chóng và minh bạch.

            </p>

            <div className="mt-10 flex flex-wrap gap-4">

              <a
                href="#register"
                className="rounded-full bg-gold-400 px-7 py-3.5 text-sm font-black text-hasfarm-900 shadow-2xl transition hover:-translate-y-1 hover:bg-gold-300"
              >
                Đăng ký ngay
              </a>

              <Link
                href="/lookup"
                className="rounded-full border border-white/30 bg-white/10 px-7 py-3.5 text-sm font-bold text-white backdrop-blur transition hover:bg-white/20"
              >
                Tra cứu hồ sơ
              </Link>

            </div>

            {/* Stats */}

            <div className="mt-12 grid max-w-xl grid-cols-3 gap-4">

              <div className="rounded-2xl border border-white/10 bg-white/10 p-4 backdrop-blur">

                <p className="text-2xl font-black text-gold-300">2 phút</p>

                <p className="mt-1 text-xs uppercase tracking-wider text-white/70">
                  Thời gian đăng ký
                </p>

              </div>

              <div className="rounded-2xl border border-white/10 bg-white/10 p-4 backdrop-blur">

                <p className="text-2xl font-black text-gold-300">100%</p>

                <p className="mt-1 text-xs uppercase tracking-wider text-white/70">
                  Trực tuyến
                </p>

              </div>

              <div className="rounded-2xl border border-white/10 bg-white/10 p-4 backdrop-blur">

                <p className="text-2xl font-black text-gold-300">24/7</p>

                <p className="mt-1 text-xs uppercase tracking-wider text-white/70">
                  Tra cứu kết quả
                </p>

              </div>

            </div>

          </div>

        </div>

      </header>

      <section
  id="register"
  className="relative z-10 mx-auto -mt-24 max-w-7xl px-4 pb-20"
>
  <div className="grid gap-8 lg:grid-cols-[1.2fr_0.8fr]">

    {/* ================= FORM ================= */}

    <div className="rounded-[32px] bg-white p-2 shadow-[0_30px_80px_rgba(15,23,42,.12)] ring-1 ring-slate-200/60">

      <div className="rounded-[28px] bg-gradient-to-r from-hasfarm-700 to-hasfarm-600 px-8 py-6 text-white">

        <p className="text-xs font-bold uppercase tracking-[0.25em] text-gold-200">
          Internship Registration
        </p>

        <h2 className="mt-2 text-3xl font-black">
          Đăng ký thông tin
        </h2>

        <p className="mt-2 max-w-2xl text-sm leading-6 text-white/80">
          Vui lòng điền đầy đủ và chính xác thông tin bên dưới.
          Bộ phận tuyển dụng sẽ tiếp nhận, xác minh và sắp xếp bộ phận phù hợp.
        </p>

      </div>

      <div className="p-6 md:p-8">

        <ApplicantPortal questions={questions} />

      </div>

    </div>

    {/* ================= RIGHT SIDE ================= */}

    <div className="space-y-6">

      {/* Timeline */}

      <div className="rounded-[30px] bg-white p-7 shadow-lg ring-1 ring-slate-200/60">

        <p className="text-xs font-black uppercase tracking-[0.25em] text-hasfarm-700">
          Quy trình tuyển dụng
        </p>

        <div className="mt-8 space-y-5">

          {[
            {
              title: "Đăng ký thông tin",
              desc: "Hoàn thành biểu mẫu trực tuyến.",
            },
            {
              title: "Xác minh hồ sơ",
              desc: "Nhân sự kiểm tra và đối chiếu thông tin.",
            },
            {
              title: "Sắp xếp bộ phận",
              desc: "Phân công người phụ trách và bộ phận phù hợp.",
            },
            {
              title: "Tra cứu kết quả",
              desc: "Xem trạng thái và thông tin tiếp nhận.",
            },
          ].map((item, index) => (
            <div
              key={item.title}
              className="flex gap-4"
            >
              <div className="flex flex-col items-center">

                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-hasfarm-700 text-sm font-black text-white shadow-lg">
                  {index + 1}
                </div>

                {index < 3 && (
                  <div className="mt-2 h-10 w-px bg-slate-200" />
                )}

              </div>

              <div className="pb-4">

                <h3 className="font-bold text-slate-900">
                  {item.title}
                </h3>

                <p className="mt-1 text-sm leading-6 text-slate-500">
                  {item.desc}
                </p>

              </div>

            </div>
          ))}

        </div>

      </div>

      {/* Feature Cards */}

      <div className="grid gap-4">

        <Link
          href="/lookup"
          className="group rounded-[28px] bg-white p-6 shadow-lg ring-1 ring-slate-200 transition-all duration-300 hover:-translate-y-1 hover:ring-hasfarm-500"
        >

          <div className="flex items-center justify-between">

            <div>

              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-hasfarm-50 text-2xl">
                🔎
              </div>

              <h3 className="mt-5 text-lg font-black text-slate-900">
                Tra cứu kết quả
              </h3>

              <p className="mt-2 text-sm leading-6 text-slate-500">
                Kiểm tra bộ phận được phân công và trạng thái hồ sơ.
              </p>

            </div>

            <div className="text-3xl transition group-hover:translate-x-2">
              →
            </div>

          </div>

        </Link>

        <a
          href="tel:02633620295"
          className="group rounded-[28px] bg-gradient-to-br from-gold-50 to-white p-6 shadow-lg ring-1 ring-gold-200 transition-all duration-300 hover:-translate-y-1 hover:ring-gold-400"
        >

          <div className="flex items-center justify-between">

            <div>

              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-gold-100 text-2xl">
                ☎
              </div>

              <h3 className="mt-5 text-lg font-black text-slate-900">
                Hỗ trợ tuyển dụng
              </h3>

              <p className="mt-2 text-sm leading-6 text-slate-500">
                0263 3620295
                <br />
                Thứ Hai - Thứ Bảy
                <br />
                07:00 - 17:00
              </p>

            </div>

            <div className="text-3xl transition group-hover:translate-x-2">
              →
            </div>

          </div>

        </a>

      </div>

      {/* Note */}

      <div className="rounded-[28px] border border-gold-200 bg-gradient-to-r from-gold-50 to-white p-6">

        <p className="text-xs font-black uppercase tracking-[0.25em] text-gold-700">
          Lưu ý
        </p>

        <p className="mt-3 text-sm leading-7 text-slate-600">
          Sau khi gửi thông tin, vui lòng sử dụng chức năng
          <span className="font-bold text-hasfarm-700">
            {" "}Tra cứu kết quả
          </span>
          để theo dõi quá trình tiếp nhận và phân công bộ phận.
        </p>

      </div>

    </div>

  </div>

  {/* Footer */}

  <footer className="mt-16 border-t border-slate-200 pt-8">

    <div className="flex flex-col items-center justify-between gap-4 text-center md:flex-row">

      <div>

        <p className="font-black tracking-wide text-hasfarm-800">
          DALAT HASFARM
        </p>

        <p className="mt-1 text-sm text-slate-500">
          Recruitment & Internship Portal
        </p>

      </div>

      <div className="text-sm text-slate-500">
        © {new Date().getFullYear()} Dalat Hasfarm.
        All Rights Reserved.
      </div>

    </div>

  </footer>

</section>

</main>
);
}
