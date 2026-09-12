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

/**
 * §3.3: not_provisioned → stopped (artifacts verified) → starting → ready, plus
 * unavailable, error and explicit stop. Nothing starts from not_provisioned or
 * error: artifacts are verified first, and an error is cleared through `stopped`.
 */
const VALID_TRANSITIONS: Record<RuntimeLifecycleState, RuntimeLifecycleState[]> = {
  not_provisioned: ["stopped", "error"],
  stopped: ["starting", "not_provisioned", "error"],
  starting: ["ready", "unavailable", "error", "stopped"],
  ready: ["stopped", "unavailable", "error"],
  unavailable: ["starting", "stopped", "error"],
  error: ["stopped", "not_provisioned"],
};

export interface LifecycleSnapshot {
  state: RuntimeLifecycleState;
  activeInferences: number;
  activeConversations: number;
  loadedModel: string | null;
  lastTransitionAt: string;
  reason?: string;
}

export interface WaitForReadyOptions {
  /** Longest wait for a healthy probe (default 120 s, §3.3). */
  timeoutMs?: number;
  /** Delay between probes (default 30 s, §3.3). */
  pollIntervalMs?: number;
  /** Cancels the wait; the runtime is left `stopped`. */
  signal?: AbortSignal;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
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

  /**
   * Artifacts were verified: the runtime may now be started. Valid before the
   * first start or after an error; a no-op when already stopped.
   */
  markProvisioned(reason = "Artifacts verified"): void {
    if (this._state === "stopped") return;
    if (this._state !== "not_provisioned" && this._state !== "error") {
      throw new RuntimeLifecycleError(
        "ERR_INVALID_TRANSITION",
        `Cannot mark artifacts provisioned while runtime state is '${this._state}'`,
      );
    }
    this.transition("stopped", reason);
  }

  /**
   * Explicit stop. Also ends a pending waitForReady. Nothing to stop before the
   * artifacts are provisioned, so not_provisioned stays as it is.
   */
  stop(reason = "Stopped explicitly"): void {
    if (this._state === "stopped" || this._state === "not_provisioned") return;
    this.transition("stopped", reason);
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
   * Starts from `stopped` or `unavailable` and waits for a healthy probe: at most
   * 120 s, probing every 30 s by default (§3.3). Timeout leaves `unavailable` with
   * a sanitized cause; cancellation or an explicit stop leaves `stopped`.
   */
  async waitForReady(
    probeFn: (signal?: AbortSignal) => Promise<boolean>,
    options: WaitForReadyOptions = {},
  ): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 120_000;
    const pollIntervalMs = options.pollIntervalMs ?? 30_000;
    const { signal } = options;

    if (this._state === "ready") return;
    if (this._state === "not_provisioned") {
      throw new RuntimeLifecycleError(
        "ERR_NOT_PROVISIONED",
        "Runtime artifacts are not verified; run prepare before starting",
      );
    }
    if (this._state !== "stopped" && this._state !== "unavailable") {
      throw new RuntimeLifecycleError(
        "ERR_INVALID_TRANSITION",
        `Cannot start the runtime while its state is '${this._state}'`,
      );
    }
    if (signal?.aborted) {
      throw new RuntimeLifecycleError("ERR_STARTUP_ABORTED", "Runtime startup was cancelled");
    }

    const startTime = Date.now();
    this.transition("starting", "Waiting for runtime readiness");
    let lastFailure: string | undefined;

    for (;;) {
      let healthy = false;
      try {
        healthy = await probeFn(signal);
        lastFailure = undefined;
      } catch (err) {
        lastFailure = err instanceof Error ? err.message : String(err);
      }
      this.assertStillStarting(signal);
      if (healthy) {
        this.transition("ready", "Runtime is healthy and ready");
        return;
      }

      const remaining = timeoutMs - (Date.now() - startTime);
      if (remaining <= 0) break;
      await sleep(Math.min(pollIntervalMs, remaining), signal);
      this.assertStillStarting(signal);
    }

    this.transition(
      "unavailable",
      `Runtime startup timed out after ${timeoutMs / 1000}s${lastFailure ? ` (${lastFailure})` : ""}`,
    );
    throw new RuntimeLifecycleError(
      "ERR_STARTUP_TIMEOUT",
      `Runtime failed to reach ready state within ${timeoutMs / 1000}s`,
    );
  }

  /** Cancellation or a concurrent transition ends the wait without claiming readiness. */
  private assertStillStarting(signal?: AbortSignal): void {
    if (signal?.aborted) {
      if (this._state === "starting") this.transition("stopped", "Startup cancelled");
      throw new RuntimeLifecycleError("ERR_STARTUP_ABORTED", "Runtime startup was cancelled");
    }
    if (this._state !== "starting") {
      throw new RuntimeLifecycleError(
        "ERR_STARTUP_ABORTED",
        `Runtime startup was interrupted (state is now '${this._state}')`,
      );
    }
  }

  private sanitizeReason(reason: string): string {
    // Sanitize any potential secrets or local file paths from reason
    return reason
      .replace(/[A-Za-z0-9_-]{24,}/g, "[REDACTED]")
      .replace(/(\/|[A-Za-z]:\\)[^\s]+/g, "[PATH]");
  }
}
