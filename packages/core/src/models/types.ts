import type { LocalRuntimeKind } from "@mediabox/contracts";

export type ModelTier = "T0-cpu" | "T1-6gb" | "T2-12gb" | "T3-24gb";
export type ModelFamily = "qwen" | "gemma" | "other";
export type ToolCallingSupport = "native" | "hermes-xml" | "none";
export type ReasoningSupport = "none" | "think-tags" | "reasoning-field";

/**
 * Architecture figures needed to size the KV cache (§3.4). They come from the
 * model's own config and are what turns a memory minimum into a computation
 * instead of a hand-typed constant.
 */
export interface ModelArchitecture {
  layers: number;
  kvHeads: number;
  headDim: number;
  /** Bytes per cached value: 2 for f16, 1 for an 8-bit quantised KV cache. */
  bytesPerValue: number;
}

export interface ModelProfile {
  id: string;
  family: ModelFamily;
  runtimeModelName: Partial<Record<LocalRuntimeKind, string>>;
  paramsTotal: number;
  paramsActive?: number;
  quantization: string;
  weightsBytes: number;
  contextTokens: number;
  architecture: ModelArchitecture;
  toolCalling: ToolCallingSupport;
  reasoning: ReasoningSupport;
  minimum: {
    vramBytes?: number;
    ramBytes: number;
  };
  tier: ModelTier;
  license: string;
  /**
   * True only when the lab canary AND a performance profile were measured on real
   * hardware for this model (§3.1.4 / 7.5). Never set from a passing canary alone.
   */
  certified: boolean;
  /** Whether the GPU it would use is also the one Jellyfin transcodes on (§3.4). */
  sharesGpuWithTranscode?: boolean;
  /** Free-form note surfaced in the UI, e.g. licence obligations. */
  licenseNote?: string;
}

export type ModelFitStatus = "recommended" | "supported" | "exceeds_memory";

export interface ModelFit {
  modelId: string;
  status: ModelFitStatus;
  reason?: string;
  warnings: string[];
  /** Memory the profile needs at its configured context, as computed. */
  requiredBytes?: { weights: number; kvCache: number; total: number };
}
