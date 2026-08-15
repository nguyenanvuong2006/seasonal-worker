import { NextResponse } from "next/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { dailyApplications, departments, dwData } from "@/db/schema";
import { isValidCccd, isValidPhone } from "@/lib/helpers";
import { normalizePersonName } from "@/lib/person-name";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NOT_FOUND = NextResponse.json(
  { error: "Không tìm thấy hồ sơ khớp với CCCD và số điện thoại đã nhập." },
  { status: 404 },
);

/**
 * P0-2 (Production Hardening Audit) — Tra cứu công khai, TRƯỚC ĐÂY chỉ cần CCCD là trả về
 * đầy đủ họ tên/SĐT/lịch sử/bộ phận/người phụ trách/SĐT người phụ trách/ghi chú nội bộ —
 * rủi ro PII nghiêm trọng vì CCCD không phải bí mật (dò được/đoán được). Nay bắt buộc CCCD +
 * SĐT cùng khớp 1 hồ sơ thật mới trả dữ liệu, và chỉ trả ĐÚNG những gì trang /lookup hiển thị
 * (không trả SĐT thật, không trả noteWorker nội bộ, không trả người phụ trách/SĐT người phụ
 * trách). Không phân biệt lý do thất bại (CCCD sai vs SĐT sai vs không tồn tại) để tránh dò
 * quét (enumeration) xem 1 CCCD có tồn tại trong hệ thống hay không.
 */
export async function POST(req: Request) {
  let body: { cccd?: string; phone?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Dữ liệu không hợp lệ." }, { status: 400 });
  }

  const cccd = String(body.cccd ?? "").trim();
  const phone = String(body.phone ?? "").replace(/\D/g, "");

  if (!isValidCccd(cccd) || !isValidPhone(phone)) {
    return NextResponse.json({ error: "Vui lòng nhập đúng CCCD và số điện thoại." }, { status: 400 });
  }
  const phoneTail = phone.slice(-9);

  // Xác minh danh tính: CCCD + phần số thuê bao cuối phải khớp ít nhất 1 nguồn dữ liệu thật (DW Data —
  // lao động cũ, HOẶC chính SĐT người đó đã khai khi đăng ký) — không chỉ dựa vào CCCD một mình.
  const [dwMatch] = await db
    .select({ fullName: dwData.fullName })
    .from(dwData)
    .where(and(eq(dwData.cccd, cccd), sql`${dwData.phone} LIKE ${"%" + phoneTail}`))
    .limit(1);

  const [appPhoneMatch] = await db
    .select({ id: dailyApplications.id })
    .from(dailyApplications)
    .where(and(eq(dailyApplications.cccd, cccd), sql`${dailyApplications.phone} LIKE ${"%" + phoneTail}`))
    .limit(1);

  if (!dwMatch && !appPhoneMatch) return NOT_FOUND;

  const history = await db
    .select({
      id: dailyApplications.id,
      regDate: dailyApplications.regDate,
      status: dailyApplications.status,
      fullName: dailyApplications.fullName,
      deptName: departments.deptName,
      groupName: departments.groupName,
      startingDate: dailyApplications.startingDate,
    })
    .from(dailyApplications)
    .leftJoin(departments, eq(dailyApplications.deptId, departments.id))
    .where(eq(dailyApplications.cccd, cccd))
    .orderBy(desc(dailyApplications.regDate))
    .limit(20);

  if (!dwMatch && history.length === 0) return NOT_FOUND;

  return NextResponse.json({
    worker: {
      fullName: normalizePersonName(dwMatch?.fullName ?? history[0]?.fullName ?? ""),
      isVerified: Boolean(dwMatch),
    },
    history: history.map((h) => ({
      id: h.id,
      regDate: h.regDate,
      status: h.status,
      deptName: h.deptName ? `${h.deptName}${h.groupName ? " — " + h.groupName : ""}` : null,
      startingDate: h.startingDate,
    })),
  });
}
