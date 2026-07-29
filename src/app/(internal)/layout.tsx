import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { Sidebar } from "@/components/sidebar";

export const dynamic = "force-dynamic";

export default async function InternalLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login");

  return (
    <div className="min-h-screen bg-gray-50">
      <Sidebar session={session} />
      <div className="lg:pl-[296px]">
        <main className="p-4 pt-16 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
