import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession, hasPermission } from "@/lib/auth";
import { getDashboardOverview } from "@/lib/dashboard";
import { getPublicBranding } from "@/lib/branding";
import {
  AlertPanel,
  Badge,
  Card,
  CardContent,
  GenderLegend,
  MetricStrip,
  MetricStripItem,
  ProgressBar,
  SectionLabel,
} from "@/components/ui";
import DashboardWidgets from "@/components/dashboard-widgets";
import {
  AlertTriangle,
  ArrowLeftRight,
  CalendarRange,
  CheckCircle2,
  ClipboardList,
  Clock,
  Database,
  FileText,
  Leaf,
  Sprout,
  Sun,
  UserPlus2,
} from "lucide-react";

export const dynamic = "force-dynamic";

function greeting(hour: number) {
  if (hour < 11) return "Chào buổi sáng";
  if (hour < 14) return "Chào buổi trưa";
  if (hour < 18) return "Chào buổi chiều";
  return "Chào buổi tối";
}

// Giờ chào phải theo giờ Việt Nam (Asia/Ho_Chi_Minh) chứ không phải giờ của server
// (Vercel serverless có thể chạy ở bất kỳ region/UTC nào) — dùng Intl.DateTimeFormat
// với timeZone cố định thay vì new Date().getHours() vốn đọc giờ local của server.
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
  // DYNAMIC RBAC V2 — Dashboard mở cho mọi role có dashboard.view (fail-closed).
  if (!(await hasPermission(session.role, "dashboard.view"))) redirect("/login");

  const [overview, branding] = await Promise.all([getDashboardOverview(session), getPublicBranding()]);
  const hour = hourInVietnam();
  const t = overview.today;
  const p = overview.planning;

  const [canRegistrations, canPlanning, canProfiles, canMovements] = await Promise.all([
    hasPermission(session.role, "registrations.view"),
    hasPermission(session.role, "planning.view"),
    hasPermission(session.role, "worker_profile.view"),
    hasPermission(session.role, "workforce_movements.view"),
  ]);

  const quickLinks = [
    { href: "/hr/registrations", label: "Daily Application", desc: "Tiếp nhận & xếp việc hôm nay", icon: ClipboardList, visible: canRegistrations },
    { href: "/admin/planning", label: "Planning nhu cầu", desc: "Kế hoạch theo giai đoạn", icon: CalendarRange, visible: canPlanning },
    { href: "/admin/worker-profiles", label: "Hồ sơ tập nghề", desc: "DW Data & hồ sơ lao động", icon: Database, visible: canProfiles },
    { href: "/admin/workforce-movements", label: "Nghỉ việc / Chuyển", desc: "Duyệt yêu cầu chờ HR", icon: ArrowLeftRight, visible: canMovements },
  ].filter((q) => q.visible);

  const attention: string[] = [];
  if (t.pending > 0) attention.push(`${t.pending} đơn chờ duyệt hôm nay`);
  if (t.newToDw > 0) attention.push(`${t.newToDw} người tập nghề mới cần duyệt vào DW Data`);
  if (t.mismatch > 0) attention.push(`${t.mismatch} hồ sơ tự khai CŨ nhưng chưa có trong DW Data`);
  if (p && p.shortageTotal > 0) attention.push(`Thiếu ${p.shortageTotal} người so với kế hoạch đang áp dụng`);
  const pendingMovements = overview.movements.pendingResignations + overview.movements.pendingTransfers;
  if (pendingMovements > 0) attention.push(`${pendingMovements} yêu cầu nghỉ việc / thuyên chuyển chờ HR xử lý`);

  return (
    <div className="space-y-5">
      {/* ============ COMMAND STRIP — greeting + theme + quick jump ============ */}
      <section className="hasfarm-hero field-rows relative overflow-hidden rounded-[20px] px-5 py-5 text-white shadow-[0_10px_30px_rgba(8,41,15,0.25)] md:px-7 md:py-6">
        <div className="relative flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-[10.5px] font-bold uppercase tracking-[0.16em] text-gold-200/90">
              <Sun className="h-3.5 w-3.5" aria-hidden />
              Tổng quan vận hành · {dateInVietnam()}
            </p>
            <h1 className="mt-1.5 text-[22px] font-bold leading-tight tracking-[-0.015em] md:text-[26px]">
              {greeting(hour)}, <span className="text-gold-200">{session.fullName}</span>
            </h1>
            <p className="mt-1 max-w-[58ch] text-[13px] leading-relaxed text-white/70">
              Tổng hợp điểm cần xử lý trong ngày: tiếp nhận hồ sơ, nhu cầu nhân lực và các yêu cầu chờ duyệt.
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

      {/* ============ RECRUITMENT SNAPSHOT + MOVEMENT ALERTS ============ */}
      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardContent className="p-5 md:p-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <SectionLabel tone="green">Nhu cầu tuyển dụng</SectionLabel>
                <h2 className="mt-1.5 text-[17px] font-bold tracking-[-0.01em] text-fg">Snapshot theo kế hoạch đang áp dụng</h2>
              </div>
              {p ? <Badge tone="green" dot>{p.activePeriods} kế hoạch ACTIVE</Badge> : <Badge tone="gray">Chưa có kế hoạch</Badge>}
            </div>

            {p ? (
              <div className="mt-5 grid gap-6 md:grid-cols-[auto_1fr]">
                {/* Shortage hero */}
                <div className="min-w-[190px] rounded-[16px] border border-accent/20 bg-accent-tint/60 p-5">
                  <p className="text-[10.5px] font-bold uppercase tracking-[0.14em] text-accent">Cần tuyển thêm</p>
                  <p className="mt-1.5 text-[44px] font-bold leading-none tracking-tight tabular-nums text-accent">{p.shortageTotal}</p>
                  <p className="mt-2 text-[11.5px] font-medium leading-relaxed text-fg-secondary">
                    Nam {p.shortageMale} · Nữ {p.shortageFemale} trên tổng nhu cầu {p.demandTotal} người.
                  </p>
                  <div className="mt-3">
                    <div className="flex items-center justify-between text-[11px] font-semibold text-fg-secondary">
                      <span>Tỷ lệ đáp ứng</span>
                      <span className="tabular-nums text-fg">{p.fillRatePercent}%</span>
                    </div>
                    <ProgressBar value={p.fillRatePercent} tone={p.fillRatePercent >= 100 ? "success" : "accent"} className="mt-1.5 h-2" />
                  </div>
                </div>

                {/* Gender demand vs allocation */}
                <div className="min-w-0">
                  <div className="space-y-4">
                    <div>
                      <div className="flex items-center justify-between text-[12.5px] font-semibold">
                        <span className="inline-flex items-center gap-1.5 text-fg">
                          <span className="h-2 w-2 rounded-full bg-primary" aria-hidden /> Nam — nhu cầu {p.demandMale}
                        </span>
                        <span className="tabular-nums text-fg-secondary">đã bố trí {p.allocatedMale}</span>
                      </div>
                      <ProgressBar value={p.demandMale > 0 ? (p.allocatedMale / p.demandMale) * 100 : 100} tone="primary" className="mt-1.5 h-2" />
                    </div>
                    <div>
                      <div className="flex items-center justify-between text-[12.5px] font-semibold">
                        <span className="inline-flex items-center gap-1.5 text-fg">
                          <span className="h-2 w-2 rounded-full bg-accent" aria-hidden /> Nữ — nhu cầu {p.demandFemale}
                        </span>
                        <span className="tabular-nums text-fg-secondary">đã bố trí {p.allocatedFemale}</span>
                      </div>
                      <ProgressBar value={p.demandFemale > 0 ? (p.allocatedFemale / p.demandFemale) * 100 : 100} tone="accent" className="mt-1.5 h-2" />
                    </div>
                  </div>
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
                    <GenderLegend male={p.demandMale} female={p.demandFemale} />
                    <span className="text-[11.5px] text-fg-muted">
                      Đã phân bổ {p.allocatedTotal} · Nghỉ việc {p.resignedTotal}
                    </span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="mt-5 flex items-center gap-3 rounded-[14px] border border-dashed border-border-strong bg-surface-hover/60 p-5 text-[13px] text-fg-secondary">
                <Leaf className="h-5 w-5 shrink-0 text-primary" aria-hidden />
                Chưa có kế hoạch nhu cầu nào đang áp dụng. Vào{" "}
                <Link href="/admin/planning" className="font-bold text-primary underline-offset-2 hover:underline">
                  Planning
                </Link>{" "}
                để tạo kế hoạch đầu tiên.
              </div>
            )}
          </CardContent>
        </Card>

        {/* Movement alerts */}
        <Card>
          <CardContent className="p-5">
            <SectionLabel>Biến động nhân lực</SectionLabel>
            <h2 className="mt-1.5 text-[15px] font-bold text-fg">Yêu cầu chờ HR</h2>
            {overview.movements.recent.length === 0 ? (
              <div className="mt-4 rounded-[14px] border border-dashed border-border-strong bg-surface-hover/60 p-4 text-[12.5px] leading-relaxed text-fg-muted">
                Không có yêu cầu nghỉ việc / thuyên chuyển nào đang chờ xử lý.
              </div>
            ) : (
              <ul className="mt-3 divide-y divide-border">
                {overview.movements.recent.map((m) => (
                  <li key={m.id} className="flex items-center gap-3 py-2.5">
                    <div
                      className={
                        m.movementType === "resignation"
                          ? "flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-warning-tint text-warning"
                          : "flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-info-tint text-info"
                      }
                    >
                      <ArrowLeftRight className="h-4 w-4" aria-hidden />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-semibold text-fg">{m.workerName ?? "—"}</p>
                      <p className="text-[11.5px] text-fg-muted">
                        {m.movementType === "resignation" ? "Nghỉ việc" : "Thuyên chuyển"} · {m.effectiveDate ? new Date(m.effectiveDate).toLocaleDateString("vi-VN") : "—"}
                      </p>
                    </div>
                    <Badge tone="amber" dot>Chờ HR</Badge>
                  </li>
                ))}
              </ul>
            )}
            <Link href="/admin/workforce-movements" className="mt-3 inline-flex items-center gap-1 text-[12px] font-bold text-primary hover:underline">
              Xem tất cả biến động →
            </Link>
          </CardContent>
        </Card>
      </div>

      {/* ============ ACTIVITY / WORKFLOW — today's pipeline ============ */}
      <div>
        <SectionLabel tone="green" className="mb-2">Hoạt động hôm nay</SectionLabel>
        <MetricStrip
          items={[
            <MetricStripItem key="total" icon={<FileText className="h-4 w-4" aria-hidden />} value={t.total} label="Tổng đơn đăng ký" tone="primary" />,
            <MetricStripItem key="pending" icon={<Clock className="h-4 w-4" aria-hidden />} value={t.pending} label="Chờ duyệt" tone="warning" />,
            <MetricStripItem key="approved" icon={<CheckCircle2 className="h-4 w-4" aria-hidden />} value={t.approved} label="Đã xếp việc" tone="success" />,
            <MetricStripItem key="new" icon={<UserPlus2 className="h-4 w-4" aria-hidden />} value={t.newToDw} label="Người mới → DW Data" tone="accent" />,
            <MetricStripItem key="mismatch" icon={<AlertTriangle className="h-4 w-4" aria-hidden />} value={t.mismatch} label="Khai sai CŨ/MỚI" tone="danger" />,
            <MetricStripItem key="dw" icon={<Database className="h-4 w-4" aria-hidden />} value={overview.dwTotal.toLocaleString("vi-VN")} label="Tổng hồ sơ DW Data" tone="info" />,
          ]}
        />
      </div>

      {/* ============ QUICK ACTIONS ============ */}
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

      {/* ============ CUSTOM WIDGETS (existing capability, V2 presentation) ============ */}
      <div>
        <SectionLabel tone="green" className="mb-2">Bảng theo dõi tuỳ chỉnh</SectionLabel>
        <DashboardWidgets />
      </div>
    </div>
  );
}
