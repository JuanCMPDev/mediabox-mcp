import { GoogleGenAI } from '@google/genai';
import type { StreamProvider, LLMStreamChunk } from './types.js';
import type { ChatMessage, VirtualToolDef } from '../types.js';
import { buildGeminiHistory, toGeminiTools } from '../history.js';

export class GeminiProvider implements StreamProvider {
  readonly providerName = 'gemini' as const;
  readonly model:        string;
  private client:        GoogleGenAI;

  constructor(apiKey: string, model: string) {
    this.client = new GoogleGenAI({ apiKey });
    this.model  = model;
  }

  async *stream(opts: {
    systemPrompt: string;
    messages:     ChatMessage[];
    tools:        VirtualToolDef[];
  }): AsyncGenerator<LLMStreamChunk> {
    const geminiHistory = buildGeminiHistory(opts.messages);
    const geminiTools   = toGeminiTools(opts.tools);

    const rawStream = await this.client.models.generateContentStream({
      model:    this.model,
      contents: geminiHistory as any,
      config: {
        systemInstruction: opts.systemPrompt,
        tools:             geminiTools as any,
        temperature:       0.3,
      },
    });

    // In Gemini, function calls typically arrive as complete objects after text streaming.
    // Accumulate them so they're all yielded after the text tokens.
    // Why dedup: Gemini Flash can re-emit the same functionCall across consecutive
    // chunks, or hallucinate parallel calls to the same tool with identical args.
    // Without dedup the engine fires N MCP calls and renders N chips for a single
    // logical action (cache absorbs the cost, but the UI still looks confusing).
    const functionCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const seen = new Set<string>();

    for await (const chunk of rawStream) {
      const parts = (chunk as any).candidates?.[0]?.content?.parts ?? [];
      for (const part of parts) {
        if (typeof part.text === 'string' && part.text) {
          yield { type: 'text', text: part.text };
        }
        if (part.functionCall) {
          const fc = {
            name: part.functionCall.name  as string,
            args: (part.functionCall.args ?? {}) as Record<string, unknown>,
          };
          const key = `${fc.name}:${JSON.stringify(fc.args)}`;
          if (!seen.has(key)) {
            seen.add(key);
            functionCalls.push(fc);
          }
        }
      }
    }

    for (let i = 0; i < functionCalls.length; i++) {
      const fc = functionCalls[i];
      yield { type: 'tool_call', id: `call_${Date.now()}_${i}`, name: fc.name, args: fc.args };
    }

    yield { type: 'done' };
  }
}
