import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { brandingSettings } from "@/db/schema";

export type PublicBranding = {
  yearThemeImage: string | null;
  yearSlogan: string | null;
  themeYear: string | null;
  themeSubtitle: string | null;
};

/** Nội dung KHÔNG nhạy cảm — an toàn hiển thị ở màn hình login (chưa đăng nhập). */
export async function getPublicBranding(): Promise<PublicBranding> {
  try {
    const [row] = await db.select().from(brandingSettings).where(eq(brandingSettings.id, "default")).limit(1);
    return {
      yearThemeImage: row?.yearThemeImage ?? null,
      yearSlogan: row?.yearSlogan ?? null,
      themeYear: row?.themeYear ?? null,
      themeSubtitle: row?.themeSubtitle ?? null,
    };
  } catch {
    // Bảng chưa tồn tại (chưa chạy migration) hoặc DB lỗi — không được làm sập trang login.
    return { yearThemeImage: null, yearSlogan: null, themeYear: null, themeSubtitle: null };
  }
}
