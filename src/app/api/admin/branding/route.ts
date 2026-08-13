import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { brandingSettings } from "@/db/schema";
import { requireRoleAndPermission, writeAudit } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_SLOGAN_LENGTH = 160;
const MAX_SUBTITLE_LENGTH = 160;
// ~2.7MB base64 ≈ 2MB ảnh gốc — đủ cho 1 ảnh theme nén tốt, tránh phình bảng DB vì lưu base64.
const MAX_IMAGE_DATA_URL_LENGTH = 2_800_000;
const ALLOWED_IMAGE_MIME = ["image/png", "image/jpeg", "image/webp"];

async function ensureRow() {
  const [row] = await db.select().from(brandingSettings).where(eq(brandingSettings.id, "default")).limit(1);
  if (row) return row;
  const [created] = await db.insert(brandingSettings).values({ id: "default" }).returning();
  return created;
}

export async function GET() {
  const guard = await requireRoleAndPermission(["ADMIN"], "branding.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const row = await ensureRow();
  return NextResponse.json({ row });
}

export async function PATCH(req: Request) {
  const guard = await requireRoleAndPermission(["ADMIN"], "branding.manage");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const body = (await req.json()) as {
    yearThemeImage?: string | null;
    yearSlogan?: string | null;
    themeYear?: string | null;
    themeSubtitle?: string | null;
  };

  const patch: Record<string, unknown> = { updatedBy: guard.session.username, updatedAt: new Date() };

  if ("yearSlogan" in body) {
    const slogan = (body.yearSlogan ?? "").trim();
    if (slogan.length > MAX_SLOGAN_LENGTH) {
      return NextResponse.json({ error: `Slogan tối đa ${MAX_SLOGAN_LENGTH} ký tự.` }, { status: 400 });
    }
    patch.yearSlogan = slogan || null;
  }

  if ("themeYear" in body) {
    const year = (body.themeYear ?? "").trim();
    if (year && !/^\d{4}$/.test(year)) {
      return NextResponse.json({ error: "Năm chủ đề phải gồm 4 chữ số (vd: 2026)." }, { status: 400 });
    }
    patch.themeYear = year || null;
  }

  if ("themeSubtitle" in body) {
    const subtitle = (body.themeSubtitle ?? "").trim();
    if (subtitle.length > MAX_SUBTITLE_LENGTH) {
      return NextResponse.json({ error: `Phụ đề tối đa ${MAX_SUBTITLE_LENGTH} ký tự.` }, { status: 400 });
    }
    patch.themeSubtitle = subtitle || null;
  }

  if ("yearThemeImage" in body) {
    const image = body.yearThemeImage;
    if (image === null || image === "") {
      patch.yearThemeImage = null;
    } else if (typeof image === "string") {
      const mimeMatch = image.match(/^data:(image\/[a-z+]+);base64,/);
      if (!mimeMatch || !ALLOWED_IMAGE_MIME.includes(mimeMatch[1])) {
        return NextResponse.json({ error: "Ảnh phải là PNG, JPEG hoặc WEBP." }, { status: 400 });
      }
      if (image.length > MAX_IMAGE_DATA_URL_LENGTH) {
        return NextResponse.json({ error: "Ảnh quá lớn — vui lòng chọn ảnh dưới 2MB." }, { status: 400 });
      }
      patch.yearThemeImage = image;
    }
  }

  await ensureRow();
  const [row] = await db.update(brandingSettings).set(patch).where(eq(brandingSettings.id, "default")).returning();

  await writeAudit(guard.session, "UPDATE_BRANDING", "branding_settings", {
    changedFields: Object.keys(patch).filter((k) => k !== "updatedBy" && k !== "updatedAt"),
  });

  return NextResponse.json({ success: true, row });
}
