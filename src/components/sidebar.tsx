"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { BrandLogo } from "@/components/brand-logo";
import { cn } from "@/components/ui";
import { ROLE_LABEL } from "@/lib/helpers";
import type { Session } from "@/lib/auth";

const NAV: { href: string; label: string; desc: string; icon: string; roles: string[] }[] = [
  {
    href: "/task-center",
    label: "Task Center",
    desc: "Toàn bộ việc cần xử lý",
    icon: "✅",
    roles: ["ADMIN", "HR_RECRUITER", "DEPT_MANAGER"],
  },
  {
    href: "/hr/registrations",
    label: "Daily Application",
    desc: "Hôm nay • tick & import",
    icon: "📋",
    roles: ["ADMIN", "HR_RECRUITER"],
  },
  {
    href: "/hr/workers",
    label: "DW Data",
    desc: "20K hồ sơ • đối chiếu cũ/mới",
    icon: "🗄️",
    roles: ["ADMIN", "HR_RECRUITER"],
  },
  {
    href: "/department",
    label: "Bộ phận của tôi",
    desc: "Danh sách hôm nay • xuất Excel",
    icon: "🏭",
    roles: ["DEPT_MANAGER", "ADMIN", "HR_RECRUITER"],
  },
  {
    href: "/admin/departments",
    label: "Department",
    desc: "Dept + Group • 71 bộ phận",
    icon: "🏗️",
    roles: ["ADMIN", "HR_RECRUITER"],
  },
  {
    href: "/admin/form-builder",
    label: "Câu hỏi động",
    desc: "Thêm câu hỏi không code",
    icon: "🧩",
    roles: ["ADMIN", "HR_RECRUITER"],
  },
  {
    href: "/admin/field-definitions",
    label: "Trường dữ liệu",
    desc: "Metadata: đổi tên cột, alias import",
    icon: "🧬",
    roles: ["ADMIN"],
  },
  {
    href: "/admin/worker-profiles",
    label: "Hồ sơ điện tử",
    desc: "Digital Worker File — 1 người, 1 hồ sơ",
    icon: "🪪",
    roles: ["ADMIN", "HR_RECRUITER"],
  },
  {
    href: "/admin/dashboard",
    label: "Dashboard",
    desc: "KPI & bảng tổng hợp (nền tảng)",
    icon: "📊",
    roles: ["ADMIN", "HR_RECRUITER", "DEPT_MANAGER"],
  },
  {
    href: "/admin/workflow",
    label: "Workflow",
    desc: "Cấu hình các bước trạng thái",
    icon: "🔀",
    roles: ["ADMIN"],
  },
  {
    href: "/admin/rules",
    label: "Rule Engine",
    desc: "IF → THEN, không cần code",
    icon: "🧠",
    roles: ["ADMIN"],
  },
  {
    href: "/admin/permissions",
    label: "Phân quyền chi tiết",
    desc: "Ma trận quyền theo chức năng",
    icon: "🛡️",
    roles: ["ADMIN"],
  },
  {
    href: "/admin/notifications",
    label: "Thông báo",
    desc: "Hàng đợi thông báo (nền tảng)",
    icon: "🔔",
    roles: ["ADMIN", "HR_RECRUITER"],
  },
  {
    href: "/admin/planning",
    label: "Planning",
    desc: "Kế hoạch lao động theo giai đoạn",
    icon: "🗓️",
    roles: ["ADMIN", "HR_RECRUITER", "DEPT_MANAGER"],
  },
  {
    href: "/admin/workforce-movements",
    label: "Nghỉ việc / Thuyên chuyển",
    desc: "Workforce Movement",
    icon: "🔁",
    roles: ["ADMIN", "HR_RECRUITER", "DEPT_MANAGER"],
  },
  {
    href: "/admin/data-scopes",
    label: "Data Scope",
    desc: "Manager quản lý bộ phận nào",
    icon: "🗺️",
    roles: ["ADMIN"],
  },
  {
    href: "/admin/recycle-bin",
    label: "Thùng rác",
    desc: "Khôi phục hồ sơ đã xoá",
    icon: "🗑️",
    roles: ["ADMIN"],
  },
  {
    href: "/admin/system",
    label: "Control Center",
    desc: "Health, Import, Audit — tất cả trong 1 nơi",
    icon: "🩺",
    roles: ["ADMIN"],
  },
  {
    href: "/admin/users",
    label: "Phân quyền RBAC",
    desc: "HR • Quản đốc • Admin",
    icon: "🔐",
    roles: ["ADMIN"],
  },
  {
    href: "/admin/audit",
    label: "Nhật ký hệ thống",
    desc: "Ai duyệt, ai sửa, khi nào",
    icon: "🧾",
    roles: ["ADMIN"],
  },
  {
    href: "/admin/import-data",
    label: "Nhập dữ liệu ban đầu",
    desc: "Tải CSV lên qua trình duyệt",
    icon: "⬆️",
    roles: ["ADMIN"],
  },
];

