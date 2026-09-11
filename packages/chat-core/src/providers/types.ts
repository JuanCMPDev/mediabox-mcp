import type { VirtualToolDef, ChatMessage } from '../types.js';

export interface LLMUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/** Unified LLM stream chunk — same shape regardless of provider. */
export type LLMStreamChunk =
  | { type: 'text';      text: string; usage?: LLMUsage; reasoning?: string }
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown>; usage?: LLMUsage }
  | { type: 'done';      usage?: LLMUsage; reasoning?: string }
  | { type: 'usage';     usage: LLMUsage };

export interface StreamProvider {
  readonly providerName: 'openrouter' | 'gemini' | 'local';
  readonly model:        string;
  /** Effective context window in tokens when the provider knows it (local runtimes report it). */
  readonly contextTokens?: number;

  stream(opts: {
    systemPrompt: string;
    messages:     ChatMessage[];
    tools:        VirtualToolDef[];
    /** Turn cancellation: aborts the HTTP stream at the transport level (§2.9 / AGT-09). */
    signal?:      AbortSignal;
    /** Upper bound for generated tokens; the engine passes its output reserve (§3.6). */
    maxTokens?:   number;
  }): AsyncGenerator<LLMStreamChunk>;
}
