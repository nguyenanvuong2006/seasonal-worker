import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/auth";
import { createConversation, listConversations } from "@/lib/ai-copilot/conversations.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROLES = ["ADMIN", "HR_RECRUITER", "DEPT_MANAGER", "HR_DIRECTOR"] as const;

/**
 * List the authenticated user's OWN AI Copilot conversations (most recently
 * active first) — used by the UI both to restore the most recent
 * conversation on mount and to render the conversation history panel.
 * Ownership is enforced inside listConversations() itself (WHERE user_id =
 * guard.session.id) — this route never accepts or trusts a userId param.
 */
export async function GET() {
  const guard = await requirePermission([...ROLES], "ai_copilot.view");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const conversations = await listConversations(guard.session.id);
  return NextResponse.json({
    conversations: conversations.map((c) => ({ id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, lastMessageAt: c.lastMessageAt })),
  });
}

/** Explicitly starts a new, blank conversation — "Cuộc trò chuyện mới". Never deletes or touches any prior conversation. */
export async function POST() {
  const guard = await requirePermission([...ROLES], "ai_copilot.view");
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const conversation = await createConversation(guard.session.id);
  return NextResponse.json({ id: conversation.id, title: conversation.title, createdAt: conversation.createdAt }, { status: 201 });
}
