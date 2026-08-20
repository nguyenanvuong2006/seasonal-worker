/**
 * Archive Agent auth — Phase 12.
 * Agent dùng Bearer ARCHIVE_API_KEY (server-only env, không phải session user).
 * Admin (session) cũng được phép qua document_merge.history.view.
 */

import { requirePermission, type Session } from "@/lib/auth";
import { timingSafeEqual } from "node:crypto";

export type ArchiveAuthResult =
  | { ok: true; actor: "agent" | "admin"; session?: Session }
  | { ok: false; status: number; error: string };

export async function authenticateArchiveRequest(request: Request): Promise<ArchiveAuthResult> {
  const apiKey = process.env.ARCHIVE_API_KEY?.trim();
  if (apiKey) {
    const header = request.headers.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (token) {
      const a = Buffer.from(apiKey);
      const b = Buffer.from(token);
      if (a.length === b.length && timingSafeEqual(a, b)) {
        return { ok: true, actor: "agent" };
      }
    }
  }

  const guard = await requirePermission(["ADMIN"], "document_merge.history.view");
  if (!guard.ok) return { ok: false, status: guard.status, error: guard.error };
  return { ok: true, actor: "admin", session: guard.session };
}
