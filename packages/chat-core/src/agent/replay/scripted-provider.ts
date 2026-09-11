/* ─── Scripted LLM Provider for Replay ───────────────────────────────────────
 * Replays exact stream chunk sequences deterministically (§2.11 / AGT-01..12).
 * ──────────────────────────────────────────────────────────────────────── */
import type { StreamProvider, LLMStreamChunk } from '../../providers/types.js';
import type { ChatMessage, VirtualToolDef } from '../../types.js';

export interface PromptInspection {
  systemPrompt: string;
  messages: ChatMessage[];
  tools: VirtualToolDef[];
}

export class ScriptedProvider implements StreamProvider {
  readonly providerName = 'local' as const;
  readonly model: string;
  readonly seen: PromptInspection[] = [];

  private turnScripts: LLMStreamChunk[][];
  private currentStep = 0;

  constructor(turnScripts: LLMStreamChunk[][], model = 'qwen2.5:7b') {
    this.turnScripts = turnScripts;
    this.model = model;
  }

  setScripts(turnScripts: LLMStreamChunk[][]): void {
    this.turnScripts = turnScripts;
    this.currentStep = 0;
  }

  async *stream(opts: {
    systemPrompt: string;
    messages: ChatMessage[];
    tools: VirtualToolDef[];
  }): AsyncGenerator<LLMStreamChunk> {
    this.seen.push({
      systemPrompt: opts.systemPrompt,
      messages: JSON.parse(JSON.stringify(opts.messages)),
      tools: JSON.parse(JSON.stringify(opts.tools)),
    });

    const script = this.turnScripts[this.currentStep] ?? [
      { type: 'text', text: '(script exhausted)' },
    ];
    this.currentStep++;

    for (const chunk of script) {
      yield chunk;
    }
  }

  get stepCount(): number {
    return this.currentStep;
  }

  reset(): void {
    this.currentStep = 0;
    this.seen.length = 0;
  }
}
