import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import DashboardWidgets from "@/components/dashboard-widgets";

export const dynamic = "force-dynamic";

function greeting(hour: number) {
  if (hour < 11) return "Chào buổi sáng";
  if (hour < 14) return "Chào buổi trưa";
  if (hour < 18) return "Chào buổi chiều";
  return "Chào buổi tối";
}

export default async function DashboardPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const hour = new Date().getHours();

  return (
    <div className="space-y-5">
      <PageHeader
        title={`${greeting(hour)}, ${session.fullName}`}
        description="Widget KPI/Table đọc dữ liệu qua Metadata Engine — thêm cột ở /admin/field-definitions sẽ tự có trên widget Table."
      />
      <DashboardWidgets />
    </div>
  );
}
