import type { LocalRuntimeKind } from "@mediabox/contracts";

export type ModelTier = "T0-cpu" | "T1-6gb" | "T2-12gb" | "T3-24gb";
export type ModelFamily = "qwen" | "gemma" | "other";
export type ToolCallingSupport = "native" | "hermes-xml" | "none";
export type ReasoningSupport = "none" | "think-tags" | "reasoning-field";

export interface ModelProfile {
  id: string;
  family: ModelFamily;
  runtimeModelName: Partial<Record<LocalRuntimeKind, string>>;
  paramsTotal: number;
  paramsActive?: number;
  quantization: string;
  weightsBytes: number;
  contextTokens: number;
  toolCalling: ToolCallingSupport;
  reasoning: ReasoningSupport;
  minimum: {
    vramBytes?: number;
    ramBytes: number;
  };
  tier: ModelTier;
  license: string;
  certified: boolean;
  sharesGpuWithTranscode?: boolean;
}

export type ModelFitStatus = "recommended" | "supported" | "exceeds_memory";

export interface ModelFit {
  modelId: string;
  status: ModelFitStatus;
  reason?: string;
  warnings: string[];
}
