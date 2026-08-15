"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
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
  FileText,
  Menu,
  X,
  ChevronsLeft,
  ChevronsRight,
  type LucideIcon,
} from "lucide-react";
import { BrandLogo } from "@/components/brand-logo";
import { cn } from "@/components/ui";
import type { Session } from "@/lib/auth";
import type { PublicBranding } from "@/lib/branding";

type NavItem = { href: string; label: string; icon: LucideIcon; roles: string[]; permission?: string };
type NavGroup = { group: string; items: NavItem[] };

const NAV_GROUPS: NavGroup[] = [
  {
    group: "Tổng quan",
    items: [
      { href: "/admin/dashboard", label: "Dashboard", icon: LayoutDashboard, roles: ["ADMIN", "HR_RECRUITER", "DEPT_MANAGER"], permission: "dashboard.view" },
      { href: "/task-center", label: "Task Center", icon: ListChecks, roles: ["ADMIN", "HR_RECRUITER", "DEPT_MANAGER"], permission: "dashboard.view" },
    ],
  },
  {
    group: "Tuyển & Tiếp nhận Tập nghề",
    items: [
      { href: "/hr/registrations", label: "Daily Application", icon: ClipboardList, roles: ["ADMIN", "HR_RECRUITER"], permission: "registrations.view" },
      { href: "/hr/workers", label: "DW Data (Đối chiếu)", icon: Database, roles: ["ADMIN", "HR_RECRUITER"], permission: "dw.view" },
      { href: "/admin/departments", label: "Cơ cấu tổ chức", icon: Building2, roles: ["ADMIN", "HR_RECRUITER"], permission: "departments.manage" },
      { href: "/department", label: "Bộ phận của tôi", icon: Factory, roles: ["DEPT_MANAGER", "ADMIN", "HR_RECRUITER"] },
    ],
  },
  {
    group: "Quản lý Tập nghề",
    items: [
      { href: "/admin/worker-profiles", label: "Hồ sơ Tập nghề", icon: IdCard, roles: ["ADMIN", "HR_RECRUITER"], permission: "worker_profile.view" },
      { href: "/admin/workforce-movements", label: "Nghỉ việc / Thuyên chuyển", icon: ArrowLeftRight, roles: ["ADMIN", "HR_RECRUITER", "DEPT_MANAGER"], permission: "workforce_movements.view" },
    ],
  },
  {
    group: "Kế hoạch nhu cầu",
    items: [{ href: "/admin/planning", label: "Planning (Nhu cầu)", icon: CalendarRange, roles: ["ADMIN", "HR_RECRUITER", "DEPT_MANAGER"], permission: "planning.view" }],
  },
  {
    group: "Cấu hình nghiệp vụ",
    items: [
      { href: "/admin/form-builder", label: "Câu hỏi động", icon: FormInput, roles: ["ADMIN", "HR_RECRUITER"], permission: "questions.manage" },
      { href: "/admin/field-definitions", label: "Trường dữ liệu", icon: Layers, roles: ["ADMIN"], permission: "field_definitions.manage" },
      { href: "/admin/workflow", label: "Workflow", icon: GitBranch, roles: ["ADMIN"], permission: "workflow.manage" },
      { href: "/admin/rules", label: "Rule Engine", icon: SlidersHorizontal, roles: ["ADMIN"], permission: "rules.manage" },
      { href: "/admin/notifications", label: "Thông báo", icon: Bell, roles: ["ADMIN", "HR_RECRUITER"], permission: "notifications.manage" },
    ],
  },
  {
    group: "Quản trị",
    items: [
      { href: "/admin/document-merge", label: "Document Merge Center", icon: FileText, roles: ["ADMIN", "HR_RECRUITER"], permission: "document_merge.view" },
      { href: "/admin/users", label: "Quản lý thành viên", icon: Users, roles: ["ADMIN"], permission: "users.manage" },
      { href: "/admin/permissions", label: "Phân quyền chi tiết", icon: ShieldCheck, roles: ["ADMIN"], permission: "rbac.manage" },
      { href: "/admin/data-scopes", label: "Data Scope", icon: MapIcon, roles: ["ADMIN"], permission: "data_scope.manage" },
      { href: "/admin/system", label: "Control Center", icon: Gauge, roles: ["ADMIN"], permission: "system.view" },
      { href: "/admin/audit", label: "Nhật ký hệ thống", icon: ScrollText, roles: ["ADMIN"], permission: "audit.view" },
      { href: "/admin/import-data", label: "Nhập dữ liệu ban đầu", icon: UploadCloud, roles: ["ADMIN"], permission: "import.run" },
      { href: "/admin/recycle-bin", label: "Thùng rác", icon: Trash2, roles: ["ADMIN"], permission: "recycle_bin.manage" },
    ],
  },
];

/**
 * DYNAMIC RBAC V2 — hiển thị nav theo QUYỀN (không còn hardcode 3 role):
 * mục hiện ra nếu (a) role nằm trong danh sách legacy `roles`, HOẶC (b) session có quyền
 * `permission` tương ứng (tập quyền do layout server-side tính từ role_permissions).
 * ADMIN luôn có đủ mọi quyền (bypass) nên vẫn thấy toàn bộ như trước.
 */
function filterGroups(role: string, permissions: ReadonlySet<string>): NavGroup[] {
  return NAV_GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((i) => i.roles.includes(role) || (i.permission !== undefined && permissions.has(i.permission))),
  })).filter((g) => g.items.length > 0);
}

const SIDEBAR_BG = "bg-[#083d24]";

