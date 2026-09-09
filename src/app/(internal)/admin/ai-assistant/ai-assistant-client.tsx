"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Button, Card, CardContent, ErrorState, PageHeader, Textarea, cn } from "@/components/ui";
import { Sparkles, Send, Loader2, Plus, History, Trash2, Wrench, ShieldAlert, Check, X, BarChart3 } from "lucide-react";
import { fetchJsonWithTimeout } from "@/lib/api-client";

type ToolCallLogItem = { name: string; ok: boolean; truncated?: boolean };
type ProposalItem = { proposalId: string; action: string; humanReadablePreview: string; expiresAt: string; status?: string; executionResult?: Record<string, unknown> | null; errorMessage?: string | null };
type AnalysisCardItem = { toolName: string; data: unknown; source: { domains: string[]; asOf: string } };
type ChatResponse = {
  conversationId: string;
  reply: string;
  toolCallLog: ToolCallLogItem[];
  proposals: ProposalItem[];
  analysisCards: AnalysisCardItem[];
  meta: { finishReason: string; iterations: number; usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null };
};
type ConversationSummary = { id: string; title: string | null; createdAt: string; updatedAt: string; lastMessageAt: string };
type RestoredMessage = { id: string; role: "USER" | "ASSISTANT"; content: string; toolCallLog: ToolCallLogItem[]; analysisCards: AnalysisCardItem[]; proposals: ProposalItem[]; createdAt: string };

type Message =
  | { id: string; role: "user"; content: string }
  | { id: string; role: "assistant"; content: string; toolCallLog: ToolCallLogItem[]; proposals: ProposalItem[]; analysisCards: AnalysisCardItem[] }
  | { id: string; role: "error"; content: string };

type ProposalUiState =
  | { status: "pending" }
  | { status: "executing" }
  | { status: "executed"; resultRef: Record<string, unknown> }
  | { status: "cancelling" }
  | { status: "cancelled" }
  | { status: "expired" }
  | { status: "error"; message: string };

const STARTER_GROUPS: { label: string; questions: string[] }[] = [
  { label: "TRA CỨU", questions: ["Hiện có bao nhiêu lao động đang làm việc?", "Ai chưa có mã vân tay (IT Code)?"] },
  { label: "PHÂN TÍCH", questions: ["Bộ phận nào đang thiếu người nhiều nhất?", "So sánh nhu cầu tuyển dụng năm nay với năm trước.", "Bộ phận nào có rủi ro thiếu người?"] },
  { label: "HÀNH ĐỘNG", questions: ["Chuẩn bị một Yêu cầu tuyển dụng."] },
];

function uid() {
  return Math.random().toString(36).slice(2);
}

