"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Card, CardContent, ErrorState, PageHeader, Textarea, cn } from "@/components/ui";
import { Sparkles, Send, Loader2, Trash2, Wrench, ShieldAlert, Check, X, BarChart3 } from "lucide-react";
import { fetchJsonWithTimeout } from "@/lib/api-client";

type ChatTurn = { role: "user" | "assistant"; content: string };
type ToolCallLogItem = { name: string; ok: boolean; truncated?: boolean };
type ProposalItem = { proposalId: string; action: string; humanReadablePreview: string; expiresAt: string };
type AnalysisCardItem = { toolName: string; data: unknown; source: { domains: string[]; asOf: string } };
type ChatResponse = {
  reply: string;
  toolCallLog: ToolCallLogItem[];
  proposals: ProposalItem[];
  analysisCards: AnalysisCardItem[];
  meta: { finishReason: string; iterations: number; usage: { promptTokens: number; completionTokens: number; totalTokens: number } };
};

type Message =
  | { id: string; role: "user"; content: string }
  | { id: string; role: "assistant"; content: string; toolCallLog: ToolCallLogItem[]; proposals: ProposalItem[]; analysisCards: AnalysisCardItem[]; meta: ChatResponse["meta"] }
  | { id: string; role: "error"; content: string };

type ProposalUiState =
  | { status: "pending" }
  | { status: "executing" }
  | { status: "executed"; resultRef: Record<string, unknown> }
  | { status: "cancelling" }
  | { status: "cancelled" }
  | { status: "error"; message: string };

const STARTER_GROUPS: { label: string; questions: string[] }[] = [
  {
    label: "TRA CỨU",
    questions: ["Hiện có bao nhiêu lao động đang làm việc?", "Ai chưa có mã vân tay (IT Code)?"],
  },
  {
    label: "PHÂN TÍCH",
    questions: ["Bộ phận nào đang thiếu người nhiều nhất?", "So sánh nhu cầu tuyển dụng năm nay với năm trước.", "Bộ phận nào có rủi ro thiếu người?"],
  },
  {
    label: "HÀNH ĐỘNG",
    questions: ["Chuẩn bị một Yêu cầu tuyển dụng."],
  },
];

function uid() {
  return Math.random().toString(36).slice(2);
}

export default function AiAssistantPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [lastFailedQuestion, setLastFailedQuestion] = useState<string | null>(null);
  const [proposalStates, setProposalStates] = useState<Record<string, ProposalUiState>>({});
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && typeof el.scrollTo === "function") el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  const send = useCallback(
    async (question: string) => {
      const trimmed = question.trim();
      if (!trimmed || loading) return;
      setInput("");
      setLastFailedQuestion(null);
      const userMsg: Message = { id: uid(), role: "user", content: trimmed };
      const history: ChatTurn[] = [...messages, userMsg]
        .filter((m): m is Extract<Message, { role: "user" | "assistant" }> => m.role === "user" || m.role === "assistant")
        .slice(-8)
        .map((m) => ({ role: m.role, content: m.content }));
      setMessages((prev) => [...prev, userMsg]);
      setLoading(true);
      const result = await fetchJsonWithTimeout<ChatResponse>("/api/ai-copilot/chat", {
        timeoutMs: 30_000,
        init: { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: trimmed, history: history.slice(0, -1) }) },
      });
      setLoading(false);
      if (result.ok) {
        const proposals = result.data.proposals ?? [];
        const analysisCards = result.data.analysisCards ?? [];
        setMessages((prev) => [
          ...prev,
          { id: uid(), role: "assistant", content: result.data.reply, toolCallLog: result.data.toolCallLog ?? [], proposals, analysisCards, meta: result.data.meta },
        ]);
        if (proposals.length > 0) {
          setProposalStates((prev) => {
            const next = { ...prev };
            for (const p of proposals) next[p.proposalId] = { status: "pending" };
            return next;
          });
        }
      } else {
        setLastFailedQuestion(trimmed);
        const message = (result.body?.error as string | undefined) ?? result.message ?? "Trợ lý AI hiện không khả dụng.";
        setMessages((prev) => [...prev, { id: uid(), role: "error", content: message }]);
      }
    },
    [messages, loading],
  );

  const handleRetry = useCallback(() => {
    if (lastFailedQuestion) {
      setMessages((prev) => prev.filter((m) => m.role !== "error"));
      void send(lastFailedQuestion);
    }
  }, [lastFailedQuestion, send]);

  const handleClear = useCallback(() => {
    setMessages([]);
    setLastFailedQuestion(null);
    setProposalStates({});
  }, []);

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
          messages.length > 0 ? (
            <Button variant="outline" size="sm" onClick={handleClear}>
              <Trash2 className="h-4 w-4" aria-hidden /> Xoá hội thoại
            </Button>
          ) : null
        }
      />

      <Card className="flex min-h-0 flex-1 flex-col">
        <CardContent className="flex min-h-0 flex-1 flex-col p-0">
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
                <MessageBubble
                  key={m.id}
                  message={m}
                  onRetry={m.role === "error" ? handleRetry : undefined}
                  proposalStates={proposalStates}
                  onConfirmProposal={handleConfirmProposal}
                  onCancelProposal={handleCancelProposal}
                />
              ))
            )}
            {loading ? (
              <div className="flex items-center gap-2 text-[13px] text-fg-muted">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Đang tra cứu dữ liệu...
              </div>
            ) : null}
          </div>

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
      </Card>
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
          <ProposalCard
            key={p.proposalId}
            proposal={p}
            state={proposalStates[p.proposalId] ?? { status: "pending" }}
            onConfirm={() => onConfirmProposal(p.proposalId)}
            onCancel={() => onCancelProposal(p.proposalId)}
          />
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
