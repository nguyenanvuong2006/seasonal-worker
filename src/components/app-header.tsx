import { GlobalSearch } from "@/components/global-search";
import { ProfileMenu } from "@/components/profile-menu";
import type { Session } from "@/lib/auth";
import type { PublicBranding } from "@/lib/branding";

/** Header ứng dụng gọn (~56-64px) — nơi duy nhất chứa Tìm kiếm toàn hệ thống + menu Hồ sơ cá
 * nhân. Không lặp lại logo/thương hiệu đã có ở Sidebar (đúng yêu cầu tránh trùng lặp). */
export function AppHeader({ session, branding }: { session: Session; branding: PublicBranding }) {
  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface/95 pl-16 pr-4 backdrop-blur lg:h-16 lg:pl-6 lg:pr-8">
      <div className="min-w-0 flex-1">
        <GlobalSearch />
      </div>
      {branding.yearSlogan ? (
        <span className="hidden max-w-[220px] truncate rounded-full bg-accent-tint px-3 py-1 text-[11.5px] font-bold text-accent md:inline-block">
          {branding.yearSlogan}
        </span>
      ) : null}
      <ProfileMenu session={session} />
    </header>
  );
}
