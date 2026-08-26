/**
 * DYNAMIC RBAC V2 AUDIT — nav config extracted out of sidebar.tsx (pure, no
 * "use client"/React rendering) so filterGroups()/NAV_GROUPS can be exercised
 * directly by node:test against the REAL production nav data, not a
 * hand-copied stub that could drift from what actually ships.
 */
import {
  LayoutDashboard,
  ListChecks,
  ClipboardList,
  Database,
  Building2,
  FolderTree,
  Factory,
  IdCard,
  ArrowLeftRight,
  CalendarRange,
  UsersRound,
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
  FileSpreadsheet,
  BadgeCheck,
  ScanFace,
  UtensilsCrossed,
  type LucideIcon,
} from "lucide-react";
import { DOCUMENT_MERGE_PERMISSION_KEYS } from "./document-merge/module-visibility.ts";

/**
 * `permission` may be ONE key (module has a single gateway permission, e.g.
 * "dw.view") or an ARRAY (module is visible if the session has ANY ONE of
 * them — used when a module's features are governed by several INDEPENDENT
 * permissions, none of which is a "parent" of the others, e.g. Document
 * Merge: execute/history.view/templates.manage each unlock a genuinely
 * separate, independently-routed feature without needing document_merge.view
 * at all). Never require ALL of an array — that would re-create the exact
 * "child permission ineffective" bug this fixes.
 */
export type NavItem = { href: string; label: string; icon: LucideIcon; roles: string[]; permission?: string | string[] };
export type NavGroup = { group: string; items: NavItem[] };

