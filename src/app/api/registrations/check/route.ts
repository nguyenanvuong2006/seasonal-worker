import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { dailyApplications, departments } from "@/db/schema";
import { matchDwWorker } from "@/lib/matching";
import { todayStr } from "@/lib/helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const cccd = String(body.cccd ?? "").replace(/\D/g, "");
    const phone = String(body.phone ?? "").replace(/\D/g, "");

    if (!/^\d{9,12}$/.test(cccd)) {
      return NextResponse.json(
        { error: "Bắt buộc nhập CCCD/CMND hợp lệ (9 hoặc 12 số)." },
        { status: 400 },
      );
    }
    if (!/^\d{9,11}$/.test(phone)) {
      return NextResponse.json({ error: "Số điện thoại không hợp lệ." }, { status: 400 });
    }

    const today = todayStr();

    // 1. Chặn trùng trong ngày
    const [app] = await db
      .select({
        fullName: dailyApplications.fullName,
        status: dailyApplications.status,
        deptName: departments.deptName,
        groupName: departments.groupName,
        vnName: departments.vnName,
        supervisor: departments.supervisor,
        supervisorPhone: departments.supervisorPhone,
      })
      .from(dailyApplications)
      .leftJoin(departments, eq(dailyApplications.deptId, departments.id))
      .where(and(eq(dailyApplications.cccd, cccd), eq(dailyApplications.regDate, today)))
      .limit(1);

    if (app) {
      return NextResponse.json({
        status: "ALREADY_REGISTERED_TODAY",
        reg: {
          full_name: app.fullName,
          status: app.status,
          dept_name: app.deptName
            ? `${app.deptName}${app.groupName ? " — " + app.groupName : ""}`
            : null,
          vn_name: app.vnName,
          supervisor: app.supervisor,
          supervisor_phone: app.supervisorPhone,
        },
      });
    }

    // 2. Đối chiếu DW Data
    const match = await matchDwWorker({
      cccd,
      fullName: body.full_name,
      dob: body.dob,
      phone,
    });

    if (match.status === "MATCHED" && match.confidence === "CCCD") {
      return NextResponse.json({
        status: "RETURNING_VERIFIED",
        confidence: match.confidence,
        worker: {
          full_name: match.worker!.fullName,
          code: match.worker!.code,
          gender: match.worker!.gender,
          bod: match.worker!.bod,
          phone: match.worker!.phone,
          permanent_address: match.worker!.permanentAddress,
          residential_address: match.worker!.residentialAddress,
        },
      });
    }

    return NextResponse.json({ status: "NEW", confidence: match.confidence });
  } catch (error) {
    return NextResponse.json(
      { error: "Lỗi hệ thống: " + (error as Error).message },
      { status: 500 },
    );
  }
}
