"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, Badge } from "@/components/ui";
import { BrandingSettingsCard } from "@/components/branding-settings-card";
import {
  Loader2,
  ExternalLink,
  Database,
  Clock,
  GitCommit,
  Bell,
  CalendarClock,
  GitBranch,
  Download,
  UploadCloud,
  ScrollText,
  ShieldCheck,
  Trash2,
  Sparkles,
} from "lucide-react";

type Stats = {
  counts: Record<string, number>;
  dbSize: { size_pretty: string; size_bytes: number };
  tablesAndIndexes: { tables: number; indexes: number };
  workflowVersion: { stages: number; last_updated: string | null };
  metadataVersion: { fields: number; last_updated: string | null };
  notificationQueue: { queued: number; sent: number; failed: number };
  scheduler: { job_key: string; label: string; is_active: boolean; last_run_at: string | null; last_status: string | null }[];
  lastImport: { created_at: string; action: string } | null;
  lastExport: { created_at: string } | null;
  lastLogin: { created_at: string; username: string } | null;
  lastBackup: { created_at: string; username: string } | null;
  build: { commit: string | null; branch: string | null; env: string; region: string | null; checkedAt: string };
};

function fmt(d: string | null | undefined) {
  return d ? new Date(d).toLocaleString("vi-VN") : "Chưa có";
}

const QUICK_ACTIONS = [
  { href: "/admin/import-data", icon: UploadCloud, label: "Import Engine", desc: "Nhập dữ liệu hàng loạt" },
  { href: "/admin/audit", icon: ScrollText, label: "Audit Log", desc: "Nhật ký toàn hệ thống" },
  { href: "/admin/permissions", icon: ShieldCheck, label: "Phân quyền", desc: "RBAC + Data Scope" },
  { href: "/admin/recycle-bin", icon: Trash2, label: "Thùng rác", desc: "Khôi phục dữ liệu đã xoá" },
];

