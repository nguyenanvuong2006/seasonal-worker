import { Suspense } from "react";
import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession, hasPermission } from "@/lib/auth";
import { getDashboardOverview } from "@/lib/dashboard";
import { getPublicBranding } from "@/lib/branding";
import { AlertPanel, SectionLabel, SkeletonKpiRow } from "@/components/ui";
import DashboardWidgets from "@/components/dashboard-widgets";
import AnalyticsDashboard from "@/components/analytics/analytics-dashboard";
import {
  AlertTriangle,
  ArrowLeftRight,
  CalendarRange,
  CheckCircle2,
  ClipboardList,
  Database,
  Sprout,
  Sun,
} from "lucide-react";

export const dynamic = "force-dynamic";

/**
 * WORKFORCE ANALYTICS & OPERATIONS DASHBOARD (/admin/dashboard)
 * - Giữ: greeting + branding/year slogan, "Hôm nay cần chú ý", quick links,
 *   configurable widgets (dashboard_widgets) — chuyển xuống cuối làm "Bảng theo dõi tuỳ chỉnh".
 * - Phần chính mới: Analytics (KPI / funnel / trend / worker mix / referral / planning /
 *   department performance / demographics / movements / returning / data quality) —
 *   client component fetch 1 lần từ GET /api/analytics/dashboard, filter lưu ở query string.
 */

function greeting(hour: number) {
  if (hour < 11) return "Chào buổi sáng";
  if (hour < 14) return "Chào buổi trưa";
  if (hour < 18) return "Chào buổi chiều";
  return "Chào buổi tối";
}

// Giờ chào theo Asia/Ho_Chi_Minh — không phụ thuộc giờ server (Vercel có thể ở bất kỳ region nào).
function hourInVietnam(): number {
  const hourStr = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour: "numeric",
    hour12: false,
  }).format(new Date());
  return Number(hourStr) % 24;
}

function dateInVietnam(): string {
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date());
}

