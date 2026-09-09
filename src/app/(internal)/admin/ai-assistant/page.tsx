import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import AiAssistantClient from "./ai-assistant-client";

/**
 * Server wrapper (repo convention — see admin/document-merge/page.tsx):
 * only checks authentication here. The real security boundary for
 * ai_copilot.view is the API (every /api/ai-copilot/* route calls
 * requirePermission) — menu visibility (nav-config.ts) is UX, not this
 * boundary either. The client component itself renders a clear
 * permission-denied state (not a broken/functional-looking chat) the
 * moment its first API call comes back 403, so a user without
 * ai_copilot.view who navigates here directly gets no functional AI
 * access even though this wrapper does not duplicate the permission
 * check server-side.
 */
export default async function AiAssistantPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  return <AiAssistantClient />;
}
