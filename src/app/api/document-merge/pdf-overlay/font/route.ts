/**
 * Document Merge — PDF Overlay visual mapper font asset (PR3, config UI helper).
 *
 * GET /api/document-merge/pdf-overlay/font
 * Trả bytes font nhúng (DejaVu Sans — OFL/Bitstream Vera, xem LICENSE-DejaVu.txt)
 * để client-side PREVIEW dùng pdf-lib + @pdf-lib/fontkit render mẫu trong-memory.
 *
 * PREVIEW chỉ vẽ trong trình duyệt trên DỮ LIỆU MẪU (sample-values.ts) — không
 * đọc Production candidate, không tạo merge job, không mutate Production.
 *
 * Font là asset tĩnh của repo (PR1). Route này KHÔNG liên quan tới renderer
 * production (renderer dùng font từ storage/fontBytes truyền vào).
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const guard = await requirePermission(["ADMIN", "HR_RECRUITER"], "document_merge.templates.manage");
  if (!guard.ok) {
    return NextResponse.json({ error: guard.error }, { status: guard.status });
  }
  try {
    const fontPath = path.join(
      process.cwd(),
      "src/lib/document-merge/pdf-overlay/fonts/DejaVuSans.ttf",
    );
    const bytes = await readFile(fontPath);
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": "font/ttf",
        "Content-Length": String(bytes.byteLength),
        "Cache-Control": "private, max-age=600",
      },
    });
  } catch (error) {
    console.error("[document-merge/pdf-overlay/font] error:", error);
    return NextResponse.json({ error: "Không đọc được font preview." }, { status: 500 });
  }
}
