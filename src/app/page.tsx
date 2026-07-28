import Link from "next/link";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { dailyApplications, departments, dwData, formQuestions } from "@/db/schema";
import ApplicantPortal from "@/components/applicant-portal";
import { BrandLogo } from "@/components/brand-logo";
import { ensureSeed, tablesReady } from "@/lib/seed";
import { formatDate, todayStr } from "@/lib/helpers";
import type { FormQuestion } from "@/db/schema";

export const dynamic = "force-dynamic";

export default async function ApplicantHomePage() {
  let questions: FormQuestion[] = [];
  let todayCount = 0;
  let approvedCount = 0;
  let dwCount = 0;
  let deptCount = 0;

  if (await tablesReady()) {
    await ensureSeed();
    questions = await db
      .select()
      .from(formQuestions)
      .where(
        and(
          eq(formQuestions.isActive, true),
          sql`(${formQuestions.applyFrom} IS NULL OR ${formQuestions.applyFrom} <= ${todayStr()}::date)`,
        ),
      )
      .orderBy(asc(formQuestions.sortOrder));

    const [stat] = await db
      .select({
        total: sql<number>`count(*)::int`,
        approved: sql<number>`count(*) filter (where ${dailyApplications.status} = 'APPROVED')::int`,
      })
      .from(dailyApplications)
      .where(eq(dailyApplications.regDate, todayStr()));
    todayCount = stat?.total ?? 0;
    approvedCount = stat?.approved ?? 0;

    const [w] = await db.select({ c: sql<number>`count(*)::int` }).from(dwData);
    dwCount = w?.c ?? 0;
    const [d] = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(departments)
      .where(eq(departments.isActive, true));
    deptCount = d?.c ?? 0;
  }

  return (
    <main className="min-h-screen bg-[#F8FAFC] text-gray-900">
      <div className="border-b border-amber-200/60 bg-gold-50 px-4 py-2 text-center text-[11px] font-bold uppercase tracking-widest text-gold-800">
        🌱 Thu nhập ~15 tháng lương/năm • Xe đưa đón Đà Lạt → Đạ Ròn & Lâm Hà • BHXH/BHYT đầy đủ
      </div>

      <header className="hasfarm-hero relative overflow-hidden px-4 pb-24 pt-6 text-white">
        {/* Ảnh trang trại hoa thật (từ trang tuyển dụng chính thức Dalat Hasfarm) — lớp phủ gradient
            giữ độ tương phản chữ, ảnh chỉ hiển thị khi tải được (không chặn render nếu lỗi mạng). */}
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.22]"
          style={{
            backgroundImage: "url(https://drive.google.com/thumbnail?id=1nP9OUZNL0eXTsOqCgGPaYHWJQRKKazRV&sz=w1600)",
            backgroundSize: "cover",
            backgroundPosition: "center 65%",
          }}
        />
        <div className="relative">
        <div className="mx-auto flex max-w-6xl items-center justify-between">
          <BrandLogo light size="md" />
          <div className="flex items-center gap-2">
            <Link
              href="/lookup"
              className="hidden rounded-full border border-white/30 bg-white/10 px-4 py-2 text-xs font-bold backdrop-blur hover:bg-white/15 md:block"
            >
              🔎 Tra cứu kết quả
            </Link>
            <Link
              href="/login"
              className="rounded-full bg-white px-4 py-2 text-xs font-black text-hasfarm-800 shadow hover:bg-gold-100"
            >
              Đăng nhập nội bộ
            </Link>
          </div>
        </div>

        <div className="mx-auto grid max-w-6xl gap-10 pt-10 md:grid-cols-[1.15fr_0.85fr] md:pt-14">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3 py-1 ring-1 ring-white/20 backdrop-blur">
              <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-300" />
              <span className="text-[11px] font-bold uppercase tracking-widest text-white/90">
                Đăng ký thông tin tập nghề • Dalat Hasfarm
              </span>
            </div>
            <h1 className="mt-5 text-[32px] font-black leading-[0.95] tracking-[-0.03em] md:text-[50px]">
              Đăng ký làm việc
              <br />
              <span className="bg-gradient-to-r from-gold-200 to-gold-400 bg-clip-text text-transparent">
                bắt buộc có CCCD
              </span>
            </h1>
            <p className="mt-4 max-w-[52ch] text-[15px] leading-relaxed text-white/80">
              Hệ thống thay thế Google Form + Google Sheet: bắt buộc nhập CCCD, tự động đối chiếu{" "}
              <b className="text-gold-200">{dwCount.toLocaleString("vi-VN")} hồ sơ DW Data</b> để biết bạn là lao động cũ hay mới —
              không còn tình trạng &ldquo;quên mang CCCD&rdquo; gây trùng lặp hồ sơ.
            </p>

            <div className="mt-6 flex flex-wrap gap-3">
              <div className="rounded-2xl bg-white/10 px-4 py-3 ring-1 ring-white/20 backdrop-blur">
                <p className="text-[10px] font-bold uppercase tracking-widest text-white/60">
                  Hôm nay {formatDate(todayStr())}
                </p>
                <p className="text-lg font-black">{todayCount} lượt đăng ký</p>
              </div>
              <div className="rounded-2xl bg-gold-500 px-4 py-3 text-hasfarm-900 shadow-[0_8px_24px_rgba(217,163,39,0.35)]">
                <p className="text-[10px] font-bold uppercase tracking-widest opacity-60">Đã xếp việc</p>
                <p className="text-lg font-black">{approvedCount} lao động</p>
              </div>
              <div className="rounded-2xl bg-white px-4 py-3 text-hasfarm-900 shadow">
                <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">Bộ phận</p>
                <p className="text-lg font-black">{deptCount} nhóm</p>
              </div>
            </div>
          </div>

          <div className="hidden md:block">
            <div className="rounded-[28px] bg-white p-3 shadow-[0_24px_64px_rgba(0,0,0,0.28)] ring-1 ring-black/5">
              <div className="rounded-[20px] bg-gradient-to-b from-hasfarm-50 to-white p-5">
                <p className="text-[11px] font-black uppercase tracking-widest text-hasfarm-700">
                  Thay đổi so với Google Form cũ
                </p>
                <ul className="mt-4 space-y-2.5 text-[13px]">
                  {[
                    ["❌", "Bỏ nhánh “KHÔNG mang theo CMND/CCCD”", "79/488 đơn cũ thiếu CCCD gây trùng hồ sơ"],
                    ["✅", "CCCD bắt buộc — chặn ở cả Form & Server", "Không thể nộp đơn nếu thiếu CCCD"],
                    ["🔍", "Đối chiếu tự động với DW Data 3 tầng", "CCCD → Tên+Năm sinh → Tên+SĐT"],
                    ["📋", "Vẫn giữ câu tự khai cũ/mới", "Nhưng hệ thống xác minh lại, không tin 100%"],
                  ].map(([i, a, b]) => (
                    <li key={a} className="flex gap-2 rounded-xl bg-white p-3 shadow-sm ring-1 ring-black/5">
                      <span className="text-base">{i}</span>
                      <span>
                        <b className="block text-hasfarm-900">{a}</b>
                        <span className="text-[11px] text-gray-500">{b}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </div>
        </div>
      </header>

      <section className="mx-auto grid max-w-6xl gap-8 px-4 pb-20 md:-mt-12 md:grid-cols-[1.15fr_0.85fr]">
        <ApplicantPortal questions={questions} />

        <div className="space-y-4">
          <div className="hasfarm-card p-5">
            <p className="text-xs font-black uppercase tracking-widest text-hasfarm-700">
              Quy trình sau khi bạn đăng ký
            </p>
            <ol className="mt-3 space-y-2 text-[13px]">
              {[
                "Đơn vào sheet Daily Application của HR (chỉ hiện hôm nay cho gọn)",
                "HR đối chiếu DW Data → xác nhận bạn là lao động cũ hay mới",
                "HR xếp Bộ phận + Nhóm từ danh sách 71 bộ phận",
                "Bạn tra cứu buổi chiều để biết bộ phận & người phụ trách",
              ].map((s, i) => (
                <li key={s} className="flex gap-2.5 rounded-xl bg-gray-50 p-3">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-hasfarm-700 text-[10px] font-black text-white">
                    {i + 1}
                  </span>
                  <span className="text-gray-700">{s}</span>
                </li>
              ))}
            </ol>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Link
              href="/lookup"
              className="group rounded-[20px] border-2 border-hasfarm-200 bg-white p-5 shadow-sm transition hover:border-hasfarm-600 hover:shadow-md"
            >
              <p className="text-2xl">🔎</p>
              <p className="mt-2 text-sm font-black text-hasfarm-900">Tra cứu trạng thái</p>
              <p className="text-[11px] text-gray-500">Xem bộ phận được xếp</p>
            </Link>
            <a
              href="tel:02633842777"
              className="rounded-[20px] border-2 border-gold-200 bg-gradient-to-b from-gold-50 to-white p-5 shadow-sm transition hover:border-gold-500"
            >
              <p className="text-2xl">☎️</p>
              <p className="mt-2 text-sm font-black text-hasfarm-900">Hỗ trợ nhân sự</p>
              <p className="text-[11px] text-gray-500">0263 3842777 • 7h-17h</p>
            </a>
          </div>

          <p className="text-center text-[10px] font-bold uppercase tracking-widest text-gray-400">
            © {new Date().getFullYear()} Dalat Hasfarm — Seasonal HR System
          </p>
        </div>
      </section>
    </main>
  );
}
