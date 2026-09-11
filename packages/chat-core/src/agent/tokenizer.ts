/* ─── Tokenizer and Token Counter ───────────────────────────────────────────
 * Calibrated token counter with usage tracking (§2.4 / AGT-12).
 *
 * Calibration state is persisted in the workflow so deviations accumulate across
 * turns: the "two consecutive turns above 10%" rule is meaningless otherwise.
 * ──────────────────────────────────────────────────────────────────────── */
import type { TokenizerCalibration } from './workflow.js';
import type { TokenEstimator } from './budget.js';

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens?: number;
}

export const DEFAULT_CHARS_PER_TOKEN = 3.5;
export const CALIBRATION_DEVIATION_THRESHOLD = 0.10;
export const CALIBRATION_HIGH_DEVIATION = 0.25;
export const CALIBRATION_EXTRA_MARGIN = 0.15;

export class TokenCounter implements TokenEstimator {
  private factor: number; // characters per token
  private consecutiveDeviations = 0;
  private extraMargin = 0; // percentage (e.g. 0.15)
  private traceLog: string[] = [];
  private lastRealPrompt?: number;
  private lastDeviation?: number;

  constructor(initialFactor = DEFAULT_CHARS_PER_TOKEN) {
    this.factor = initialFactor;
  }

  /** Restores a counter from the calibration persisted in the workflow state. */
  static fromCalibration(calibration?: TokenizerCalibration): TokenCounter {
    const counter = new TokenCounter(calibration?.factor ?? DEFAULT_CHARS_PER_TOKEN);
    if (calibration) {
      counter.extraMargin = calibration.extraMargin;
      counter.consecutiveDeviations = calibration.consecutiveDeviations;
    }
    return counter;
  }

  /** Snapshot to persist so the next turn starts from the same calibration. */
  get calibration(): TokenizerCalibration {
    return {
      factor: this.factor,
      extraMargin: this.extraMargin,
      consecutiveDeviations: this.consecutiveDeviations,
    };
  }

  get lastRealPromptTokens(): number | undefined {
    return this.lastRealPrompt;
  }

  get lastDeviationRatio(): number | undefined {
    return this.lastDeviation;
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
    return this.estimateLength(text.length);
  }

  /** Same estimate from a character count, avoiding large string allocations. */
  estimateLength(chars: number): number {
    const rawTokens = Math.ceil(chars / this.factor);
    if (this.extraMargin > 0) {
      return Math.ceil(rawTokens * (1 + this.extraMargin));
    }
    return rawTokens;
  }

  /**
   * Calibrates the counter against real `usage.prompt_tokens` reported by the LLM (§2.4 / AGT-12).
   * - If |estimated - real| / real > 0.10 for 2 consecutive measurements, adjusts the factor.
   * - If > 0.25, an additional 15% safety margin applies from the next estimate onwards,
   *   which can push a borderline prompt over the budget and block the turn.
   */
  calibrate(estimatedPromptTokens: number, realPromptTokens: number, textLength?: number): void {
    if (realPromptTokens <= 0) return;
    this.lastRealPrompt = realPromptTokens;

    const diff = Math.abs(estimatedPromptTokens - realPromptTokens);
    const deviation = diff / realPromptTokens;
    this.lastDeviation = deviation;

    if (deviation > CALIBRATION_HIGH_DEVIATION) {
      this.extraMargin = CALIBRATION_EXTRA_MARGIN;
      this.traceLog.push(
        `deviation ${deviation.toFixed(2)} > ${CALIBRATION_HIGH_DEVIATION}: applied ${CALIBRATION_EXTRA_MARGIN * 100}% extra margin`,
      );
    } else {
      this.extraMargin = 0;
    }

    if (deviation > CALIBRATION_DEVIATION_THRESHOLD) {
      this.consecutiveDeviations++;
      if (this.consecutiveDeviations >= 2 && textLength && textLength > 0) {
        // Adjust factor to the measured characters per token.
        const newFactor = Math.max(1.5, Math.min(6.0, textLength / realPromptTokens));
        this.traceLog.push(
          `calibrated factor ${this.factor.toFixed(2)} → ${newFactor.toFixed(2)} after deviation ${deviation.toFixed(2)}`,
        );
        this.factor = newFactor;
        this.consecutiveDeviations = 0;
      }
    } else {
      this.consecutiveDeviations = 0;
    }
  }
}