export function Sidebar({ session }: { session: Session }) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const items = NAV.filter((n) => n.roles.includes(session.role));

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  };

  return (
    <>
      <button
        onClick={() => setOpen((v) => !v)}
        className="fixed left-3 top-3 z-[80] rounded-full bg-hasfarm-800 px-4 py-2 text-sm font-bold text-white shadow-lg ring-1 ring-black/10 lg:hidden"
      >
        ☰ Menu
      </button>

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-[70] flex w-[296px] flex-col border-r border-white/10 bg-[#0B2E19] text-white transition-transform lg:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="border-b border-white/10 bg-gradient-to-b from-white/[0.08] to-transparent px-5 py-5">
          <BrandLogo light size="sm" />
          <div className="mt-4 flex items-center gap-2 rounded-xl bg-white/10 px-3 py-2 ring-1 ring-white/10">
            <div className="h-8 w-8 rounded-full bg-gold-400 text-center text-sm font-black leading-8 text-hasfarm-900">
              {(session.fullName || session.username).slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0">
              <p className="truncate text-[13px] font-black">{session.fullName}</p>
              <p className="text-[10px] font-bold uppercase tracking-widest text-gold-300">
                {ROLE_LABEL[session.role]}
              </p>
            </div>
          </div>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto p-3">
          <p className="px-3 py-2 text-[10px] font-black uppercase tracking-[0.2em] text-white/40">Workspace</p>
          {items.map((item) => {
            const active = pathname === item.href || pathname.startsWith(item.href + "/");
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className={cn(
                  "group flex items-center gap-3 rounded-[14px] px-3 py-3 transition",
                  active
                    ? "bg-white text-hasfarm-900 shadow-[0_8px_20px_rgba(0,0,0,0.18)]"
                    : "text-white/75 hover:bg-white/10 hover:text-white",
                )}
              >
                <span
                  className={cn(
                    "flex h-9 w-9 items-center justify-center rounded-xl text-[16px] ring-1",
                    active ? "bg-hasfarm-700 text-white ring-black/10" : "bg-white/10 ring-white/10",
                  )}
                >
                  {item.icon}
                </span>
                <span className="min-w-0">
                  <span className="block text-[13px] font-black leading-tight">{item.label}</span>
                  <span className={cn("block text-[11px] leading-tight", active ? "text-hasfarm-700/70" : "text-white/50")}>
                    {item.desc}
                  </span>
                </span>
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-white/10 bg-black/20 p-3">
          <div className="rounded-[14px] bg-gradient-to-br from-gold-400 to-gold-600 p-[1px]">
            <div className="rounded-[13px] bg-[#0B2E19] p-3">
              <p className="text-[11px] font-bold uppercase tracking-widest text-gold-300">Dalat Hasfarm</p>
              <p className="mt-1 text-[12px] leading-relaxed text-white/70">
                CCCD bắt buộc 100%. Đối chiếu DW Data 3 tầng để phân biệt lao động cũ / mới tự động.
              </p>
            </div>
          </div>
          <button onClick={logout} className="mt-3 w-full rounded-full border border-white/15 bg-white/5 px-3 py-2.5 text-xs font-bold hover:bg-white/10">
            Đăng xuất • Log out
          </button>
          <Link href="/" className="mt-2 block rounded-full bg-white px-3 py-2 text-center text-xs font-black text-hasfarm-900">
            ← Về cổng lao động
          </Link>
        </div>
      </aside>

      {open && <div onClick={() => setOpen(false)} className="fixed inset-0 z-[60] bg-black/40 backdrop-blur-sm lg:hidden" />}
    </>
  );
}