export function Sidebar({
  session,
  branding,
  permissions = [],
}: {
  session: Session;
  branding?: PublicBranding;
  /** Tập quyền hiệu lực (do layout server-side truyền xuống) — quyết định mục nào hiện ra. */
  permissions?: string[];
}) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  const groups = filterGroups(session.role, new Set(permissions));

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

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

  const themeLabel = branding?.themeYear ? `Mùa vụ ${branding.themeYear}` : branding?.themeSubtitle || null;

  const navContent = (
    <>
      <div className={cn("relative border-b border-white/10", collapsed ? "px-3 py-4" : "px-4 pb-4 pt-5")}>
        {collapsed ? (
          <div className="flex justify-center">
            <BrandLogo light size="sm" withText={false} />
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <BrandLogo light size="sm" />
            </div>
            {themeLabel ? (
              <span className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-accent/35 bg-[#114d30] px-2.5 py-1 text-[10.5px] font-bold uppercase tracking-[0.1em] text-[#ffc797]">
                <span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden />
                {themeLabel}
              </span>
            ) : null}
          </>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2.5 py-3">
        {groups.map((g) => (
          <div key={g.group} className="mb-1">
            {!collapsed && (
              <p className="px-2.5 pb-1.5 pt-3.5 text-[10px] font-bold uppercase tracking-[0.14em] text-white/42 first:pt-1">
                {g.group}
              </p>
            )}
            {g.items.map((item) => {
              const active = pathname === item.href || pathname.startsWith(item.href + "/");
              const Icon = item.icon;
              return (
                <div key={item.href} className="group relative">
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "relative flex items-center gap-2.5 rounded-[11px] py-[8px] text-[13px] font-medium transition-colors duration-150",
                      collapsed ? "justify-center px-0" : "px-2.5",
                      active
                        ? "bg-[#155c38] text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]"
                        : "text-white/66 hover:bg-[#104d30] hover:text-white",
                    )}
                  >
                    {active && (
                      <span className="absolute left-0 top-1/2 h-[20px] w-[3px] -translate-y-1/2 rounded-full bg-accent" aria-hidden />
                    )}
                    <Icon
                      className={cn("h-[17px] w-[17px] shrink-0", active ? "text-[#ff9d5c]" : "text-white/52 group-hover:text-white/82")}
                      aria-hidden
                    />
                    {!collapsed && <span className="truncate">{item.label}</span>}
                  </Link>
                  {collapsed && (
                    <span className="animate-fade-in-scale pointer-events-none absolute left-full top-1/2 z-50 ml-2 -translate-y-1/2 whitespace-nowrap rounded-[8px] bg-[#102b1c] px-2.5 py-1.5 text-[12px] font-medium text-white opacity-0 shadow-lg ring-1 ring-white/10 group-hover:opacity-100">
                      {item.label}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {!collapsed && (
        <div className="border-t border-white/10 p-2.5">
          <Link
            href="/"
            className="block rounded-[10px] border border-white/10 bg-[#0d472b] px-2.5 py-2 text-center text-[12px] font-medium text-white/72 transition-colors hover:border-accent/40 hover:bg-[#135535] hover:text-white"
          >
            ← Về cổng đăng ký Tập nghề
          </Link>
        </div>
      )}
    </>
  );

  return (
    <>
      <button
        ref={menuButtonRef}
        onClick={() => setMobileOpen(true)}
        aria-label="Mở menu điều hướng"
        className={cn("fixed left-3 top-3 z-[80] flex h-10 w-10 items-center justify-center rounded-[10px] text-white shadow-md ring-1 ring-white/10 lg:hidden", SIDEBAR_BG)}
      >
        <Menu className="h-5 w-5" aria-hidden />
      </button>

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-[70] hidden flex-col border-r border-black/10 shadow-[12px_0_32px_rgba(18,36,25,0.10)] transition-[width] duration-200 lg:flex",
          SIDEBAR_BG,
          collapsed ? "w-[76px]" : "w-[264px]",
        )}
      >
        <div className="relative flex min-h-0 flex-1 flex-col">{navContent}</div>
        <button
          onClick={() => setCollapsed((v) => !v)}
          aria-label={collapsed ? "Mở rộng sidebar" : "Thu gọn sidebar"}
          className="absolute -right-3 top-16 z-10 flex h-6 w-6 items-center justify-center rounded-full border border-white/15 bg-[#0b4527] text-white/75 shadow-md transition-colors hover:text-white"
        >
          {collapsed ? <ChevronsRight className="h-3.5 w-3.5" aria-hidden /> : <ChevronsLeft className="h-3.5 w-3.5" aria-hidden />}
        </button>
      </aside>
      <div className={cn("hidden shrink-0 transition-[width] duration-200 lg:block", collapsed ? "w-[76px]" : "w-[264px]")} aria-hidden />

      {mobileOpen && (
        <div className="fixed inset-0 z-[75] lg:hidden">
          <div className="animate-overlay-in absolute inset-0 bg-fg/50 backdrop-blur-[1px]" onClick={() => setMobileOpen(false)} aria-hidden />
          <nav
            ref={navRef}
            tabIndex={-1}
            aria-label="Điều hướng chính"
            className={cn("animate-drawer-in absolute inset-y-0 left-0 flex w-[280px] flex-col outline-none", SIDEBAR_BG)}
          >
            <button
              onClick={() => setMobileOpen(false)}
              aria-label="Đóng menu"
              className="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-[#155c38] text-white"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
            <div className="relative flex min-h-0 flex-1 flex-col">{navContent}</div>
          </nav>
        </div>
      )}
    </>
  );
}
