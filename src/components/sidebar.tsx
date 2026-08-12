"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  LayoutDashboard,
  ListChecks,
  ClipboardList,
  Database,
  Building2,
  Factory,
  IdCard,
  ArrowLeftRight,
  CalendarRange,
  FormInput,
  Layers,
  GitBranch,
  SlidersHorizontal,
  Bell,
  Users,
  ShieldCheck,
  Map as MapIcon,
  Gauge,
  ScrollText,
  UploadCloud,
  Trash2,
  Menu,
  X,
  ChevronsLeft,
  ChevronsRight,
  LogOut,
  type LucideIcon,
} from "lucide-react";
import { BrandLogo } from "@/components/brand-logo";
import { cn } from "@/components/ui";
import { ROLE_LABEL } from "@/lib/helpers";
import type { Session } from "@/lib/auth";

type NavItem = { href: string; label: string; icon: LucideIcon; roles: string[] };
type NavGroup = { group: string; items: NavItem[] };

/**
 * Same set of destinations and the same `roles` per item as before the redesign — only the
 * grouping/visual treatment changed. `Sidebar` still filters every group/item by
 * `session.role` (see `filterGroups` below), so RBAC visibility is byte-for-byte unchanged:
 * a role that couldn't see a link before still can't see it now.
 */
const NAV_GROUPS: NavGroup[] = [
  {
    group: "Tổng quan",
    items: [
      { href: "/admin/dashboard", label: "Dashboard", icon: LayoutDashboard, roles: ["ADMIN", "HR_RECRUITER", "DEPT_MANAGER"] },
      { href: "/task-center", label: "Task Center", icon: ListChecks, roles: ["ADMIN", "HR_RECRUITER", "DEPT_MANAGER"] },
    ],
  },
  {
    group: "Tuyển & nhận lao động",
    items: [
      { href: "/hr/registrations", label: "Daily Application", icon: ClipboardList, roles: ["ADMIN", "HR_RECRUITER"] },
      { href: "/hr/workers", label: "DW Data", icon: Database, roles: ["ADMIN", "HR_RECRUITER"] },
      { href: "/admin/departments", label: "Department", icon: Building2, roles: ["ADMIN", "HR_RECRUITER"] },
      { href: "/department", label: "Bộ phận của tôi", icon: Factory, roles: ["DEPT_MANAGER", "ADMIN", "HR_RECRUITER"] },
    ],
  },
  {
    group: "Quản lý lao động",
    items: [
      { href: "/admin/worker-profiles", label: "Hồ sơ điện tử", icon: IdCard, roles: ["ADMIN", "HR_RECRUITER"] },
      { href: "/admin/workforce-movements", label: "Nghỉ việc / Thuyên chuyển", icon: ArrowLeftRight, roles: ["ADMIN", "HR_RECRUITER", "DEPT_MANAGER"] },
    ],
  },
  {
    group: "Kế hoạch",
    items: [{ href: "/admin/planning", label: "Planning", icon: CalendarRange, roles: ["ADMIN", "HR_RECRUITER", "DEPT_MANAGER"] }],
  },
  {
    group: "Cấu hình nghiệp vụ",
    items: [
      { href: "/admin/form-builder", label: "Câu hỏi động", icon: FormInput, roles: ["ADMIN", "HR_RECRUITER"] },
      { href: "/admin/field-definitions", label: "Trường dữ liệu", icon: Layers, roles: ["ADMIN"] },
      { href: "/admin/workflow", label: "Workflow", icon: GitBranch, roles: ["ADMIN"] },
      { href: "/admin/rules", label: "Rule Engine", icon: SlidersHorizontal, roles: ["ADMIN"] },
      { href: "/admin/notifications", label: "Thông báo", icon: Bell, roles: ["ADMIN", "HR_RECRUITER"] },
    ],
  },
  {
    group: "Quản trị",
    items: [
      { href: "/admin/users", label: "Phân quyền RBAC", icon: Users, roles: ["ADMIN"] },
      { href: "/admin/permissions", label: "Phân quyền chi tiết", icon: ShieldCheck, roles: ["ADMIN"] },
      { href: "/admin/data-scopes", label: "Data Scope", icon: MapIcon, roles: ["ADMIN"] },
      { href: "/admin/system", label: "Control Center", icon: Gauge, roles: ["ADMIN"] },
      { href: "/admin/audit", label: "Nhật ký hệ thống", icon: ScrollText, roles: ["ADMIN"] },
      { href: "/admin/import-data", label: "Nhập dữ liệu ban đầu", icon: UploadCloud, roles: ["ADMIN"] },
      { href: "/admin/recycle-bin", label: "Thùng rác", icon: Trash2, roles: ["ADMIN"] },
    ],
  },
];

function filterGroups(role: string): NavGroup[] {
  return NAV_GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => i.roles.includes(role)) })).filter((g) => g.items.length > 0);
}

