/* ─── Tokenizer and Token Counter ───────────────────────────────────────────
 * Calibrated token counter with usage tracking (§2.4 / AGT-12).
 * ──────────────────────────────────────────────────────────────────────── */

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens?: number;
}

export class TokenCounter {
  private factor: number; // default characters per token (3.5)
  private consecutiveDeviations = 0;
  private extraMargin = 0; // percentage (e.g. 0.15)
  private traceLog: string[] = [];
  private lastRealPrompt?: number;

  constructor(initialFactor = 3.5) {
    this.factor = initialFactor;
  }

  get lastRealPromptTokens(): number | undefined {
    return this.lastRealPrompt;
  }

  get currentFactor(): number {
    return this.factor;
  }

  get currentExtraMargin(): number {
    return this.extraMargin;
  }

  get logs(): string[] {
    return [...this.traceLog];
  }

  /** Estimates token count for a text string, applying calibration and safety margins. */
  estimate(text: string): number {
    const rawTokens = Math.ceil(text.length / this.factor);
    if (this.extraMargin > 0) {
      return Math.ceil(rawTokens * (1 + this.extraMargin));
    }
    return rawTokens;
  }

  /**
   * Calibrates the counter against real `usage.prompt_tokens` reported by the LLM (§2.4 / AGT-12).
   * - If |estimated - real| / real > 0.10 for 2 turns, adjusts factor.
   * - If > 0.25, next turn applies an additional 15% safety margin.
   */
  calibrate(estimatedPromptTokens: number, realPromptTokens: number, textLength?: number): void {
    if (realPromptTokens <= 0) return;
    this.lastRealPrompt = realPromptTokens;

    const diff = Math.abs(estimatedPromptTokens - realPromptTokens);
    const deviation = diff / realPromptTokens;

    if (deviation > 0.25) {
      this.extraMargin = 0.15;
      this.traceLog.push(`High deviation ${deviation.toFixed(2)} (>0.25): applied 15% extra safety margin`);
    } else {
      this.extraMargin = 0;
    }

    if (deviation > 0.10) {
      this.consecutiveDeviations++;
      if (this.consecutiveDeviations >= 2 && textLength && textLength > 0) {
        // Adjust factor: real chars per token
        const newFactor = Math.max(1.5, Math.min(6.0, textLength / realPromptTokens));
        this.traceLog.push(
          `Calibrating token counter: deviation was ${deviation.toFixed(2)}, adjusted factor from ${this.factor.toFixed(2)} to ${newFactor.toFixed(2)}`,
        );
        this.factor = newFactor;
        this.consecutiveDeviations = 0;
      }
    } else {
      this.consecutiveDeviations = 0;
    }
  }
}
