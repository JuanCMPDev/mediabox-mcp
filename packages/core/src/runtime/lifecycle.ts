import type { RuntimeLifecycleState, RuntimeResourceLimits } from "../config/types.js";

export class RuntimeLifecycleError extends Error {
  constructor(public readonly code: string, message: string) {
    super(`[lifecycle:${code}] ${message}`);
    this.name = "RuntimeLifecycleError";
  }
}

export const DEFAULT_RESOURCE_LIMITS: RuntimeResourceLimits = {
  reservedCpuCores: 4,
  reservedRamBytes: 8 * 1024 * 1024 * 1024, // 8 GiB
  maxContextTokens: 8192,
  maxActiveConversations: 1,
  maxLoadedModels: 1,
  maxParallelInferences: 1,
};

const VALID_TRANSITIONS: Record<RuntimeLifecycleState, RuntimeLifecycleState[]> = {
  not_provisioned: ["starting", "error"],
  stopped: ["starting", "not_provisioned", "error"],
  starting: ["ready", "unavailable", "error", "stopped"],
  ready: ["stopped", "unavailable", "error"],
  unavailable: ["starting", "stopped", "error"],
  error: ["stopped", "starting", "not_provisioned"],
};

export interface LifecycleSnapshot {
  state: RuntimeLifecycleState;
  activeInferences: number;
  activeConversations: number;
  loadedModel: string | null;
  lastTransitionAt: string;
  reason?: string;
}

export class RuntimeLifecycleManager {
  private _state: RuntimeLifecycleState = "not_provisioned";
  private _activeInferences = 0;
  private _activeConversations = 0;
  private _loadedModel: string | null = null;
  private _lastTransitionAt: string = new Date().toISOString();
  private _reason?: string;
  private readonly _limits: RuntimeResourceLimits;

  constructor(initialLimits?: Partial<RuntimeResourceLimits>) {
    this._limits = { ...DEFAULT_RESOURCE_LIMITS, ...initialLimits };
  }

  get state(): RuntimeLifecycleState {
    return this._state;
  }

  get limits(): RuntimeResourceLimits {
    return { ...this._limits };
  }

  get snapshot(): LifecycleSnapshot {
    return {
      state: this._state,
      activeInferences: this._activeInferences,
      activeConversations: this._activeConversations,
      loadedModel: this._loadedModel,
      lastTransitionAt: this._lastTransitionAt,
      reason: this._reason,
    };
  }

  /**
   * Performs an allowed state transition (§3.3).
   */
  transition(next: RuntimeLifecycleState, reason?: string): void {
    const allowed = VALID_TRANSITIONS[this._state];
    if (!allowed.includes(next)) {
      throw new RuntimeLifecycleError(
        "ERR_INVALID_TRANSITION",
        `Invalid lifecycle transition from '${this._state}' to '${next}'`,
      );
    }
    this._state = next;
    this._lastTransitionAt = new Date().toISOString();
    this._reason = reason ? this.sanitizeReason(reason) : undefined;
    if (next === "stopped" || next === "unavailable" || next === "error") {
      this._activeInferences = 0;
    }
  }

  setLoadedModel(model: string | null): void {
    if (model && this._loadedModel && this._loadedModel !== model && this._limits.maxLoadedModels <= 1) {
      // Unload previous model when single model limit is enforced
      this._loadedModel = null;
    }
    this._loadedModel = model;
  }

  /**
   * Checks resource admission before starting an inference (§3.2 / §3.3).
   */
  admitInference(): { release: () => void } {
    if (this._state !== "ready") {
      throw new RuntimeLifecycleError(
        "ERR_RUNTIME_NOT_READY",
        `Cannot admit inference while runtime state is '${this._state}'`,
      );
    }
    if (this._activeInferences >= this._limits.maxParallelInferences) {
      throw new RuntimeLifecycleError(
        "ERR_INFERENCE_CONCURRENCY_EXCEEDED",
        `Max parallel inferences limit (${this._limits.maxParallelInferences}) reached`,
      );
    }

    this._activeInferences++;
    let released = false;

    return {
      release: () => {
        if (!released) {
          released = true;
          this._activeInferences = Math.max(0, this._activeInferences - 1);
        }
      },
    };
  }

  /**
   * Waits for the runtime to become healthy with max 120s timeout and 30s poll interval (§3.3).
   */
  async waitForReady(
    probeFn: () => Promise<boolean>,
    options?: { timeoutMs?: number; pollIntervalMs?: number },
  ): Promise<void> {
    const timeoutMs = options?.timeoutMs ?? 120_000;
    const pollIntervalMs = options?.pollIntervalMs ?? 30_000;
    const startTime = Date.now();

    this.transition("starting", "Waiting for runtime readiness");

    while (Date.now() - startTime < timeoutMs) {
      try {
        const isHealthy = await probeFn();
        if (isHealthy) {
          this.transition("ready", "Runtime is healthy and ready");
          return;
        }
      } catch (err) {
        // Continue polling until timeout
      }

      const remaining = timeoutMs - (Date.now() - startTime);
      if (remaining <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollIntervalMs, remaining)));
    }

    this.transition("unavailable", "Runtime startup timed out after 120s");
    throw new RuntimeLifecycleError(
      "ERR_STARTUP_TIMEOUT",
      `Runtime failed to reach ready state within ${timeoutMs / 1000}s`,
    );
  }

  private sanitizeReason(reason: string): string {
    // Sanitize any potential secrets or local file paths from reason
    return reason
      .replace(/[A-Za-z0-9_-]{24,}/g, "[REDACTED]")
      .replace(/(\/|[A-Za-z]:\\)[^\s]+/g, "[PATH]");
  }
}