export default async function DashboardPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!(await hasPermission(session.role, "dashboard.view"))) redirect("/login");

  const [overview, branding, canExport, canRegistrations, canPlanning, canProfiles, canMovements] = await Promise.all([
    getDashboardOverview(session),
    getPublicBranding(),
    hasPermission(session.role, "registrations.export"),
    hasPermission(session.role, "registrations.view"),
    hasPermission(session.role, "planning.view"),
    hasPermission(session.role, "worker_profile.view"),
    hasPermission(session.role, "workforce_movements.view"),
  ]);
  const hour = hourInVietnam();
  const t = overview.today;
  const p = overview.planning;

  const quickLinks = [
    { href: "/hr/registrations", label: "Daily Application", desc: "Tiếp nhận & xếp việc hôm nay", icon: ClipboardList, visible: canRegistrations },
    { href: "/admin/planning", label: "Planning nhu cầu", desc: "Kế hoạch theo giai đoạn", icon: CalendarRange, visible: canPlanning },
    { href: "/admin/worker-profiles", label: "Hồ sơ tập nghề", desc: "DW Data & hồ sơ lao động", icon: Database, visible: canProfiles },
    { href: "/admin/workforce-movements", label: "Nghỉ việc / Chuyển", desc: "Duyệt yêu cầu chờ HR", icon: ArrowLeftRight, visible: canMovements },
  ].filter((q) => q.visible);

  const attention: string[] = [];
  if (t.pending > 0) attention.push(`${t.pending} DW chờ duyệt hôm nay`);
  if (t.newToDw > 0) attention.push(`${t.newToDw} người tập nghề mới cần duyệt vào DW Data`);
  if (t.mismatch > 0) attention.push(`${t.mismatch} hồ sơ tự khai CŨ nhưng chưa có trong DW Data`);
  if (p && p.shortageTotal > 0) attention.push(`Thiếu ${p.shortageTotal} người so với kế hoạch đang áp dụng`);
  const pendingMovements = overview.movements.pendingResignations + overview.movements.pendingTransfers;
  if (pendingMovements > 0) attention.push(`${pendingMovements} yêu cầu nghỉ việc / thuyên chuyển chờ HR xử lý`);

  return (
    <div className="space-y-5">
      {/* ============ COMMAND STRIP — greeting + theme ============ */}
      <section className="hasfarm-hero field-rows relative overflow-hidden rounded-[20px] px-5 py-5 text-white shadow-[0_10px_30px_rgba(8,41,15,0.25)] md:px-7 md:py-6">
        <div className="relative flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-[10.5px] font-bold uppercase tracking-[0.16em] text-gold-200/90">
              <Sun className="h-3.5 w-3.5" aria-hidden />
              Workforce Analytics & Operations · {dateInVietnam()}
            </p>
            <h1 className="mt-1.5 text-[22px] font-bold leading-tight tracking-[-0.015em] md:text-[26px]">
              {greeting(hour)}, <span className="text-gold-200">{session.fullName}</span>
            </h1>
            <p className="mt-1 max-w-[58ch] text-[13px] leading-relaxed text-white/70">
              Phân tích tuyển dụng, nhu cầu nhân lực và biến động lao động — lọc theo thời gian và cơ cấu tổ chức.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {branding.yearSlogan ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-gold-300/30 bg-gold-300/10 px-3 py-1.5 text-[11.5px] font-bold text-gold-100">
                <Sprout className="h-3.5 w-3.5" aria-hidden />
                {branding.yearSlogan}
              </span>
            ) : null}
            <Link
              href={session.role === "DEPT_MANAGER" || !canRegistrations ? "/admin/planning" : "/hr/registrations"}
              className="inline-flex items-center gap-1.5 rounded-full bg-accent px-3.5 py-1.5 text-[12px] font-bold text-white shadow-[0_6px_16px_rgba(226,109,28,0.35)] transition-colors hover:bg-accent-hover"
            >
              <ClipboardList className="h-3.5 w-3.5" aria-hidden /> {session.role === "DEPT_MANAGER" || !canRegistrations ? "Mở Planning" : "Mở Daily Application"}
            </Link>
          </div>
        </div>
      </section>

      {/* ============ HÔM NAY CẦN CHÚ Ý ============ */}
      {attention.length > 0 ? (
        <AlertPanel
          tone="warning"
          icon={<AlertTriangle className="h-4 w-4" aria-hidden />}
          title="Hôm nay cần chú ý"
          action={
            <Link
              href={session.role === "DEPT_MANAGER" || !canRegistrations ? "/admin/planning" : "/hr/registrations"}
              className="shrink-0 rounded-full border border-warning/30 bg-surface-raised px-3 py-1.5 text-[12px] font-bold text-warning transition-colors hover:bg-warning-tint"
            >
              Xử lý ngay →
            </Link>
          }
        >
          <ul className="flex flex-wrap gap-x-5 gap-y-1">
            {attention.map((a) => (
              <li key={a} className="flex items-center gap-1.5 text-[12.5px] font-medium">
                <span className="h-1.5 w-1.5 rounded-full bg-warning" aria-hidden /> {a}
              </li>
            ))}
          </ul>
        </AlertPanel>
      ) : (
        <AlertPanel tone="success" icon={<CheckCircle2 className="h-4 w-4" aria-hidden />} title="Hôm nay không có việc khẩn cấp">
          <p className="text-[12.5px]">Tất cả hồ sơ đã xử lý xong, kế hoạch nhân lực đang đủ người.</p>
        </AlertPanel>
      )}

      {/* ============ ANALYTICS (phần chính) ============ */}
      <Suspense fallback={<SkeletonKpiRow count={8} />}>
        <AnalyticsDashboard canExport={canExport} />
      </Suspense>

      {/* ============ QUICK ACTIONS ============ */}
      {quickLinks.length > 0 ? (
        <div>
          <SectionLabel tone="green" className="mb-2">Truy cập nhanh</SectionLabel>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {quickLinks.map((q) => (
              <Link
                key={q.href}
                href={q.href}
                className="group flex items-center gap-3 rounded-[16px] border border-border bg-surface p-4 shadow-[0_1px_2px_rgba(23,32,18,0.04),0_8px_24px_rgba(23,32,18,0.05)] transition-[border-color,box-shadow,transform] hover:-translate-y-[1px] hover:border-primary/30 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[11px] bg-primary-tint text-primary ring-1 ring-black/[0.03] transition-colors group-hover:bg-accent-tint group-hover:text-accent">
                  <q.icon className="h-5 w-5" aria-hidden />
                </div>
                <div className="min-w-0">
                  <p className="text-[13.5px] font-bold text-fg">{q.label}</p>
                  <p className="truncate text-[11.5px] text-fg-muted">{q.desc}</p>
                </div>
              </Link>
            ))}
          </div>
        </div>
      ) : null}

      {/* ============ ADDITIONAL WIDGETS (dashboard_widgets — giữ nguyên chức năng) ============ */}
      <div>
        <SectionLabel tone="green" className="mb-2">Bảng theo dõi tuỳ chỉnh</SectionLabel>
        <DashboardWidgets />
      </div>
    </div>
  );
}
