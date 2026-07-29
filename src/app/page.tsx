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
          sql`(${formQuestions.applyFrom} IS NULL OR ${formQuestions.applyFrom} <= ${todayStr()}::date)`,
        ),
      )
      .orderBy(asc(formQuestions.sortOrder));
  }

  return (
    <main className="min-h-screen bg-[#F8FAFC] text-gray-900">
      <div className="border-b border-amber-200/60 bg-gold-50 px-4 py-2 text-center text-[11px] font-bold uppercase tracking-widest text-gold-800">
        🌱 Thu nhập cao • Được hỗ trợ cơm trưa • Được hướng dẫn khi làm việc
      </div>

      <header className="hasfarm-hero relative z-0 overflow-hidden px-4 pb-28 pt-6 text-white">
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
          <BrandLogo light size="xl" withText={false} />
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

        <div className="mx-auto max-w-6xl pt-10 md:pt-14">
          <h1 className="text-[30px] font-black leading-tight tracking-[-0.02em] md:text-[46px]">
            <span className="bg-gradient-to-r from-gold-200 to-gold-400 bg-clip-text text-transparent">
              Đăng ký thông tin tập nghề
            </span>
          </h1>
        </div>
        </div>
      </header>

      <section className="relative z-10 mx-auto grid max-w-6xl gap-8 px-4 pb-20 md:-mt-24 md:grid-cols-[1.15fr_0.85fr]">
        <ApplicantPortal questions={questions} />

        <div className="space-y-4">
          <div className="hasfarm-card p-5">
            <p className="text-xs font-black uppercase tracking-widest text-hasfarm-700">
              Quy trình sau khi Anh/Chị/Em đăng ký
            </p>
            <ol className="mt-3 space-y-2 text-[13px]">
              {[
                "Thông tin được gửi đến hệ thống tuyển dụng",
                "Đội ngũ tuyển dụng đối chiếu → xác nhận Anh Chị Em là lao động cũ hay mới",
                "Người phụ trách xếp Bộ phận và cập nhật hệ thống",
                "Anh Chị Em có thể tra cứu ngay sau đó để biết bộ phận & người phụ trách",
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