export default function SystemHealthPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch("/api/admin/system-stats");
    if (res.ok) setStats(await res.json());
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-6">
      <div className="hasfarm-hero animate-slide-up overflow-hidden rounded-[24px] p-6 text-white shadow-[0_20px_50px_rgba(8,50,27,0.35)] sm:p-8">
        <div className="flex items-center gap-4">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-surface/10 backdrop-blur-md ring-1 ring-white/20">
            <Sparkles className="h-7 w-7 text-gold-300" />
          </div>
          <div>
            <p className="text-[11px] font-black uppercase tracking-[0.3em] text-gold-300">Admin Control Center</p>
            <h1 className="text-2xl font-black tracking-tight sm:text-[28px]">Trung tâm điều khiển hệ thống</h1>
            <p className="mt-0.5 text-sm text-white/70">Database, Import Engine, Audit Log, đồng bộ dữ liệu — tất cả trong 1 nơi.</p>
          </div>
        </div>

        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {QUICK_ACTIONS.map((a) => (
            <Link
              key={a.href}
              href={a.href}
              className="group flex flex-col gap-2 rounded-2xl bg-surface/10 p-4 backdrop-blur-md ring-1 ring-white/20 transition hover:bg-surface/20"
            >
              <a.icon className="h-5 w-5 text-gold-300 transition group-hover:scale-110" />
              <span className="text-sm font-black">{a.label}</span>
              <span className="text-[11px] text-white/60">{a.desc}</span>
            </Link>
          ))}
        </div>
      </div>

      <div>
        <h2 className="text-lg font-black text-fg">Health Monitor</h2>
        <p className="text-sm text-fg-secondary">
          Số liệu lấy trực tiếp từ database. CPU/RAM/uptime của máy chủ không hiển thị ở đây vì Vercel (serverless)
          không cấp quyền đọc chỉ số phần cứng — xem trực tiếp trên dashboard Neon/Vercel bên dưới.
        </p>
      </div>

      {loading && (
        <div className="p-10 text-center">
          <Loader2 className="mx-auto h-6 w-6 animate-spin text-primary" />
        </div>
      )}

      {stats && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              { l: "Department", v: stats.counts.departments, s: `${stats.counts.departments_deleted} trong thùng rác` },
              { l: "DW Data", v: stats.counts.dw_data, s: `${stats.counts.dw_data_deleted} trong thùng rác` },
              { l: "Daily Application", v: stats.counts.daily_applications, s: `${stats.counts.daily_applications_today} hôm nay` },
              { l: "Tài khoản", v: stats.counts.users, s: `${stats.counts.audit_logs} dòng audit log` },
            ].map((k) => (
              <div key={k.l} className="rounded-[18px] bg-[#0F3D23] p-4 text-white shadow">
                <p className="text-[10px] font-black uppercase tracking-widest opacity-70">{k.l}</p>
                <p className="mt-1 text-[26px] font-black leading-none">{k.v}</p>
                <p className="mt-1 text-[10px] opacity-70">{k.s}</p>
              </div>
            ))}
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader
                title={
                  <span className="flex items-center gap-2">
                    <Database className="h-4 w-4" /> Database (Neon)
                  </span>
                }
              />
              <CardContent className="space-y-2 text-sm">
                <p>
                  Dung lượng đang dùng: <b>{stats.dbSize.size_pretty}</b>
                </p>
                <p>
                  <b>{stats.tablesAndIndexes.tables}</b> bảng · <b>{stats.tablesAndIndexes.indexes}</b> index
                </p>
                <a
                  href="https://console.neon.tech"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  Mở Neon Dashboard <ExternalLink className="h-3 w-3" />
                </a>
              </CardContent>
            </Card>

            <Card>
              <CardHeader
                title={
                  <span className="flex items-center gap-2">
                    <GitBranch className="h-4 w-4" /> Phiên bản cấu hình
                  </span>
                }
              />
              <CardContent className="space-y-1.5 text-sm">
                <p>
                  Workflow: <b>{stats.workflowVersion.stages}</b> bước · cập nhật gần nhất{" "}
                  <b>{fmt(stats.workflowVersion.last_updated)}</b>
                </p>
                <p>
                  Metadata: <b>{stats.metadataVersion.fields}</b> trường · cập nhật gần nhất{" "}
                  <b>{fmt(stats.metadataVersion.last_updated)}</b>
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader
                title={
                  <span className="flex items-center gap-2">
                    <Bell className="h-4 w-4" /> Hàng đợi thông báo
                  </span>
                }
              />
              <CardContent className="space-y-1.5 text-sm">
                <p>
                  <Badge tone="amber">{stats.notificationQueue.queued} đang chờ</Badge>{" "}
                  <Badge tone="green">{stats.notificationQueue.sent} đã gửi</Badge>{" "}
                  {stats.notificationQueue.failed > 0 && <Badge tone="red">{stats.notificationQueue.failed} lỗi</Badge>}
                </p>
                <a href="/admin/notifications" className="inline-block text-primary hover:underline">
                  Xem hàng đợi →
                </a>
              </CardContent>
            </Card>

            <Card>
              <CardHeader
                title={
                  <span className="flex items-center gap-2">
                    <CalendarClock className="h-4 w-4" /> Scheduler
                  </span>
                }
              />
              <CardContent className="space-y-1.5 text-sm">
                {stats.scheduler.map((j) => (
                  <p key={j.job_key}>
                    <Badge tone={j.is_active ? "green" : "gray"}>{j.label}</Badge> — lần chạy gần nhất{" "}
                    <b>{fmt(j.last_run_at)}</b> {j.last_status ? `(${j.last_status})` : ""}
                  </p>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader
                title={
                  <span className="flex items-center gap-2">
                    <GitCommit className="h-4 w-4" /> Build hiện tại (Vercel)
                  </span>
                }
              />
              <CardContent className="space-y-1 text-sm">
                <p>
                  Commit: <b className="font-mono">{stats.build.commit ?? "—"}</b>
                  {stats.build.branch ? ` (${stats.build.branch})` : ""}
                </p>
                <p>
                  Môi trường: <b>{stats.build.env}</b> {stats.build.region ? `· Vùng: ${stats.build.region}` : ""}
                </p>
                <a
                  href="https://vercel.com/dashboard"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  Mở Vercel Dashboard <ExternalLink className="h-3 w-3" />
                </a>
              </CardContent>
            </Card>

            <Card>
              <CardHeader
                title={
                  <span className="flex items-center gap-2">
                    <Clock className="h-4 w-4" /> Hoạt động gần nhất
                  </span>
                }
              />
              <CardContent className="space-y-1.5 text-sm">
                <p>
                  Import gần nhất: <b>{fmt(stats.lastImport?.created_at)}</b>
                </p>
                <p>
                  Export Excel gần nhất: <b>{fmt(stats.lastExport?.created_at)}</b>
                </p>
                <p>
                  Đăng nhập gần nhất: <b>{fmt(stats.lastLogin?.created_at)}</b>
                  {stats.lastLogin ? ` (${stats.lastLogin.username})` : ""}
                </p>
                <p>
                  Backup gần nhất: <b>{fmt(stats.lastBackup?.created_at)}</b>
                  {stats.lastBackup ? ` (${stats.lastBackup.username})` : ""}
                </p>
                <a href="/admin/audit" className="inline-block text-primary hover:underline">
                  Xem toàn bộ nhật ký →
                </a>
              </CardContent>
            </Card>

            <Card>
              <CardHeader title="Backup" />
              <CardContent className="space-y-2 text-sm text-fg-secondary">
                <a
                  href="/api/admin/backup"
                  className="inline-flex h-10 items-center gap-2 rounded-full bg-primary px-4 text-sm font-bold text-white hover:bg-primary-hover"
                >
                  <Download className="h-4 w-4" /> Export Database (JSON)
                </a>
                <p>
                  Backup toàn bộ dữ liệu nghiệp vụ (không gồm tài khoản). Không có Restore tự động — cần khôi phục thì
                  đưa file này cho AI/dev viết script 1 lần, hoặc dùng Neon → <b>Branches</b> để snapshot cấp database
                  (khuyến nghị cho backup định kỳ thật sự).
                </p>
              </CardContent>
            </Card>
          </div>
        </>
      )}

      <BrandingSettingsCard />
    </div>
  );
}
