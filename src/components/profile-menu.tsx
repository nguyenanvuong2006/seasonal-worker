"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, KeyRound, LogOut, UserCircle } from "lucide-react";
import { cn } from "@/components/ui";
import { ROLE_LABEL } from "@/lib/helpers";
import type { Session } from "@/lib/auth";

export function ProfileMenu({ session }: { session: Session }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const firstItemRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  useEffect(() => {
    if (open) firstItemRef.current?.focus();
  }, [open]);

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  };

  const displayName = session.fullName || session.username;
  const initial = displayName.slice(0, 1).toUpperCase();

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Hồ sơ cá nhân"
        className="flex items-center gap-2 rounded-full border border-border-strong bg-surface py-1 pl-1 pr-2.5 transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-[12px] font-bold text-white">
          {initial}
        </span>
        <span className="hidden max-w-[120px] truncate text-[13px] font-semibold text-fg sm:inline">{displayName}</span>
        <ChevronDown className={cn("h-3.5 w-3.5 text-fg-muted transition-transform", open && "rotate-180")} aria-hidden />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Menu hồ sơ cá nhân"
          className="animate-menu-in absolute right-0 z-40 mt-2 w-64 overflow-hidden rounded-[12px] border border-border bg-surface py-1.5 shadow-lg"
        >
          <div className="flex items-center gap-3 border-b border-border px-4 py-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-[14px] font-bold text-white">
              {initial}
            </span>
            <div className="min-w-0">
              <p className="truncate text-[13.5px] font-semibold text-fg">{displayName}</p>
              <p className="truncate text-[12px] text-fg-muted">@{session.username}</p>
              <p className="mt-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-primary">
                {ROLE_LABEL[session.role] ?? session.role}
              </p>
            </div>
          </div>

          <Link
            ref={firstItemRef}
            href="/profile"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 px-4 py-2.5 text-[13.5px] font-medium text-fg transition-colors hover:bg-surface-hover"
          >
            <UserCircle className="h-4 w-4 text-fg-muted" aria-hidden />
            Hồ sơ cá nhân
          </Link>
          <Link
            href="/profile#password"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 px-4 py-2.5 text-[13.5px] font-medium text-fg transition-colors hover:bg-surface-hover"
          >
            <KeyRound className="h-4 w-4 text-fg-muted" aria-hidden />
            Đổi mật khẩu
          </Link>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              void logout();
            }}
            className="flex w-full items-center gap-2.5 border-t border-border px-4 py-2.5 text-left text-[13.5px] font-medium text-danger transition-colors hover:bg-danger-tint"
          >
            <LogOut className="h-4 w-4" aria-hidden />
            Đăng xuất
          </button>
        </div>
      )}
    </div>
  );
}
