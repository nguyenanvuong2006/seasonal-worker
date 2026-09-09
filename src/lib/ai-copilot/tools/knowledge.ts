import "server-only";
import { getUserScope } from "@/lib/auth";
import { getKnowledgeProvider, type KnowledgeSearchResult } from "../knowledge-provider.ts";
import type { ToolContext, ToolDefinition, ToolResult } from "../types.ts";
import { ToolExecutionError } from "../types.ts";

/**
 * Domain: Knowledge/RAG foundation (Phase 4). This is the ONLY tool that
 * ever touches KnowledgeProvider — every other tool in tools/*.ts answers
 * from Postgres. A question needing both (e.g. "Harvesting đang thiếu 20
 * người; theo quy trình tôi phải làm gì?") calls this tool AND a
 * structured tool in the same turn; the model must never treat this
 * tool's output as a source for an operational number (see
 * system-prompt.ts's Phase 4 rules).
 */

const search_knowledge_base: ToolDefinition<{ query: string }, KnowledgeSearchResult> = {
  name: "search_knowledge_base",
  description:
    "Tìm quy trình/chính sách/SOP nội bộ (KHÔNG dùng cho số liệu vận hành — số liệu luôn lấy từ các tool dữ liệu khác, không bao giờ từ đây). Trả về danh sách trích dẫn kèm nguồn tài liệu (documentId/title/section). Nếu available=false, nghĩa là chưa có tài liệu nào được nạp vào hệ thống tri thức — phải nói rõ điều này, không suy diễn nội dung quy trình.",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "Câu hỏi hoặc từ khoá quy trình/chính sách cần tìm." } },
    required: ["query"],
    additionalProperties: false,
  },
  parseArgs: (raw) => {
    const body = (raw ?? {}) as Record<string, unknown>;
    if (typeof body.query !== "string" || !body.query.trim()) throw new ToolExecutionError("INVALID_ARGS", "query là bắt buộc.");
    return { query: body.query.trim().slice(0, 300) };
  },
  execute: async (ctx: ToolContext, args): Promise<ToolResult<KnowledgeSearchResult>> => {
    const scope = await getUserScope(ctx.session);
    const provider = getKnowledgeProvider();
    const result = await provider.search(args.query, scope, 5);
    return { data: result, source: { domains: ["knowledge"], asOf: new Date().toISOString() } };
  },
};

export const knowledgeTools = [search_knowledge_base];
