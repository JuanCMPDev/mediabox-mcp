import type { ChatMessage, VirtualToolDef, HistoryStore } from './types.js';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions.js';
import { Type } from '@google/genai';

export const MAX_HISTORY_TOKENS = 200_000;

// ── Token estimation ──────────────────────────────────────────────────────────

export function estimateTokens(msg: ChatMessage): number {
  let chars = msg.content.length;
  if (msg.toolCalls)   chars += msg.toolCalls.reduce((a, tc)   => a + tc.name.length + JSON.stringify(tc.args).length, 0);
  if (msg.toolResults) chars += msg.toolResults.reduce((a, tr) => a + tr.result.length, 0);
  return Math.ceil(chars / 3.5);
}

export function trimHistory(history: ChatMessage[]): ChatMessage[] {
  let total = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    total += estimateTokens(history[i]);
    if (total > MAX_HISTORY_TOKENS) {
      let start = i + 1;
      // Never start mid-exchange (assistant tool-call without its result)
      while (start < history.length && history[start].role === 'assistant' && history[start].toolCalls?.length) {
        start++;
        if (start < history.length && history[start].toolResults?.length) start++;
      }
      return history.slice(start);
    }
  }
  return history;
}

// ── OpenRouter (OpenAI SDK) message builder ───────────────────────────────────

export function toOpenAITools(tools: VirtualToolDef[]): ChatCompletionTool[] {
  return tools.map(t => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export function buildOpenRouterMessages(
  history: ChatMessage[],
  tools: VirtualToolDef[],
  systemPrompt: string,
): { messages: ChatCompletionMessageParam[]; tools: ChatCompletionTool[] } {
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
  ];

  for (const msg of history) {
    if (msg.role === 'user' && msg.toolResults?.length) {
      for (const tr of msg.toolResults) {
        messages.push({ role: 'tool', tool_call_id: tr.id, content: tr.result } as any);
      }
    } else if (msg.role === 'user') {
      messages.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant' && msg.toolCalls?.length) {
      messages.push({
        role: 'assistant',
        content: msg.content || null,
        tool_calls: msg.toolCalls.map(tc => ({
          id: tc.id, type: 'function' as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        })),
      } as any);
    } else {
      messages.push({ role: 'assistant', content: msg.content });
    }
  }

  return { messages, tools: toOpenAITools(tools) };
}

// ── Gemini message builder ────────────────────────────────────────────────────

interface GeminiMsg {
  role:  'user' | 'model';
  parts: Array<{
    text?:             string;
    functionCall?:     { name: string; args: Record<string, unknown> };
    functionResponse?: { name: string; response: Record<string, unknown> };
  }>;
}

export function toGeminiTools(tools: VirtualToolDef[]) {
  return [{
    functionDeclarations: tools.map(t => ({
      name:        t.name,
      description: t.description,
      parameters:  convertGeminiSchema(t.parameters as Record<string, unknown>),
    })),
  }];
}

function convertGeminiSchema(params: Record<string, unknown>): Record<string, unknown> {
  const props = (params.properties as Record<string, any>) || {};
  const required = (params.required as string[]) || [];
  const geminiProps: Record<string, any> = {};
  for (const [key, val] of Object.entries(props)) {
    const prop: any = { description: val.description || '' };
    if (val.type === 'string')  { prop.type = Type.STRING; if (val.enum) prop.enum = val.enum; }
    else if (val.type === 'number' || val.type === 'integer') { prop.type = Type.NUMBER; }
    else if (val.type === 'boolean') { prop.type = Type.BOOLEAN; }
    else if (val.type === 'array')   { prop.type = Type.ARRAY; prop.items = { type: val.items?.type === 'number' ? Type.NUMBER : Type.STRING }; }
    else { prop.type = Type.STRING; }
    geminiProps[key] = prop;
  }
  return { type: Type.OBJECT, properties: geminiProps, required };
}

export function buildGeminiHistory(history: ChatMessage[]): GeminiMsg[] {
  const gemini: GeminiMsg[] = [];
  for (const msg of history) {
    if (msg.role === 'user' && msg.toolResults?.length) {
      gemini.push({
        role: 'user',
        parts: msg.toolResults.map(tr => {
          let parsed: Record<string, unknown>;
          try {
            const p = JSON.parse(tr.result);
            parsed = Array.isArray(p) ? { result: p } : typeof p === 'object' && p !== null ? (p as Record<string, unknown>) : { result: p };
          } catch { parsed = { result: tr.result }; }
          return { functionResponse: { name: tr.name, response: parsed } };
        }),
      });
    } else if (msg.role === 'user') {
      gemini.push({ role: 'user', parts: [{ text: msg.content }] });
    } else if (msg.role === 'assistant' && msg.toolCalls?.length) {
      const parts: GeminiMsg['parts'] = [];
      if (msg.content) parts.push({ text: msg.content });
      for (const tc of msg.toolCalls) parts.push({ functionCall: { name: tc.name, args: tc.args } });
      gemini.push({ role: 'model', parts });
    } else {
      gemini.push({ role: 'model', parts: [{ text: msg.content || '(sin respuesta)' }] });
    }
  }
  return gemini;
}

// ── In-memory conversation store ──────────────────────────────────────────────

export class InMemoryHistoryStore implements HistoryStore {
  private store        = new Map<string, ChatMessage[]>();
  private lastActivity = new Map<string, number>();
  private readonly ttl: number;

  constructor(ttlMs = 7_200_000) {
    this.ttl = ttlMs;
    setInterval(() => this.cleanup(), 600_000).unref?.();
  }

  get(id: string): ChatMessage[] {
    if (!this.store.has(id)) this.store.set(id, []);
    this.lastActivity.set(id, Date.now());
    return this.store.get(id)!;
  }

  set(id: string, h: ChatMessage[]): void {
    this.store.set(id, h);
    this.lastActivity.set(id, Date.now());
  }

  delete(id: string): void {
    this.store.delete(id);
    this.lastActivity.delete(id);
  }

  toDisplayEntries(id: string): Array<{ role: 'user' | 'assistant'; content: string }> {
    return this.get(id)
      .filter(m => !m.toolResults?.length && m.content.trim())
      .map(m => ({ role: m.role, content: m.content }));
  }

  private cleanup(): void {
    const cutoff = Date.now() - this.ttl;
    this.lastActivity.forEach((ts, id) => {
      if (ts < cutoff) { this.store.delete(id); this.lastActivity.delete(id); }
    });
  }
}