export const NAV_GROUPS: NavGroup[] = [
  {
    group: "Tổng quan",
    items: [
      { href: "/admin/dashboard", label: "Dashboard", icon: LayoutDashboard, roles: ["ADMIN", "HR_RECRUITER", "DEPT_MANAGER"], permission: "dashboard.view" },
      { href: "/task-center", label: "Task Center", icon: ListChecks, roles: ["ADMIN", "HR_RECRUITER", "DEPT_MANAGER", "HR_DIRECTOR"], permission: "dashboard.view" },
    ],
  },
  {
    // Mục XIV — "Tuyển & tiếp nhận"
    group: "Tuyển & tiếp nhận",
    items: [
      { href: "/hr/registrations", label: "Daily Application", icon: ClipboardList, roles: ["ADMIN", "HR_RECRUITER"], permission: "registrations.view" },
      { href: "/hr/workers", label: "DW Data (Đối chiếu)", icon: Database, roles: ["ADMIN", "HR_RECRUITER"], permission: "dw.view" },
      { href: "/admin/organization", label: "Cây tổ chức", icon: FolderTree, roles: ["ADMIN", "HR_RECRUITER"], permission: "departments.manage" },
      { href: "/admin/departments", label: "Bộ phận (danh sách phẳng)", icon: Building2, roles: ["ADMIN", "HR_RECRUITER"], permission: "departments.manage" },
      { href: "/department", label: "Bộ phận của tôi", icon: Factory, roles: ["DEPT_MANAGER", "ADMIN", "HR_RECRUITER"] },
    ],
  },
  {
    // Mục XIV — "Hồ sơ & tài liệu": Document Merge KHÔNG yêu cầu role Recruiter
    // (HR_SUPPORT dùng riêng — mục V, X).
    group: "Hồ sơ & tài liệu",
    items: [
      // Hiện module nếu có BẤT KỲ quyền document_merge nào (execute/history.view/
      // templates.manage đều là tính năng độc lập, không phụ thuộc document_merge.view)
      // — đọc trực tiếp từ catalog, không liệt kê tay để tránh lệch khi catalog đổi.
      { href: "/admin/document-merge", label: "Trộn tài liệu", icon: FileText, roles: ["ADMIN", "HR_RECRUITER", "HR_SUPPORT", "HR_DIRECTOR"], permission: [...DOCUMENT_MERGE_PERMISSION_KEYS] },
    ],
  },
  {
    // Mục XIV, VI, VIII, IX — "Vận hành trong ngày": 3 vai trò mới, KHÔNG đặt dưới
    // "Quản trị hệ thống" (ADMINISTRATION KHÔNG PHẢI ADMIN — mục II, XV).
    group: "Vận hành trong ngày",
    items: [
      { href: "/administration/daily-code", label: "Nhập mã công nhật", icon: BadgeCheck, roles: ["ADMIN", "ADMINISTRATION"], permission: "administration.daily_code.view" },
      { href: "/fingerprint/it-code", label: "IT Code / Vân tay", icon: ScanFace, roles: ["ADMIN", "FINGERPRINT_STAFF"], permission: "fingerprint.view" },
      { href: "/meal/export", label: "Báo cơm", icon: UtensilsCrossed, roles: ["ADMIN", "MEAL_STAFF"], permission: "meal.view" },
    ],
  },
  {
    group: "Quản lý Tập nghề",
    items: [
      { href: "/admin/worker-profiles", label: "Hồ sơ Tập nghề", icon: IdCard, roles: ["ADMIN", "HR_RECRUITER"], permission: "worker_profile.view" },
      { href: "/admin/workforce-movements", label: "Nghỉ việc / Thuyên chuyển", icon: ArrowLeftRight, roles: ["ADMIN", "HR_RECRUITER", "DEPT_MANAGER"], permission: "workforce_movements.view" },
      { href: "/admin/employment-reconciliation", label: "Đối soát Employment", icon: ShieldCheck, roles: ["ADMIN"], permission: "employment.reconcile" },
    ],
  },
  {
    group: "Kế hoạch nhu cầu",
    items: [
      { href: "/admin/planning", label: "Planning (Nhu cầu)", icon: CalendarRange, roles: ["ADMIN", "HR_RECRUITER", "DEPT_MANAGER"], permission: "planning.view" },
      { href: "/admin/workforce-requests", label: "Workforce Request", icon: UsersRound, roles: ["ADMIN", "HR_RECRUITER", "DEPT_MANAGER", "HR_DIRECTOR"], permission: "workforce_request.view" },
      { href: "/admin/recruitment-requests", label: "Yêu cầu tuyển dụng", icon: FileSpreadsheet, roles: ["ADMIN", "HR_RECRUITER", "DEPT_MANAGER"], permission: "planning.view" },
    ],
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
    // Mục XIV, XV — CHỈ ADMIN và người có permission tương ứng. ADMINISTRATION
    // (Nhân viên hành chính) KHÔNG được đặt ở nhóm này — xem nhóm "Vận hành trong ngày".
    group: "Quản trị hệ thống",
    items: [
      // users.view / rbac.view / data_scope.view là quyền XEM ĐỘC LẬP (GET route
      // riêng, không cần .manage) — nav phải hiện nếu có quyền ĐÓ, không chỉ .manage,
      // nếu không quyền .view-only sẽ vô dụng (đúng anti-pattern đang audit).
      { href: "/admin/users", label: "Quản lý thành viên", icon: Users, roles: ["ADMIN"], permission: ["users.view", "users.manage"] },
      { href: "/admin/permissions", label: "Phân quyền chi tiết", icon: ShieldCheck, roles: ["ADMIN"], permission: ["rbac.view", "rbac.manage"] },
      { href: "/admin/data-scopes", label: "Data Scope", icon: MapIcon, roles: ["ADMIN"], permission: ["data_scope.view", "data_scope.manage"] },
      { href: "/admin/system", label: "Control Center", icon: Gauge, roles: ["ADMIN"], permission: "system.view" },
      { href: "/admin/audit", label: "Nhật ký hệ thống", icon: ScrollText, roles: ["ADMIN"], permission: "audit.view" },
      { href: "/admin/import-data", label: "Nhập dữ liệu ban đầu", icon: UploadCloud, roles: ["ADMIN"], permission: "import.run" },
      { href: "/admin/recycle-bin", label: "Thùng rác", icon: Trash2, roles: ["ADMIN"], permission: "recycle_bin.manage" },
    ],
  },
];

/**
 * DYNAMIC RBAC V2 — hiển thị nav theo QUYỀN (không còn hardcode 3 role):
 * mục hiện ra nếu (a) role nằm trong danh sách legacy `roles`, HOẶC (b) session có
 * BẤT KỲ quyền nào trong `permission` (1 key hoặc mảng nhiều key ĐỘC LẬP — xem NavItem)
 * tương ứng (tập quyền do layout server-side tính từ role_permissions).
 * ADMIN luôn có đủ mọi quyền (bypass) nên vẫn thấy toàn bộ như trước.
 */
export function hasNavPermission(item: NavItem, permissions: ReadonlySet<string>): boolean {
  if (item.permission === undefined) return false;
  const keys = Array.isArray(item.permission) ? item.permission : [item.permission];
  return keys.some((key) => permissions.has(key));
}

export function filterGroups(role: string, permissions: ReadonlySet<string>): NavGroup[] {
  return NAV_GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((i) => i.roles.includes(role) || hasNavPermission(i, permissions)),
  })).filter((g) => g.items.length > 0);
}