function newClientMessageId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now()}-${uid()}-${uid()}`;
}

/** Initial UI state for a restored/fresh proposal, derived from the proposal's own persisted status — never guessed. */
function initialProposalUiState(p: ProposalItem): ProposalUiState {
  const status = p.status ?? "PENDING";
  if (status === "EXECUTED") return { status: "executed", resultRef: p.executionResult ?? {} };
  if (status === "CANCELLED") return { status: "cancelled" };
  if (status === "EXPIRED") return { status: "expired" };
  if (status === "FAILED") return { status: "error", message: p.errorMessage ?? "Hành động thất bại." };
  if (status === "PENDING" && new Date(p.expiresAt).getTime() <= Date.now()) return { status: "expired" };
  return { status: "pending" };
}

function isToday(iso: string): boolean {
  const d = new Date(iso);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

export default function AiAssistantClient() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [initializing, setInitializing] = useState(true);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [conversationLoading, setConversationLoading] = useState(false);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [lastFailed, setLastFailed] = useState<{ question: string; clientMessageId: string } | null>(null);
  const [proposalStates, setProposalStates] = useState<Record<string, ProposalUiState>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  const didInit = useRef(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && typeof el.scrollTo === "function") el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  const updateUrlConversation = useCallback(
    (id: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      if (id) params.set("conversation", id);
      else params.delete("conversation");
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const applyRestoredMessages = useCallback((restored: RestoredMessage[]) => {
    const nextMessages: Message[] = restored.map((m) =>
      m.role === "USER"
        ? { id: m.id, role: "user", content: m.content }
        : { id: m.id, role: "assistant", content: m.content, toolCallLog: m.toolCallLog, proposals: m.proposals, analysisCards: m.analysisCards },
    );
    setMessages(nextMessages);
    const nextProposalStates: Record<string, ProposalUiState> = {};
    for (const m of restored) {
      for (const p of m.proposals) nextProposalStates[p.proposalId] = initialProposalUiState(p);
    }
    setProposalStates(nextProposalStates);
  }, []);

  const loadConversation = useCallback(
    async (id: string, options?: { syncUrl?: boolean }) => {
      setConversationLoading(true);
      const result = await fetchJsonWithTimeout<{ conversation: { id: string; title: string | null }; messages: RestoredMessage[] }>(`/api/ai-copilot/conversations/${id}`, {
        timeoutMs: 15_000,
      });
      setConversationLoading(false);
      if (!result.ok) {
        // Not found / not owned — fall back to a blank conversation rather than an error state.
        setConversationId(null);
        setMessages([]);
        setProposalStates({});
        if (options?.syncUrl) updateUrlConversation(null);
        return;
      }
      setConversationId(id);
      applyRestoredMessages(result.data.messages);
      if (options?.syncUrl) updateUrlConversation(id);
    },
    [applyRestoredMessages, updateUrlConversation],
  );

  // Restore-on-mount: prefer ?conversation=<id> if it's actually the user's own, else the most recently active one.
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    void (async () => {
      const listResult = await fetchJsonWithTimeout<{ conversations: ConversationSummary[] }>("/api/ai-copilot/conversations");
      if (!listResult.ok) {
        if (listResult.code === "FORBIDDEN" || listResult.status === 403) setPermissionDenied(true);
        setInitializing(false);
        return;
      }
      setConversations(listResult.data.conversations);
      const requested = searchParams.get("conversation");
      const known = requested ? listResult.data.conversations.find((c) => c.id === requested) : undefined;
      const target = known?.id ?? listResult.data.conversations[0]?.id ?? null;
      if (target) {
        await loadConversation(target, { syncUrl: requested !== target });
      } else if (requested) {
        updateUrlConversation(null);
      }
      setInitializing(false);
    })();
    // Only ever runs once, on mount — loadConversation/updateUrlConversation are stable enough for this one-shot effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshConversationList = useCallback(async () => {
    const result = await fetchJsonWithTimeout<{ conversations: ConversationSummary[] }>("/api/ai-copilot/conversations");
    if (result.ok) setConversations(result.data.conversations);
  }, []);

  const send = useCallback(
    async (question: string, retryClientMessageId?: string) => {
      const trimmed = question.trim();
      if (!trimmed || loading) return;
      const clientMessageId = retryClientMessageId ?? newClientMessageId();
      setInput("");
      setLastFailed(null);
      const userMsg: Message = { id: uid(), role: "user", content: trimmed };
      setMessages((prev) => [...prev, userMsg]);
      setLoading(true);
      const result = await fetchJsonWithTimeout<ChatResponse>("/api/ai-copilot/chat", {
        timeoutMs: 30_000,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: trimmed, conversationId, clientMessageId }),
        },
      });
      setLoading(false);
      if (result.ok) {
        const proposals = result.data.proposals ?? [];
        const analysisCards = result.data.analysisCards ?? [];
        setMessages((prev) => [...prev, { id: uid(), role: "assistant", content: result.data.reply, toolCallLog: result.data.toolCallLog ?? [], proposals, analysisCards }]);
        if (proposals.length > 0) {
          setProposalStates((prev) => {
            const next = { ...prev };
            for (const p of proposals) next[p.proposalId] = initialProposalUiState(p);
            return next;
          });
        }
        if (!conversationId || conversationId !== result.data.conversationId) {
          setConversationId(result.data.conversationId);
          updateUrlConversation(result.data.conversationId);
          void refreshConversationList();
        } else {
          void refreshConversationList();
        }
      } else {
        setLastFailed({ question: trimmed, clientMessageId });
        const message = (result.body?.error as string | undefined) ?? result.message ?? "Trợ lý AI hiện không khả dụng.";
        setMessages((prev) => [...prev, { id: uid(), role: "error", content: message }]);
      }
    },
    [conversationId, loading, refreshConversationList, updateUrlConversation],
  );

  const handleRetry = useCallback(() => {
    if (lastFailed) {
      setMessages((prev) => prev.filter((m) => m.role !== "error"));
      void send(lastFailed.question, lastFailed.clientMessageId);
    }
  }, [lastFailed, send]);

  const handleNewConversation = useCallback(() => {
    setMessages([]);
    setLastFailed(null);
    setProposalStates({});
    setConversationId(null);
    updateUrlConversation(null);
    setHistoryOpen(false);
  }, [updateUrlConversation]);

  const handleSelectConversation = useCallback(
    async (id: string) => {
      setHistoryOpen(false);
      if (id === conversationId) return;
      await loadConversation(id, { syncUrl: true });
    },
    [conversationId, loadConversation],
  );

  const handleDeleteConversation = useCallback(
    async (id: string) => {
      if (!window.confirm("Xoá vĩnh viễn cuộc trò chuyện này? Hành động này không thể hoàn tác.")) return;
      const result = await fetchJsonWithTimeout(`/api/ai-copilot/conversations/${id}`, { init: { method: "DELETE" } });
      if (result.ok) {
        setConversations((prev) => prev.filter((c) => c.id !== id));
        if (id === conversationId) handleNewConversation();
      }
    },
    [conversationId, handleNewConversation],
  );

  const handleConfirmProposal = useCallback(async (proposalId: string) => {
    setProposalStates((prev) => ({ ...prev, [proposalId]: { status: "executing" } }));
    const result = await fetchJsonWithTimeout<{ resultRef: Record<string, unknown> }>(`/api/ai-copilot/action/${proposalId}/execute`, {
      timeoutMs: 20_000,
      init: { method: "POST" },
    });
    if (result.ok) {
      setProposalStates((prev) => ({ ...prev, [proposalId]: { status: "executed", resultRef: result.data.resultRef ?? {} } }));
    } else {
      const message = (result.body?.error as string | undefined) ?? result.message ?? "Không thể thực hiện hành động.";
      setProposalStates((prev) => ({ ...prev, [proposalId]: { status: "error", message } }));
    }
  }, []);

  const handleCancelProposal = useCallback(async (proposalId: string) => {
    setProposalStates((prev) => ({ ...prev, [proposalId]: { status: "cancelling" } }));
    const result = await fetchJsonWithTimeout(`/api/ai-copilot/action/${proposalId}/cancel`, { timeoutMs: 10_000, init: { method: "POST" } });
    if (result.ok) {
      setProposalStates((prev) => ({ ...prev, [proposalId]: { status: "cancelled" } }));
    } else {
      const message = (result.body?.error as string | undefined) ?? result.message ?? "Không thể hủy đề xuất.";
      setProposalStates((prev) => ({ ...prev, [proposalId]: { status: "error", message } }));
    }
  }, []);

  if (permissionDenied) {
    return (
      <div className="mx-auto flex h-[calc(100vh-6rem)] max-w-3xl flex-col items-center justify-center px-4 text-center">
        <ShieldAlert className="mb-3 h-10 w-10 text-fg-muted" aria-hidden />
        <h1 className="text-lg font-semibold text-fg">Bạn không có quyền sử dụng Trợ lý AI</h1>
        <p className="mt-2 max-w-[42ch] text-[13.5px] text-fg-secondary">Liên hệ Quản trị viên để được cấp quyền &quot;Trợ lý AI&quot; nếu bạn cần sử dụng chức năng này.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-[calc(100vh-6rem)] max-w-3xl flex-col px-4 pb-4 pt-6 sm:px-6">
      <PageHeader
        title="Trợ lý AI Workforce"
        description="Hỏi về nhân lực, nhu cầu, tuyển dụng và vận hành."
        eyebrow={
          <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-accent">
            <Sparkles className="h-3.5 w-3.5" aria-hidden /> AI Assistant
          </span>
        }
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setHistoryOpen(true)}>
              <History className="h-4 w-4" aria-hidden /> Lịch sử
            </Button>
            <Button variant="outline" size="sm" onClick={handleNewConversation}>
              <Plus className="h-4 w-4" aria-hidden /> Cuộc trò chuyện mới
            </Button>
          </div>
        }
      />

      <Card className="relative flex min-h-0 flex-1 flex-col">
        <CardContent className="flex min-h-0 flex-1 flex-col p-0">
          {initializing || conversationLoading ? (
            <div className="flex flex-1 items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-fg-muted" aria-hidden />
            </div>
          ) : (
            <div ref={scrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-5">
              {messages.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-4 py-10 text-center">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-accent-tint text-accent">
                    <Sparkles className="h-6 w-6" aria-hidden />
                  </div>
                  <p className="max-w-[38ch] text-[13.5px] leading-relaxed text-fg-secondary">
                    Đặt câu hỏi về nhân lực, nhu cầu tuyển dụng, vân tay, hoặc trạng thái xác nhận hồ sơ điện tử. Trợ lý chỉ trả lời bằng dữ liệu thật, trong phạm vi bạn được phép xem.
                  </p>
                  <div className="w-full space-y-3">
                    {STARTER_GROUPS.map((group) => (
                      <div key={group.label}>
                        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">{group.label}</div>
                        <div className="flex flex-wrap justify-center gap-2">
                          {group.questions.map((q) => (
                            <button
                              key={q}
                              type="button"
                              onClick={() => void send(q)}
                              className="rounded-full border border-border-strong bg-surface-raised px-3 py-1.5 text-[12.5px] text-fg-secondary transition-colors hover:border-accent hover:text-accent"
                            >
                              {q}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                messages.map((m) => (
                  <MessageBubble key={m.id} message={m} onRetry={m.role === "error" ? handleRetry : undefined} proposalStates={proposalStates} onConfirmProposal={handleConfirmProposal} onCancelProposal={handleCancelProposal} />
                ))
              )}
              {loading ? (
                <div className="flex items-center gap-2 text-[13px] text-fg-muted">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  Đang tra cứu dữ liệu...
                </div>
              ) : null}
            </div>
          )}

          <form
            className="flex items-end gap-2 border-t border-border-subtle p-3 sm:p-4"
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
          >
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send(input);
                }
              }}
              placeholder="Nhập câu hỏi..."
              rows={1}
              maxLength={500}
              disabled={loading}
              className="max-h-32 resize-none"
            />
            <Button type="submit" disabled={loading || !input.trim()} loading={loading}>
              <Send className="h-4 w-4" aria-hidden />
              Gửi
            </Button>
          </form>
        </CardContent>

        {historyOpen ? (
          <HistoryPanel
            conversations={conversations}
            currentId={conversationId}
            onClose={() => setHistoryOpen(false)}
            onSelect={handleSelectConversation}
            onDelete={handleDeleteConversation}
          />
        ) : null}
      </Card>
    </div>
  );
}

function HistoryPanel({
  conversations,
  currentId,
  onClose,
  onSelect,
  onDelete,
}: {
  conversations: ConversationSummary[];
  currentId: string | null;
  onClose: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const today = conversations.filter((c) => isToday(c.lastMessageAt));
  const older = conversations.filter((c) => !isToday(c.lastMessageAt));

  const renderGroup = (label: string, items: ConversationSummary[]) => {
    if (items.length === 0) return null;
    return (
      <div key={label} className="mb-3">
        <p className="mb-1 px-1 text-[10.5px] font-bold uppercase tracking-wide text-fg-muted">{label}</p>
        <div className="space-y-0.5">
          {items.map((c) => (
            <div
              key={c.id}
              className={cn(
                "group flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[13px]",
                c.id === currentId ? "bg-accent-tint text-accent" : "text-fg-secondary hover:bg-surface-hover",
              )}
            >
              <button type="button" onClick={() => onSelect(c.id)} className="min-w-0 flex-1 truncate text-left">
                {c.title || "Cuộc trò chuyện mới"}
              </button>
              <button
                type="button"
                onClick={() => onDelete(c.id)}
                aria-label="Xoá cuộc trò chuyện"
                className="shrink-0 rounded p-1 text-fg-muted opacity-0 transition-opacity hover:bg-danger-tint hover:text-danger group-hover:opacity-100"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="absolute inset-0 z-20 flex sm:inset-y-0 sm:left-auto sm:right-0 sm:w-[280px]">
      <div className="flex-1 bg-fg/40 backdrop-blur-[1px] sm:hidden" onClick={onClose} aria-hidden />
      <div className="flex w-full flex-col border-l border-border-subtle bg-surface shadow-xl sm:w-[280px]">
        <div className="flex items-center justify-between border-b border-border-subtle p-3">
          <span className="text-[13px] font-semibold text-fg">Lịch sử trò chuyện</span>
          <button type="button" onClick={onClose} aria-label="Đóng lịch sử" className="rounded p-1 text-fg-muted hover:bg-surface-hover">
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {conversations.length === 0 ? (
            <p className="p-2 text-[12.5px] text-fg-muted">Chưa có cuộc trò chuyện nào.</p>
          ) : (
            <>
              {renderGroup("Hôm nay", today)}
              {renderGroup("Trước đó", older)}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  onRetry,
  proposalStates,
  onConfirmProposal,
  onCancelProposal,
}: {
  message: Message;
  onRetry?: () => void;
  proposalStates: Record<string, ProposalUiState>;
  onConfirmProposal: (proposalId: string) => void;
  onCancelProposal: (proposalId: string) => void;
}) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-accent px-4 py-2.5 text-[13.5px] leading-relaxed text-white">{message.content}</div>
      </div>
    );
  }
  if (message.role === "error") {
    return (
      <div className="flex justify-start">
        <div className="max-w-[85%]">
          <ErrorState title="Không thể trả lời" description={message.content} onRetry={onRetry} />
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] space-y-2">
        <div className="rounded-2xl rounded-bl-sm bg-surface-hover px-4 py-2.5 text-[13.5px] leading-relaxed text-fg">{message.content}</div>
        {message.toolCallLog.length > 0 ? (
          <div className={cn("flex flex-wrap items-center gap-1.5 px-1 text-[11px] text-fg-muted")}>
            <Wrench className="h-3 w-3" aria-hidden />
            <span>Nguồn dữ liệu:</span>
            {message.toolCallLog.map((t, i) => (
              <span
                key={`${t.name}-${i}`}
                className={cn("rounded-full px-2 py-0.5", t.ok ? "bg-success-tint text-success" : "bg-danger-tint text-danger")}
                title={t.truncated ? "Kết quả đã được rút gọn (danh sách lớn)" : undefined}
              >
                {t.name}
                {t.truncated ? " (rút gọn)" : ""}
              </span>
            ))}
          </div>
        ) : null}
        {message.analysisCards.map((c, i) => (
          <AnalysisCard key={`${c.toolName}-${i}`} card={c} />
        ))}
        {message.proposals.map((p) => (
          <ProposalCard key={p.proposalId} proposal={p} state={proposalStates[p.proposalId] ?? { status: "pending" }} onConfirm={() => onConfirmProposal(p.proposalId)} onCancel={() => onCancelProposal(p.proposalId)} />
        ))}
      </div>
    </div>
  );
}

function ProposalCard({ proposal, state, onConfirm, onCancel }: { proposal: ProposalItem; state: ProposalUiState; onConfirm: () => void; onCancel: () => void }) {
  const isPending = state.status === "pending";
  const isBusy = state.status === "executing" || state.status === "cancelling";
  return (
    <div className="rounded-xl border border-warning/30 bg-warning-tint/40 p-3.5">
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-warning">
        <ShieldAlert className="h-3.5 w-3.5" aria-hidden />
        Đề xuất hành động
      </div>
      <pre className="whitespace-pre-wrap font-sans text-[13px] leading-relaxed text-fg">{proposal.humanReadablePreview}</pre>

      {state.status === "executed" ? (
        <div className="mt-3 flex items-center gap-1.5 text-[12.5px] font-medium text-success">
          <Check className="h-4 w-4" aria-hidden /> Đã thực hiện thành công.
        </div>
      ) : state.status === "cancelled" ? (
        <div className="mt-3 flex items-center gap-1.5 text-[12.5px] font-medium text-fg-muted">
          <X className="h-4 w-4" aria-hidden /> Đã hủy đề xuất.
        </div>
      ) : state.status === "expired" ? (
        <div className="mt-3 text-[12.5px] font-medium text-fg-muted">Đề xuất đã hết hạn — hãy yêu cầu lại nếu vẫn cần.</div>
      ) : state.status === "error" ? (
        <div className="mt-3 space-y-2">
          <p className="text-[12.5px] font-medium text-danger">{state.message}</p>
          {isPending ? null : (
            <Button variant="outline" size="sm" onClick={onConfirm}>
              Thử lại
            </Button>
          )}
        </div>
      ) : (
        <div className="mt-3 flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onCancel} disabled={isBusy}>
            Hủy
          </Button>
          <Button size="sm" onClick={onConfirm} loading={state.status === "executing"} disabled={isBusy}>
            Xác nhận thực hiện
          </Button>
        </div>
      )}
    </div>
  );
}

const ANALYSIS_TOOL_LABELS: Record<string, string> = {
  compare_workforce_periods: "So sánh nhân lực theo kỳ",
  compare_demand_periods: "So sánh nhu cầu theo kỳ",
  compare_demand_years: "So sánh nhu cầu theo năm",
  get_workforce_gap_rankings: "Xếp hạng khoảng trống nhân lực",
  get_recruitment_gap_rankings: "Xếp hạng Recruitment Balance",
  get_workforce_trend: "Xu hướng nhân lực",
  get_demand_trend: "Xu hướng nhu cầu",
  get_movement_summary: "Tổng hợp thuyên chuyển / nghỉ việc",
  get_hiring_exit_summary: "Tổng hợp tuyển mới / nghỉ việc",
  get_department_risk_summary: "Đánh giá rủi ro thiếu người",
};

function riskBadgeClass(level: string) {
  if (level === "HIGH") return "bg-danger-tint text-danger";
  if (level === "MEDIUM") return "bg-warning-tint text-warning";
  return "bg-success-tint text-success";
}

function AnalysisCard({ card }: { card: AnalysisCardItem }) {
  const data = (card.data ?? {}) as Record<string, unknown>;
  const label = ANALYSIS_TOOL_LABELS[card.toolName] ?? card.toolName;
  return (
    <div className="rounded-xl border border-border-strong bg-surface-raised p-3.5">
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-accent">
        <BarChart3 className="h-3.5 w-3.5" aria-hidden />
        {label}
      </div>
      <div className="space-y-1.5 text-[13px] text-fg">{renderAnalysisBody(data)}</div>
      <div className="mt-3 border-t border-border-subtle pt-2 text-[11px] text-fg-muted">
        Nguồn: {card.source.domains.join(" · ") || "—"} · Dữ liệu đến: {card.source.asOf}
      </div>
    </div>
  );
}

function renderAnalysisBody(data: Record<string, unknown>) {
  if (Array.isArray(data.rankings)) {
    return (
      <ul className="space-y-1">
        {(data.rankings as Record<string, unknown>[]).slice(0, 10).map((r, i) => (
          <li key={i} className="flex items-center justify-between gap-2">
            <span className="truncate">{String(r.departmentName ?? r.departmentId ?? "—")}</span>
            <span className="font-semibold">{String(r.gap ?? r.total ?? "")}</span>
          </li>
        ))}
      </ul>
    );
  }
  if (Array.isArray(data.departments)) {
    return (
      <ul className="space-y-1">
        {(data.departments as Record<string, unknown>[]).slice(0, 10).map((d, i) => (
          <li key={i} className="flex items-center justify-between gap-2">
            <span className="truncate">{String(d.departmentName ?? d.departmentId ?? "—")}</span>
            <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-semibold", riskBadgeClass(String(d.level ?? "")))}>{String(d.level ?? "")}</span>
          </li>
        ))}
      </ul>
    );
  }
  if (Array.isArray(data.points)) {
    return (
      <ul className="space-y-1">
        {(data.points as Record<string, unknown>[]).slice(-8).map((p, i) => (
          <li key={i} className="flex items-center justify-between gap-2">
            <span>{String(p.label ?? p.bucket ?? "")}</span>
            <span className="font-semibold">{String(p.total ?? "")}</span>
          </li>
        ))}
      </ul>
    );
  }
  if (data.current && data.comparison && typeof data.current === "object" && typeof data.comparison === "object") {
    const current = data.current as Record<string, unknown>;
    const comparison = data.comparison as Record<string, unknown>;
    return (
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[10.5px] text-fg-muted">Kỳ hiện tại</div>
          <div className="text-[15px] font-semibold">{String(current.total ?? "")}</div>
        </div>
        <div>
          <div className="text-[10.5px] text-fg-muted">Kỳ so sánh</div>
          <div className="text-[15px] font-semibold text-fg-secondary">{String(comparison.total ?? "")}</div>
        </div>
        {typeof data.absoluteDifference === "number" ? (
          <div>
            <div className="text-[10.5px] text-fg-muted">Chênh lệch</div>
            <div className={cn("text-[15px] font-semibold", data.absoluteDifference >= 0 ? "text-success" : "text-danger")}>
              {data.absoluteDifference >= 0 ? "+" : ""}
              {data.absoluteDifference}
              {typeof data.percentDifference === "number" ? ` (${data.percentDifference >= 0 ? "+" : ""}${data.percentDifference}%)` : ""}
            </div>
          </div>
        ) : null}
      </div>
    );
  }
  const scalarEntries = Object.entries(data).filter(([, v]) => typeof v === "number" || typeof v === "string" || typeof v === "boolean");
  if (scalarEntries.length > 0) {
    return (
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {scalarEntries.slice(0, 9).map(([k, v]) => (
          <div key={k} className="rounded-lg bg-surface-hover px-2.5 py-1.5">
            <div className="truncate text-[10.5px] text-fg-muted">{k}</div>
            <div className="truncate text-[13.5px] font-semibold text-fg">{String(v)}</div>
          </div>
        ))}
      </div>
    );
  }
  return null;
}
