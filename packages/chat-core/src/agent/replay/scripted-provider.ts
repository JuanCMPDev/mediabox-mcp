/* ─── Scripted LLM Provider for Replay ───────────────────────────────────────
 * Replays exact stream chunk sequences deterministically (§2.11 / AGT-01..12).
 *
 * A script step is either a list of already-normalised engine chunks or a list of
 * raw SSE fragments, which go through the same normaliser the local provider uses.
 * The raw form is what lets a scenario reproduce split JSON, missing ids, odd
 * finish_reason values and `<think>` blocks exactly as a runtime emits them.
 * ──────────────────────────────────────────────────────────────────────── */
import type { StreamProvider, LLMStreamChunk } from '../../providers/types.js';
import type { ChatMessage, VirtualToolDef } from '../../types.js';
import type { LocalRuntimeKind } from '@mediabox/contracts';
import { normalizeChatCompletionStream } from '../../providers/local.js';

export interface RawSseScript {
  /** Raw SSE fragments, exactly as captured from a runtime. */
  sse: string[];
  runtime?: LocalRuntimeKind;
}

export type ScriptedInference = LLMStreamChunk[] | RawSseScript;

export interface PromptInspection {
  systemPrompt: string;
  messages: ChatMessage[];
  tools: VirtualToolDef[];
  maxTokens?: number;
}

function isRawSse(step: ScriptedInference): step is RawSseScript {
  return !Array.isArray(step) && Array.isArray((step as RawSseScript).sse);
}

export class ScriptedProvider implements StreamProvider {
  readonly providerName = 'local' as const;
  readonly model: string;
  readonly seen: PromptInspection[] = [];
  /** Signals handed to each inference, so cancellation propagation is observable. */
  readonly signals: Array<AbortSignal | undefined> = [];

  private turnScripts: ScriptedInference[];
  private currentStep = 0;

  constructor(turnScripts: ScriptedInference[], model = 'qwen2.5:7b') {
    this.turnScripts = turnScripts;
    this.model = model;
  }

  setScripts(turnScripts: ScriptedInference[]): void {
    this.turnScripts = turnScripts;
    this.currentStep = 0;
  }

  async *stream(opts: {
    systemPrompt: string;
    messages: ChatMessage[];
    tools: VirtualToolDef[];
    signal?: AbortSignal;
    maxTokens?: number;
  }): AsyncGenerator<LLMStreamChunk> {
    this.seen.push({
      systemPrompt: opts.systemPrompt,
      messages: JSON.parse(JSON.stringify(opts.messages)),
      tools: JSON.parse(JSON.stringify(opts.tools)),
      maxTokens: opts.maxTokens,
    });
    this.signals.push(opts.signal);

    const step = this.turnScripts[this.currentStep] ?? ([{ type: 'text', text: '(script exhausted)' }] as LLMStreamChunk[]);
    const inferenceIndex = this.currentStep;
    this.currentStep++;

    if (isRawSse(step)) {
      yield* normalizeChatCompletionStream(step.sse, {
        runtime: step.runtime ?? 'ollama',
        inferenceIndex,
      });
      return;
    }

    for (const chunk of step) {
      yield chunk;
    }
  }

  get stepCount(): number {
    return this.currentStep;
  }

  reset(): void {
    this.currentStep = 0;
    this.seen.length = 0;
    this.signals.length = 0;
  }
}
