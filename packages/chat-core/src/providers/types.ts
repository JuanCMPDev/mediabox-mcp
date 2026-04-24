import type { VirtualToolDef, ChatMessage } from '../types.js';

/** Unified LLM stream chunk — same shape regardless of provider. */
export type LLMStreamChunk =
  | { type: 'text';      text: string }
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown> }
  | { type: 'done' };

export interface StreamProvider {
  readonly providerName: 'openrouter' | 'gemini';
  readonly model:        string;

  stream(opts: {
    systemPrompt: string;
    messages:     ChatMessage[];
    tools:        VirtualToolDef[];
  }): AsyncGenerator<LLMStreamChunk>;
}
