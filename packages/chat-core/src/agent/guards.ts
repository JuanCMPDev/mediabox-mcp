/* ─── Turn Guards and Loop Detection ─────────────────────────────────────────
 * Turn-level constraints, loop detection, and stalling prevention (§2.5 / AGT-03).
 * ──────────────────────────────────────────────────────────────────────── */
import { createHash } from 'node:crypto';
import { AgentError } from './errors.js';

export interface GuardConfig {
  maxInferences: number; // 6
  maxToolCalls:  number; // 8
  turnTimeoutMs: number; // 120_000
  toolTimeoutMs: number; // 150_000
}

export const DEFAULT_GUARDS: GuardConfig = {
  maxInferences: 6,
  maxToolCalls:  8,
  turnTimeoutMs: 120_000,
  toolTimeoutMs: 150_000,
};

export function computeArgsHash(args: Record<string, unknown>): string {
  const canonical = JSON.stringify(args, Object.keys(args).sort());
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

export function computeResultDigest(result: string): string {
  return createHash('sha256').update(result).digest('hex').slice(0, 16);
}

export class TurnGuards {
  private config: GuardConfig;
  private inferencesCount = 0;
  private toolCallsCount = 0;
  private startTime: number;
  private consecutiveEmptyOrStalledInferences = 0;
  private executedCalls: Array<{ tool: string; argsHash: string; resultDigest: string }> = [];

  constructor(config: Partial<GuardConfig> = {}, startTime = Date.now()) {
    this.config = { ...DEFAULT_GUARDS, ...config };
    this.startTime = startTime;
  }

  get stats(): { inferences: number; toolCalls: number; elapsedMs: number } {
    return {
      inferences: this.inferencesCount,
      toolCalls: this.toolCallsCount,
      elapsedMs: Date.now() - this.startTime,
    };
  }

  /** Checks whether another inference step is permitted before starting it. */
  checkInferenceAllowed(now = Date.now()): void {
    if (this.inferencesCount >= this.config.maxInferences) {
      throw new AgentError(
        'ERR_TURN_BUDGET',
        `Turn reached maximum inference limit (${this.config.maxInferences})`,
      );
    }
    if (now - this.startTime > this.config.turnTimeoutMs) {
      throw new AgentError(
        'ERR_TOOL_TIMEOUT',
        `Turn exceeded total timeout (${this.config.turnTimeoutMs}ms)`,
      );
    }
  }

  recordInference(text: string, toolCallsCount: number): void {
    this.inferencesCount++;

    const isStalled = toolCallsCount === 0 && text.trim().length < 20;
    if (isStalled) {
      this.consecutiveEmptyOrStalledInferences++;
      if (this.consecutiveEmptyOrStalledInferences >= 2) {
        throw new AgentError(
          'ERR_LOOP_DETECTED',
          'Loop detected: consecutive inferences with no progress or useful text',
        );
      }
    } else {
      this.consecutiveEmptyOrStalledInferences = 0;
    }
  }

  /** Checks whether another tool call is permitted before executing it. */
  checkToolCallAllowed(tool: string, argsHash: string): void {
    if (this.toolCallsCount >= this.config.maxToolCalls) {
      throw new AgentError(
        'ERR_TURN_BUDGET',
        `Turn reached maximum tool call limit (${this.config.maxToolCalls})`,
      );
    }
  }

  /**
   * Records completed tool execution and checks for identical repetition without progress.
   * If same (tool, argsHash) was executed previously in this turn and resultDigest is identical -> ERR_LOOP_DETECTED (AGT-03).
   */
  recordToolCall(tool: string, argsHash: string, resultDigest: string): void {
    this.toolCallsCount++;

    const previousIdentical = this.executedCalls.find(
      c => c.tool === tool && c.argsHash === argsHash,
    );

    if (previousIdentical && previousIdentical.resultDigest === resultDigest) {
      throw new AgentError(
        'ERR_LOOP_DETECTED',
        `Loop detected: tool '${tool}' was repeated with identical arguments and returned identical results`,
      );
    }

    this.executedCalls.push({ tool, argsHash, resultDigest });
  }
}
