import { NextResponse } from "next/server";
import { requirePermission, writeAudit } from "@/lib/auth";
import { getOwnedConversation, listMessages, softDeleteConversation } from "@/lib/ai-copilot/conversations.ts";
import { getProposalSummaries } from "@/lib/ai-copilot/proposals.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROLES = ["ADMIN", "HR_RECRUITER", "DEPT_MANAGER", "HR_DIRECTOR"] as const;

/**
 * Read one conversation's messages — OWNERSHIP-CHECKED, not just
 * permission-checked. A user with ai_copilot.view (even an ADMIN with
 * unrestricted workforce Data Scope) can NEVER read another user's
 * conversation by guessing/reusing its id: listMessages() re-verifies
 * `user_id = guard.session.id` itself. A conversation that exists but
 * belongs to someone else returns the SAME 404 as one that doesn't exist
 * at all — never a distinguishing 403, which would leak existence.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission([...ROLES], "ai_copilot.view");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const { id } = await params;
  const owned = await getOwnedConversation(id, guard.session.id);
  if (!owned) return NextResponse.json({ error: "Không tìm thấy cuộc trò chuyện." }, { status: 404 });

  const messages = await listMessages(id, guard.session.id);
  const dtos = await Promise.all(
    messages.map(async (m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      toolCallLog: m.toolCallLog ?? [],
      analysisCards: m.analysisCards ?? [],
      proposals: m.proposalRefs && m.proposalRefs.length > 0 ? await getProposalSummaries(m.proposalRefs) : [],
      createdAt: m.createdAt,
    })),
  );
  return NextResponse.json({ conversation: { id: owned.id, title: owned.title, createdAt: owned.createdAt }, messages: dtos });
}

/**
 * Explicit, deliberate delete — soft delete (status=DELETED), never a side
 * effect of "start a new conversation". Ownership-checked the same way as
 * GET: softDeleteConversation()'s own WHERE clause includes user_id, so a
 * non-owner's delete attempt matches zero rows and reports 404, never
 * silently succeeding on someone else's data.
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePermission([...ROLES], "ai_copilot.view");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const { id } = await params;
  const deleted = await softDeleteConversation(id, guard.session.id);
  if (!deleted) return NextResponse.json({ error: "Không tìm thấy cuộc trò chuyện." }, { status: 404 });

  await writeAudit(guard.session, "AI_CONVERSATION_DELETED", "ai_copilot", { conversationId: id }, "API");
  return NextResponse.json({ ok: true });
}
