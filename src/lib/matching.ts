import "server-only";
import { db } from "@/db";
import { dwData } from "@/db/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { isValidCccd } from "@/lib/validators";

export type DwMatchResult = {
  status: "MATCHED" | "NEW";
  confidence: "CCCD" | "NAME_DOB" | "NAME_PHONE" | "NONE";
  worker: {
    id: string;
    code: string | null;
    fullName: string;
    gender: string | null;
    bod: string | null;
    cccd: string | null;
    phone: string | null;
    permanentAddress: string | null;
    residentialAddress: string | null;
  } | null;
};

/** Chuẩn hoá tên tiếng Việt để so khớp (bỏ dấu, gộp khoảng trắng, viết thường) */
export function normalizeName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/gi, "d")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function extractYear(v?: string | null): string | null {
  const m = String(v ?? "").match(/(19|20)\d{2}/);
  return m ? m[0] : null;
}

const EMPTY: DwMatchResult = { status: "NEW", confidence: "NONE", worker: null };

/**
 * Đối chiếu 3 tầng với sheet "DW Data" để xác định lao động CŨ hay MỚI.
 * CCCD phải đúng 12 chữ số trước khi thực hiện bất kỳ tầng đối chiếu nào.
 *  1. Khớp CCCD tuyệt đối          → confidence CCCD
 *  2. Khớp Họ tên + Năm sinh       → confidence NAME_DOB
 *  3. Khớp Họ tên + Số điện thoại  → confidence NAME_PHONE
 */
export async function matchDwWorker(input: {
  cccd: string;
  fullName?: string | null;
  dob?: string | null;
  phone?: string | null;
}): Promise<DwMatchResult> {
  const cccd = String(input.cccd ?? "").trim();
  if (!isValidCccd(cccd)) return EMPTY;

  const pick = (r: typeof dwData.$inferSelect) => ({
    id: r.id,
    code: r.code,
    fullName: r.fullName,
    gender: r.gender,
    bod: r.bod,
    cccd: r.cccd,
    phone: r.phone,
    permanentAddress: r.permanentAddress,
    residentialAddress: r.residentialAddress,
  });

  // Tầng 1 — CCCD tuyệt đối
  const [byCccd] = await db.select().from(dwData).where(and(eq(dwData.cccd, cccd), isNull(dwData.deletedAt))).limit(1);
  if (byCccd) return { status: "MATCHED", confidence: "CCCD", worker: pick(byCccd) };

  const nameNorm = normalizeName(input.fullName ?? "");
  if (!nameNorm) return EMPTY;

  const normSql = sql`lower(regexp_replace(translate(${dwData.fullName},
      'áàảãạăắằẳẵặâấầẩẫậéèẻẽẹêếềểễệíìỉĩịóòỏõọôốồổỗộơớờởỡợúùủũụưứừửữựýỳỷỹỵđÁÀẢÃẠĂẮẰẲẴẶÂẤẦẨẪẬÉÈẺẼẸÊẾỀỂỄỆÍÌỈĨỊÓÒỎÕỌÔỐỒỔỖỘƠỚỜỞỠỢÚÙỦŨỤƯỨỪỬỮỰÝỲỶỸỴĐ',
      'aaaaaaaaaaaaaaaaaeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyydAAAAAAAAAAAAAAAAAEEEEEEEEEEEIIIIIOOOOOOOOOOOOOOOOOUUUUUUUUUUUYYYYYD'
    ), '\\s+', ' ', 'g'))`;

  // Tầng 2 — Họ tên + Năm sinh
  const year = extractYear(input.dob);
  if (year) {
    const [byNameDob] = await db
      .select()
      .from(dwData)
      .where(and(sql`${normSql} = ${nameNorm}`, sql`${dwData.bod} LIKE ${"%" + year}`, isNull(dwData.deletedAt)))
      .limit(1);
    if (byNameDob) return { status: "MATCHED", confidence: "NAME_DOB", worker: pick(byNameDob) };
  }

  // Tầng 3 — Họ tên + SĐT
  const phone = String(input.phone ?? "").replace(/\D/g, "");
  if (phone.length >= 9) {
    const tail = phone.slice(-9);
    const [byNamePhone] = await db
      .select()
      .from(dwData)
      .where(and(sql`${normSql} = ${nameNorm}`, sql`${dwData.phone} LIKE ${"%" + tail}`, isNull(dwData.deletedAt)))
      .limit(1);
    if (byNamePhone)
      return { status: "MATCHED", confidence: "NAME_PHONE", worker: pick(byNamePhone) };
  }

  return EMPTY;
}

export const CONFIDENCE_LABEL: Record<string, string> = {
  CCCD: "Khớp CCCD tuyệt đối",
  NAME_DOB: "Khớp Họ tên + Năm sinh",
  NAME_PHONE: "Khớp Họ tên + SĐT",
  NONE: "Không tìm thấy trong DW Data",
};
