import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { dailyApplications, dwData } from "@/db/schema";
import { isValidCccd, isValidPhone } from "@/lib/helpers";

export type LookupIdentity =
  | { ok: false; status: 400 | 404; error: string }
  | {
      ok: true;
      cccd: string;
      phone: string;
      phoneTail: string;
      dwFullName: string | null;
    };

const NOT_FOUND_MESSAGE = "Không tìm thấy hồ sơ khớp với CCCD và số điện thoại đã nhập.";

/**
 * Shared identity check for public /lookup and /lookup/confirm.
 * Requires CCCD + phone tail to match DW Data or a daily_application row.
 * Does not distinguish "wrong CCCD" vs "wrong phone" (anti-enumeration).
 */
export async function verifyLookupIdentity(cccdRaw: unknown, phoneRaw: unknown): Promise<LookupIdentity> {
  const cccd = String(cccdRaw ?? "").trim();
  const phone = String(phoneRaw ?? "").replace(/\D/g, "");

  if (!isValidCccd(cccd) || !isValidPhone(phone)) {
    return { ok: false, status: 400, error: "Vui lòng nhập đúng CCCD và số điện thoại." };
  }

  const phoneTail = phone.slice(-9);

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

  if (!dwMatch && !appPhoneMatch) {
    return { ok: false, status: 404, error: NOT_FOUND_MESSAGE };
  }

  return {
    ok: true,
    cccd,
    phone,
    phoneTail,
    dwFullName: dwMatch?.fullName ?? null,
  };
}

export const LOOKUP_NOT_FOUND_MESSAGE = NOT_FOUND_MESSAGE;
