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
  /** Raw tool payload as returned by MCP. Never pre-wrapped: budget.ts wraps it at prompt build time (§2.7). */
  result: string;
  /** Whether the call succeeded — used to build the `[tool_result status=…]` envelope. */
  ok?:    boolean;
  /** Originating service/tool family, surfaced as `source=` in the envelope. */
  source?: string;
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

/** Injected MCP call function — implementation varies per consumer (loopback HTTP, direct, etc.)
 *  The third argument carries the turn AbortSignal so a cancelled turn aborts the in-flight
 *  MCP request instead of merely being ignored on return (§2.9 / AGT-09). */
export type McpCallFn = (
  toolName: string,
  args: Record<string, unknown>,
  opts?: { signal?: AbortSignal },
) => Promise<string>;

/** Conversation history store — abstracted for testability (in-memory, DB, etc.). */
export interface HistoryStore {
  get(id: string):                          ChatMessage[];
  set(id: string, h: ChatMessage[]): void;
  delete(id: string):                       void;
}

/** Arguments passed to the stream engine. */
export interface StreamChatOptions {
  message?:       string;
  conversationId: string;
  provider:       import('./providers/types.js').StreamProvider;
  mcpCall:        McpCallFn;
  historyStore:   HistoryStore;
  /** BCP-47 locale for the response language (PR 3.4d). Defaults to "en". */
  locale?:        string;
  workflowStore?: import('./agent/workflow.js').WorkflowStore;
  signal?:        AbortSignal;
  selection?:     import('@mediabox/contracts').TypedSelection;
  budget?:        import('./agent/budget.js').BudgetConfig;
  guards?:        Partial<import('./agent/guards.js').GuardConfig>;
  clock?:         import('./agent/workflow.js').ClockFn;
  onTrace?:       (trace: import('./agent/trace.js').AgentTrace) => void;
}
