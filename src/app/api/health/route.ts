import { db } from "@/db";
import { sql } from "drizzle-orm";
import { ensureSeed, tablesReady } from "@/lib/seed";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await db.execute(sql`select 1`);
    if (await tablesReady()) await ensureSeed();
    return Response.json({ ok: true });
  } catch {
    return Response.json({ ok: false }, { status: 500 });
  }
}