export function Sidebar({ session }: { session: Session }) {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  const groups = filterGroups(session.role);

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  // Escape closes the mobile drawer; a small focus trap keeps Tab inside it while open.
  useEffect(() => {
    if (!mobileOpen) return;
    const nav = navRef.current;
    nav?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setMobileOpen(false);
        menuButtonRef.current?.focus();
        return;
      }
      if (e.key !== "Tab" || !nav) return;
      const focusable = nav.querySelectorAll<HTMLElement>("a[href], button:not([disabled])");
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [mobileOpen]);

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  };

  const initial = (session.fullName || session.username).slice(0, 1).toUpperCase();

  const navContent = (
    <>
      <div className={cn("border-b border-white/10 px-4 py-4", collapsed && "px-3")}>
        {collapsed ? (
          <div className="flex justify-center">
            <div className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-white shadow-sm">
              <span className="text-[13px] font-black text-primary">DH</span>
            </div>
          </div>
        ) : (
          <BrandLogo light size="sm" />
        )}
        <div className={cn("mt-4 flex items-center gap-2.5 rounded-[10px] bg-white/[0.07] px-2.5 py-2", collapsed && "justify-center px-0")}>
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-[13px] font-bold text-[#2A1E05]">{initial}</div>
          {!collapsed && (
            <div className="min-w-0">
              <p className="truncate text-[13px] font-semibold text-white">{session.fullName}</p>
              <p className="text-[10.5px] font-medium uppercase tracking-wider text-accent">{ROLE_LABEL[session.role]}</p>
            </div>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2.5 py-3">
        {groups.map((g) => (
          <div key={g.group} className="mb-1">
            {!collapsed && <p className="px-2.5 pb-1.5 pt-3 text-[10px] font-bold uppercase tracking-[0.08em] text-white/35 first:pt-0">{g.group}</p>}
            {g.items.map((item) => {
              const active = pathname === item.href || pathname.startsWith(item.href + "/");
              const Icon = item.icon;
              return (
                <div key={item.href} className="group relative">
                  <Link
                    href={item.href}
                    className={cn(
                      "relative flex items-center gap-2.5 rounded-[9px] py-2 text-[13px] font-medium transition-colors duration-150",
                      collapsed ? "justify-center px-0" : "px-2.5",
                      active ? "bg-white/[0.08] text-white" : "text-white/65 hover:bg-white/[0.05] hover:text-white",
                    )}
                  >
                    {active && <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-full bg-accent" aria-hidden />}
                    <Icon className="h-[17px] w-[17px] shrink-0" aria-hidden />
                    {!collapsed && <span className="truncate">{item.label}</span>}
                  </Link>
                  {collapsed && (
                    <span className="animate-fade-in-scale pointer-events-none absolute left-full top-1/2 z-50 ml-2 -translate-y-1/2 whitespace-nowrap rounded-[7px] bg-[#0B2E19] px-2.5 py-1.5 text-[12px] font-medium text-white opacity-0 shadow-lg ring-1 ring-white/10 group-hover:opacity-100">
                      {item.label}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <div className={cn("border-t border-white/10 p-2.5", collapsed && "flex flex-col items-center gap-2")}>
        <button
          onClick={logout}
          title="Đăng xuất"
          className={cn(
            "flex items-center gap-2.5 rounded-[9px] text-[13px] font-medium text-white/65 transition-colors hover:bg-white/[0.06] hover:text-white",
            collapsed ? "h-9 w-9 justify-center" : "w-full px-2.5 py-2",
          )}
        >
          <LogOut className="h-[17px] w-[17px] shrink-0" aria-hidden />
          {!collapsed && "Đăng xuất"}
        </button>
        {!collapsed && (
          <Link href="/" className="mt-1.5 block rounded-[9px] bg-white/[0.06] px-2.5 py-2 text-center text-[12px] font-medium text-white/70 hover:bg-white/[0.1] hover:text-white">
            ← Về cổng đăng ký lao động
          </Link>
        )}
      </div>
    </>
  );

  return (
    <>
      {/* Mobile trigger */}
      <button
        ref={menuButtonRef}
        onClick={() => setMobileOpen(true)}
        aria-label="Mở menu điều hướng"
        className="fixed left-3 top-3 z-[80] flex h-10 w-10 items-center justify-center rounded-[10px] bg-[#0B2E19] text-white shadow-md ring-1 ring-white/10 lg:hidden"
      >
        <Menu className="h-5 w-5" aria-hidden />
      </button>

      {/* Desktop sidebar */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-[70] hidden flex-col bg-[#0B2E19] transition-[width] duration-200 lg:flex",
          collapsed ? "w-[76px]" : "w-[264px]",
        )}
      >
        {navContent}
        <button
          onClick={() => setCollapsed((v) => !v)}
          aria-label={collapsed ? "Mở rộng sidebar" : "Thu gọn sidebar"}
          className="absolute -right-3 top-16 flex h-6 w-6 items-center justify-center rounded-full border border-white/10 bg-[#0B2E19] text-white/70 shadow-md hover:text-white"
        >
          {collapsed ? <ChevronsRight className="h-3.5 w-3.5" aria-hidden /> : <ChevronsLeft className="h-3.5 w-3.5" aria-hidden />}
        </button>
      </aside>
      {/* Spacer to push page content, kept in sync with aside width */}
      <div className={cn("hidden shrink-0 transition-[width] duration-200 lg:block", collapsed ? "w-[76px]" : "w-[264px]")} aria-hidden />

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-[75] lg:hidden">
          <div className="animate-overlay-in absolute inset-0 bg-fg/50 backdrop-blur-[1px]" onClick={() => setMobileOpen(false)} aria-hidden />
          <nav
            ref={navRef}
            tabIndex={-1}
            aria-label="Điều hướng chính"
            className="animate-drawer-in absolute inset-y-0 left-0 flex w-[280px] flex-col bg-[#0B2E19] outline-none"
          >
            <button
              onClick={() => setMobileOpen(false)}
              aria-label="Đóng menu"
              className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-white"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
            {navContent}
          </nav>
        </div>
      )}
    </>
  );
}
