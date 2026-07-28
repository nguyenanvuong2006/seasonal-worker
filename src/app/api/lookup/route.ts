import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { dailyApplications, departments, dwData } from "@/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const cccd = (url.searchParams.get("cccd") || "").replace(/\D/g, "");

  if (!/^\d{9,12}$/.test(cccd)) {
    return NextResponse.json({ error: "CCCD phải chứa 9 - 12 chữ số." }, { status: 400 });
  }

  const [worker] = await db.select().from(dwData).where(eq(dwData.cccd, cccd)).limit(1);

  const history = await db
    .select({
      id: dailyApplications.id,
      regDate: dailyApplications.regDate,
      status: dailyApplications.status,
      fullName: dailyApplications.fullName,
      deptName: departments.deptName,
      groupName: departments.groupName,
      vnName: departments.vnName,
      supervisor: departments.supervisor,
      supervisorPhone: departments.supervisorPhone,
      startingDate: dailyApplications.startingDate,
      noteWorker: dailyApplications.noteWorker,
    })
    .from(dailyApplications)
    .leftJoin(departments, eq(dailyApplications.deptId, departments.id))
    .where(eq(dailyApplications.cccd, cccd))
    .orderBy(desc(dailyApplications.regDate))
    .limit(30);

  if (!worker && history.length === 0) {
    return NextResponse.json(
      { error: "Không tìm thấy hồ sơ nào với số CCCD này." },
      { status: 404 },
    );
  }

  return NextResponse.json({
    worker: worker
      ? {
          fullName: worker.fullName,
          code: worker.code,
          phone: worker.phone,
          isVerified: true,
        }
      : {
          fullName: history[0]?.fullName ?? "",
          code: null,
          isVerified: false,
        },
    history,
  });
}
