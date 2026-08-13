import { NextResponse } from "next/server";
import { getPublicBranding } from "@/lib/branding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Công khai — dùng cho màn hình login (chưa đăng nhập). Chỉ trả nội dung KHÔNG nhạy cảm. */
export async function GET() {
  const branding = await getPublicBranding();
  return NextResponse.json(branding);
}
