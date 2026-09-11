import type { HardwareProfile } from "../hardware/types.js";
import type { ModelProfile, ModelFit } from "./types.js";

const GB = 1024 * 1024 * 1024;

export const MODEL_CATALOG: ModelProfile[] = [
  {
    id: "qwen2.5-7b-instruct",
    family: "qwen",
    runtimeModelName: {
      ollama: "qwen2.5:7b",
      lmstudio: "qwen2.5-7b-instruct",
      llamacpp: "qwen2.5-7b-instruct-q4_k_m.gguf",
      vllm: "Qwen/Qwen2.5-7B-Instruct",
    },
    paramsTotal: 7.61,
    quantization: "Q4_K_M",
    weightsBytes: Math.round(4.7 * GB),
    contextTokens: 8192,
    toolCalling: "native",
    reasoning: "none",
    minimum: {
      vramBytes: Math.round(6.5 * GB),
      ramBytes: Math.round(12 * GB),
    },
    tier: "T1-6gb",
    license: "Apache-2.0",
    certified: true,
  },
  {
    id: "qwen2.5-3b-instruct",
    family: "qwen",
    runtimeModelName: {
      ollama: "qwen2.5:3b",
      lmstudio: "qwen2.5-3b-instruct",
      llamacpp: "qwen2.5-3b-instruct-q4_k_m.gguf",
      vllm: "Qwen/Qwen2.5-3B-Instruct",
    },
    paramsTotal: 3.09,
    quantization: "Q4_K_M",
    weightsBytes: Math.round(2.1 * GB),
    contextTokens: 8192,
    toolCalling: "native",
    reasoning: "none",
    minimum: {
      vramBytes: Math.round(3.5 * GB),
      ramBytes: Math.round(6 * GB),
    },
    tier: "T0-cpu",
    license: "Apache-2.0",
    certified: false,
  },
  {
    id: "qwen2.5-14b-instruct",
    family: "qwen",
    runtimeModelName: {
      ollama: "qwen2.5:14b",
      lmstudio: "qwen2.5-14b-instruct",
      llamacpp: "qwen2.5-14b-instruct-q4_k_m.gguf",
      vllm: "Qwen/Qwen2.5-14B-Instruct",
    },
    paramsTotal: 14.77,
    quantization: "Q4_K_M",
    weightsBytes: Math.round(9.0 * GB),
    contextTokens: 8192,
    toolCalling: "native",
    reasoning: "none",
    minimum: {
      vramBytes: Math.round(12.0 * GB),
      ramBytes: Math.round(18 * GB),
    },
    tier: "T2-12gb",
    license: "Apache-2.0",
    certified: false,
  },
  {
    id: "llama3.2-3b",
    family: "other",
    runtimeModelName: {
      ollama: "llama3.2:3b",
      lmstudio: "llama-3.2-3b-instruct",
      llamacpp: "llama-3.2-3b-instruct-q4_k_m.gguf",
      vllm: "meta-llama/Llama-3.2-3B-Instruct",
    },
    paramsTotal: 3.21,
    quantization: "Q4_K_M",
    weightsBytes: Math.round(2.0 * GB),
    contextTokens: 8192,
    toolCalling: "native",
    reasoning: "none",
    minimum: {
      vramBytes: Math.round(3.5 * GB),
      ramBytes: Math.round(6 * GB),
    },
    tier: "T0-cpu",
    license: "Llama-3.2",
    certified: false,
  },
];

export function getModelCatalog(): ModelProfile[] {
  return [...MODEL_CATALOG];
}

export function findModelProfile(id: string): ModelProfile | undefined {
  const norm = id.toLowerCase().trim();
  return MODEL_CATALOG.find((m) => {
    if (m.id.toLowerCase() === norm) return true;
    for (const val of Object.values(m.runtimeModelName)) {
      if (val && val.toLowerCase() === norm) return true;
    }
    return false;
  });
}

export function evaluateModelFit(model: ModelProfile, hardware: HardwareProfile): ModelFit {
  const warnings: string[] = [];
  const maxGpuVram = Math.max(0, ...hardware.gpus.map((g) => g.vramBytes ?? 0));
  const hasGpu = hardware.gpus.length > 0 && maxGpuVram > 0;

  // If system has dedicated GPU VRAM
  if (hasGpu && model.minimum.vramBytes) {
    if (maxGpuVram >= model.minimum.vramBytes) {
      if (model.sharesGpuWithTranscode) {
        warnings.push("VRAM shared with media transcoding; throughput may decrease during active transcode");
      }
      return {
        modelId: model.id,
        status: "recommended",
        reason: `GPU has ${(maxGpuVram / GB).toFixed(1)} GB VRAM, exceeds minimum ${(model.minimum.vramBytes / GB).toFixed(1)} GB`,
        warnings,
      };
    }

    // GPU VRAM is insufficient. Can it run in system RAM?
    if (hardware.ramBytes >= model.minimum.ramBytes) {
      warnings.push(`GPU VRAM (${(maxGpuVram / GB).toFixed(1)} GB) is below minimum ${(model.minimum.vramBytes / GB).toFixed(1)} GB; model will spill into system RAM/CPU`);
      return {
        modelId: model.id,
        status: "supported",
        reason: `System RAM (${(hardware.ramBytes / GB).toFixed(1)} GB) is sufficient for CPU fallback`,
        warnings,
      };
    }

    return {
      modelId: model.id,
      status: "exceeds_memory",
      reason: `Requires ${(model.minimum.vramBytes / GB).toFixed(1)} GB VRAM or ${(model.minimum.ramBytes / GB).toFixed(1)} GB RAM; host has ${(maxGpuVram / GB).toFixed(1)} GB VRAM and ${(hardware.ramBytes / GB).toFixed(1)} GB RAM`,
      warnings,
    };
  }

  // CPU-only execution
  if (hardware.ramBytes >= model.minimum.ramBytes) {
    if (model.tier === "T0-cpu") {
      return {
        modelId: model.id,
        status: "recommended",
        reason: `Fits comfortably in system RAM (${(hardware.ramBytes / GB).toFixed(1)} GB)`,
        warnings,
      };
    }
    warnings.push("Runs on CPU; inference latency will be higher without GPU acceleration");
    return {
      modelId: model.id,
      status: "supported",
      reason: `System RAM (${(hardware.ramBytes / GB).toFixed(1)} GB) meets minimum ${(model.minimum.ramBytes / GB).toFixed(1)} GB`,
      warnings,
    };
  }

  return {
    modelId: model.id,
    status: "exceeds_memory",
    reason: `Model requires ${(model.minimum.ramBytes / GB).toFixed(1)} GB RAM, but host only has ${(hardware.ramBytes / GB).toFixed(1)} GB`,
    warnings,
  };
}

export function getRecommendedModels(hardware: HardwareProfile): Array<{ profile: ModelProfile; fit: ModelFit }> {
  return MODEL_CATALOG.map((profile) => ({
    profile,
    fit: evaluateModelFit(profile, hardware),
  })).sort((a, b) => {
    const score = (status: string) => (status === "recommended" ? 2 : status === "supported" ? 1 : 0);
    return score(b.fit.status) - score(a.fit.status);
  });
}
