/* ─── @mediabox/chat-core internal types ────────────────────────────────────
 * Not part of the public wire format (@mediabox/contracts has those).
 * ──────────────────────────────────────────────────────────────────────── */

export interface ToolCallInfo {
  id:   string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResultInfo {
  id:     string;
  name:   string;
  result: string;
}

/** Unified conversation message — compatible with both OpenAI and Gemini history. */
export interface ChatMessage {
  role:         'user' | 'assistant';
  content:      string;
  toolCalls?:   ToolCallInfo[];
  toolResults?: ToolResultInfo[];
}

/** Virtual tool definition presented to the LLM (8 high-level tools). */
export interface VirtualToolDef {
  name:        string;
  description: string;
  parameters:  Record<string, unknown>;
}

/** Injected MCP call function — implementation varies per consumer (loopback HTTP, direct, etc.) */
export type McpCallFn = (toolName: string, args: Record<string, unknown>) => Promise<string>;

/** Conversation history store — abstracted for testability (in-memory, DB, etc.). */
export interface HistoryStore {
  get(id: string):                          ChatMessage[];
  set(id: string, h: ChatMessage[]): void;
  delete(id: string):                       void;
}

/** Arguments passed to the stream engine. */
export interface StreamChatOptions {
  message:        string;
  conversationId: string;
  provider:       import('./providers/types.js').StreamProvider;
  mcpCall:        McpCallFn;
  historyStore:   HistoryStore;
}
