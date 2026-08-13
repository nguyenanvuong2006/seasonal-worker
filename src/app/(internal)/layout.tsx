import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getPublicBranding } from "@/lib/branding";
import { Sidebar } from "@/components/sidebar";
import { AppHeader } from "@/components/app-header";

export const dynamic = "force-dynamic";

export default async function InternalLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login");

  const branding = await getPublicBranding();

  return (
    <div className="flex min-h-screen bg-bg">
      <Sidebar session={session} branding={branding} />
      <div className="flex min-w-0 flex-1 flex-col">
        <AppHeader session={session} branding={branding} />
        <main className="mx-auto w-full max-w-[1400px] flex-1 p-4 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
