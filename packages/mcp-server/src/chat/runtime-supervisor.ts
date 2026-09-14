/* ─── Local runtime supervisor (§3.2 / §3.3) ─────────────────────────────────
 * Owns the lifecycle of the local inference runtime as the server sees it:
 *   not_provisioned → stopped → starting → ready, plus unavailable and error.
 * - Process health, weight availability and tool-calling compatibility are
 *   separate facts: a healthy runtime is not `agentCompatible`.
 * - A pinned model digest (LOCAL_LLM_MODEL_DIGEST) is checked against the
 *   runtime before the agent may run; strict privacy profiles refuse to run
 *   an unpinned or unverifiable model (fail closed, nothing is downloaded).
 * - Start-up polls health every 30 s for at most 120 s, outside any chat turn.
 * - One inference at a time: a concurrent turn is refused, never queued into
 *   a cloud fallback.
 * ──────────────────────────────────────────────────────────────────────── */
import { RuntimeLifecycleManager } from "@mediabox/core";
import { safeInferenceFetch, type EndpointPolicyOptions } from "@mediabox/chat-core";
import type { ChatInfo, RuntimeLifecycleState } from "@mediabox/contracts";

export type ArtifactStatus = NonNullable<ChatInfo["artifactStatus"]>;

export interface RuntimeTarget {
  runtime: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export interface RuntimeSupervisorOptions {
  target: RuntimeTarget;
  privacyProfile?: string;
  /** Manifest digest pinned by `prepare` (hex or sha256:hex). */
  expectedDigest?: string;
  policy?: EndpointPolicyOptions;
  pollIntervalMs?: number;
  startTimeoutMs?: number;
  /** How long a chat turn may wait for the first health answer of a start attempt. */
  admissionWaitMs?: number;
  fetchFn?: typeof safeInferenceFetch;
}

export class RuntimeAdmissionError extends Error {
  constructor(public readonly code: string, message: string, public readonly httpStatus = 503) {
    super(message);
    this.name = "RuntimeAdmissionError";
  }
}

const STRICT_PROFILES = new Set(["offline-library", "local-agent-online-media"]);

function normalizeDigest(value: string): string {
  return value.trim().toLowerCase().replace(/^sha256:/, "");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

export class RuntimeSupervisor {
  readonly lifecycle = new RuntimeLifecycleManager({
    maxActiveConversations: 1,
    maxLoadedModels: 1,
    maxParallelInferences: 1,
  });
  private _artifactStatus: ArtifactStatus | undefined;
  private attempt: Promise<void> | null = null;
  private firstAnswer: Promise<void> | null = null;
  private abort = new AbortController();
  private readonly strict: boolean;
  private readonly fetchFn: typeof safeInferenceFetch;
  private readonly pollIntervalMs: number;
  private readonly startTimeoutMs: number;
  private readonly admissionWaitMs: number;

  constructor(private readonly opts: RuntimeSupervisorOptions) {
    this.strict = STRICT_PROFILES.has(opts.privacyProfile ?? "");
    this.fetchFn = opts.fetchFn ?? safeInferenceFetch;
    this.pollIntervalMs = opts.pollIntervalMs ?? 30_000;
    this.startTimeoutMs = opts.startTimeoutMs ?? 120_000;
    this.admissionWaitMs = opts.admissionWaitMs ?? 10_000;

    if (opts.expectedDigest) {
      this.lifecycle.transition("stopped", "Pinned model artifact configured; it is verified on start");
    } else if (this.strict) {
      this._artifactStatus = "unpinned";
      this.lifecycle.transition(
        "error",
        "Strict privacy profile without a pinned model digest: run the prepare step (LOCAL_LLM_MODEL_DIGEST)",
      );
    } else {
      this._artifactStatus = "not_required";
      this.lifecycle.transition("stopped", "No pinned artifact required outside strict profiles");
    }
  }

  get state(): RuntimeLifecycleState {
    return this.lifecycle.state;
  }

  get artifactStatus(): ArtifactStatus | undefined {
    return this._artifactStatus;
  }

  get reason(): string | undefined {
    return this.lifecycle.snapshot.reason;
  }

  /** Starts (or joins) a start attempt in the background; never throws. */
  ensureStarted(): Promise<void> {
    if (this.attempt) return this.attempt;
    const s = this.state;
    if (s !== "stopped" && s !== "unavailable") return Promise.resolve();

    let markAnswered!: () => void;
    this.firstAnswer = new Promise<void>((resolve) => { markAnswered = resolve; });
    this.attempt = this.runAttempt(markAnswered)
      .catch((err) => {
        console.error(`[runtime] start attempt failed: ${(err as Error).message}`);
      })
      .finally(() => {
        markAnswered();
        this.attempt = null;
      });
    return this.attempt;
  }

  private async runAttempt(markAnswered: () => void): Promise<void> {
    const signal = this.abort.signal;
    this.lifecycle.transition("starting", "Waiting for runtime health");
    const deadline = Date.now() + this.startTimeoutMs;

    while (!signal.aborted) {
      const healthy = await this.probeHealth();
      if (healthy) {
        const status = await this.verifyArtifact();
        this._artifactStatus = status;
        if (status === "verified" || status === "not_required" || (status === "unverifiable" && !this.strict)) {
          this.lifecycle.transition(
            "ready",
            status === "unverifiable"
              ? `Runtime healthy; ${this.opts.target.runtime} cannot verify the pinned digest (not a strict profile)`
              : "Runtime healthy",
          );
        } else {
          this.lifecycle.transition("error", `Model artifact check failed: ${status}`);
        }
        markAnswered();
        return;
      }
      markAnswered();
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(this.pollIntervalMs, remaining), signal);
    }

    if (this.state === "starting") {
      this.lifecycle.transition(
        "unavailable",
        `Runtime did not answer within ${Math.round(this.startTimeoutMs / 1000)} s`,
      );
    }
  }

  private async probeHealth(): Promise<boolean> {
    const { runtime, baseUrl, apiKey } = this.opts.target;
    const path = runtime === "ollama" ? "/api/version" : "/v1/models";
    try {
      const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
      const res = await this.fetchFn(`${baseUrl.replace(/\/+$/, "")}${path}`, {
        headers,
        signal: AbortSignal.timeout(5_000),
      }, this.opts.policy);
      return res.ok;
    } catch {
      return false;
    }
  }

  private async verifyArtifact(): Promise<ArtifactStatus> {
    const expected = this.opts.expectedDigest;
    if (!expected) return this.strict ? "unpinned" : "not_required";
    const { runtime, baseUrl, model } = this.opts.target;
    if (runtime !== "ollama") return "unverifiable";
    try {
      const res = await this.fetchFn(`${baseUrl.replace(/\/+$/, "")}/api/tags`, {
        signal: AbortSignal.timeout(5_000),
      }, this.opts.policy);
      if (!res.ok) return "unverifiable";
      const body = (await res.json()) as { models?: Array<{ name?: string; model?: string; digest?: string }> };
      const wanted = model.includes(":") ? [model] : [model, `${model}:latest`];
      const entry = body.models?.find((m) => wanted.includes(m.name ?? "") || wanted.includes(m.model ?? ""));
      if (!entry?.digest) return "missing";
      return normalizeDigest(entry.digest) === normalizeDigest(expected) ? "verified" : "mismatch";
    } catch {
      return "unverifiable";
    }
  }

  /**
   * Admits one chat turn. Starts the runtime if needed and waits briefly for its
   * first health answer; loading stays outside the 120 s turn clock (§3.3).
   */
  async admit(): Promise<{ release: () => void }> {
    if (this.state === "stopped" || this.state === "unavailable") void this.ensureStarted();
    if (this.state === "starting" && this.firstAnswer) {
      await Promise.race([this.firstAnswer, sleep(this.admissionWaitMs)]);
    }

    switch (this.state) {
      case "ready":
        try {
          return this.lifecycle.admitInference();
        } catch {
          throw new RuntimeAdmissionError(
            "ERR_INFERENCE_CONCURRENCY_EXCEEDED",
            "The local runtime is already answering another turn; try again when it finishes",
            429,
          );
        }
      case "error":
      case "not_provisioned":
        throw new RuntimeAdmissionError(
          this._artifactStatus === "unpinned" ? "ERR_ARTIFACT_UNPINNED"
            : this._artifactStatus === "mismatch" ? "ERR_ARTIFACT_MISMATCH"
            : this._artifactStatus === "missing" ? "ERR_ARTIFACT_MISSING"
            : this._artifactStatus === "unverifiable" ? "ERR_ARTIFACT_UNVERIFIABLE"
            : "ERR_RUNTIME_NOT_PROVISIONED",
          this.reason ?? "The local runtime is not provisioned",
        );
      default:
        throw new RuntimeAdmissionError(
          "ERR_PROVIDER_UNAVAILABLE",
          `The local runtime is ${this.state}; it is being checked in the background and no cloud fallback is used`,
        );
    }
  }

  /** A turn saw the runtime fail: mark it unavailable and re-check in the background. */
  markUnavailable(reason: string): void {
    if (this.state === "ready") {
      this.lifecycle.transition("unavailable", reason);
      void this.ensureStarted();
    }
  }

  stop(): void {
    this.abort.abort();
    this.abort = new AbortController();
    if (this.state === "ready" || this.state === "starting" || this.state === "unavailable" || this.state === "error") {
      this.lifecycle.transition("stopped", "Stopped by the server");
    }
  }
}
