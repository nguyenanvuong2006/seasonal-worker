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

// Giờ chào phải theo giờ Việt Nam (Asia/Ho_Chi_Minh) chứ không phải giờ của server
// (Vercel serverless có thể chạy ở bất kỳ region/UTC nào) — dùng Intl.DateTimeFormat
// với timeZone cố định thay vì new Date().getHours() vốn đọc giờ local của server.
function hourInVietnam(): number {
  const hourStr = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour: "numeric",
    hour12: false,
  }).format(new Date());
  return Number(hourStr) % 24;
}

export default async function DashboardPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const hour = hourInVietnam();

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
