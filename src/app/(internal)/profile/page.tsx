import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { departments, users } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import { ProfileView } from "@/components/profile-view";

export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const [row] = await db
    .select({
      id: users.id,
      username: users.username,
      fullName: users.fullName,
      role: users.role,
      deptId: users.deptId,
      deptName: departments.deptName,
      isActive: users.isActive,
      createdAt: users.createdAt,
    })
    .from(users)
    .leftJoin(departments, eq(users.deptId, departments.id))
    .where(eq(users.id, session.id))
    .limit(1);

  if (!row) redirect("/login");

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader title="Hồ sơ cá nhân" description="Xem thông tin tài khoản và đổi mật khẩu của bạn." />
      <ProfileView profile={{ ...row, createdAt: row.createdAt.toISOString() }} />
    </div>
  );
}
