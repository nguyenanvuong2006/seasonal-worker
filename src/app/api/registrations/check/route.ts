import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { dailyApplications, departments } from "@/db/schema";
import { matchDwWorker } from "@/lib/matching";
import { todayStr } from "@/lib/helpers";
import { normalizePersonName } from "@/lib/person-name";
import { CCCD_ERROR_MESSAGE, isValidCccd } from "@/lib/validators";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const cccd = String(body.cccd ?? "").trim();
    const phone = String(body.phone ?? "").replace(/\D/g, "");

    if (!isValidCccd(cccd)) {
      return NextResponse.json({ error: CCCD_ERROR_MESSAGE }, { status: 400 });
    }
    if (!/^\d{9,11}$/.test(phone)) {
      return NextResponse.json({ error: "Số điện thoại không hợp lệ." }, { status: 400 });
    }

    const today = todayStr();

    // 1. Chặn trùng trong ngày
    // P0-3 (Production Hardening Audit) — chỉ trả field frontend (applicant-portal.tsx) thực sự
    // hiển thị: họ tên/trạng thái/tên bộ phận/địa điểm. KHÔNG trả `supervisor`/`supervisor_phone`
    // (SĐT cá nhân người phụ trách bộ phận — không cần thiết cho luồng tự tra cứu công khai).
    const [app] = await db
      .select({
        fullName: dailyApplications.fullName,
        status: dailyApplications.status,
        deptName: departments.deptName,
        groupName: departments.groupName,
        vnName: departments.vnName,
      })
      .from(dailyApplications)
      .leftJoin(departments, eq(dailyApplications.deptId, departments.id))
      .where(and(eq(dailyApplications.cccd, cccd), eq(dailyApplications.regDate, today)))
      .limit(1);

    if (app) {
      return NextResponse.json({
        status: "ALREADY_REGISTERED_TODAY",
        reg: {
          full_name: normalizePersonName(app.fullName),
          status: app.status,
          dept_name: app.deptName
            ? `${app.deptName}${app.groupName ? " — " + app.groupName : ""}`
            : null,
          dept_location: app.vnName,
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
      // Chỉ trả field frontend dùng để auto-fill xác nhận (họ tên + địa chỉ hiện tại) — KHÔNG
      // trả gender/DOB/SĐT/mã nhân viên/địa chỉ thô: /api/registrations (bước xác nhận cuối)
      // tự đối chiếu lại DW Data từ server, không phụ thuộc dữ liệu client echo lại.
      return NextResponse.json({
        status: "RETURNING_VERIFIED",
        confidence: match.confidence,
        worker: {
          full_name: normalizePersonName(match.worker!.fullName),
          address_current: match.worker!.residentialAddress || match.worker!.permanentAddress || null,
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
