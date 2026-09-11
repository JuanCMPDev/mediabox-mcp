/* ─── Local model catalog and sizing (§3.4 / LOC-09) ─────────────────────────
 * Memory minimums are computed from the architecture, not hand-typed: weights plus
 * the KV cache at the profile's context, plus 20% runtime overhead. P11 replaces the
 * computation with measurements; until then the formula is what the UI shows.
 *
 * `certified` stays false until BOTH the canary and a performance profile were
 * measured on real hardware (§3.1.4).
 * ──────────────────────────────────────────────────────────────────────── */
import type { HardwareProfile } from "../hardware/types.js";
import type { ModelArchitecture, ModelProfile, ModelFit } from "./types.js";

const GB = 1024 * 1024 * 1024;

/** Runtime overhead over weights + KV cache: buffers, graph, fragmentation (§3.4). */
export const RUNTIME_OVERHEAD_FACTOR = 1.2;

/**
 * KV cache size: 2 (K and V) × layers × kv heads × head dim × bytes × context.
 * Runtimes may quantise the cache, which only makes this an upper bound.
 */
export function kvCacheBytes(architecture: ModelArchitecture, contextTokens: number): number {
  return (
    2 *
    architecture.layers *
    architecture.kvHeads *
    architecture.headDim *
    architecture.bytesPerValue *
    contextTokens
  );
}

/** Total memory the model needs to serve `contextTokens`, including overhead. */
export function requiredMemoryBytes(
  model: Pick<ModelProfile, "weightsBytes" | "architecture">,
  contextTokens: number,
): { weights: number; kvCache: number; total: number } {
  const kv = kvCacheBytes(model.architecture, contextTokens);
  return {
    weights: model.weightsBytes,
    kvCache: kv,
    total: Math.round((model.weightsBytes + kv) * RUNTIME_OVERHEAD_FACTOR),
  };
}

interface CatalogSeed extends Omit<ModelProfile, "minimum"> {
  /** Extra RAM the host needs beyond the model itself when running on CPU. */
  hostRamHeadroomBytes: number;
}

const SEEDS: CatalogSeed[] = [
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
    // Qwen2.5-7B: 28 layers, 4 KV heads (GQA), head dim 128
    architecture: { layers: 28, kvHeads: 4, headDim: 128, bytesPerValue: 2 },
    toolCalling: "native",
    reasoning: "none",
    tier: "T1-6gb",
    license: "Apache-2.0",
    certified: false,
    hostRamHeadroomBytes: Math.round(4 * GB),
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
    // Qwen2.5-3B: 36 layers, 2 KV heads, head dim 128
    architecture: { layers: 36, kvHeads: 2, headDim: 128, bytesPerValue: 2 },
    toolCalling: "native",
    reasoning: "none",
    tier: "T0-cpu",
    license: "Apache-2.0",
    certified: false,
    hostRamHeadroomBytes: Math.round(3 * GB),
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
    // Qwen2.5-14B: 48 layers, 8 KV heads, head dim 128
    architecture: { layers: 48, kvHeads: 8, headDim: 128, bytesPerValue: 2 },
    toolCalling: "native",
    reasoning: "none",
    tier: "T2-12gb",
    license: "Apache-2.0",
    certified: false,
    hostRamHeadroomBytes: Math.round(4 * GB),
  },
  {
    id: "qwen2.5-32b-instruct",
    family: "qwen",
    runtimeModelName: {
      ollama: "qwen2.5:32b",
      lmstudio: "qwen2.5-32b-instruct",
      llamacpp: "qwen2.5-32b-instruct-q4_k_m.gguf",
      vllm: "Qwen/Qwen2.5-32B-Instruct",
    },
    paramsTotal: 32.76,
    quantization: "Q4_K_M",
    weightsBytes: Math.round(19.9 * GB),
    contextTokens: 8192,
    // Qwen2.5-32B: 64 layers, 8 KV heads, head dim 128
    architecture: { layers: 64, kvHeads: 8, headDim: 128, bytesPerValue: 2 },
    toolCalling: "native",
    reasoning: "none",
    tier: "T3-24gb",
    license: "Apache-2.0",
    certified: false,
    hostRamHeadroomBytes: Math.round(6 * GB),
  },
  {
    id: "gemma-3-12b-it",
    family: "gemma",
    runtimeModelName: {
      ollama: "gemma3:12b",
      lmstudio: "gemma-3-12b-it",
      llamacpp: "gemma-3-12b-it-q4_k_m.gguf",
      vllm: "google/gemma-3-12b-it",
    },
    paramsTotal: 12.2,
    quantization: "Q4_K_M",
    weightsBytes: Math.round(7.3 * GB),
    contextTokens: 8192,
    // Gemma 3 12B: 48 layers, 8 KV heads, head dim 256
    architecture: { layers: 48, kvHeads: 8, headDim: 256, bytesPerValue: 2 },
    toolCalling: "native",
    reasoning: "none",
    tier: "T2-12gb",
    license: "Gemma Terms of Use",
    licenseNote:
      "Google's Gemma Terms of Use apply to the weights and to outputs; review and accept them before downloading (§6.14).",
    certified: false,
    hostRamHeadroomBytes: Math.round(4 * GB),
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
    // Llama 3.2 3B: 28 layers, 8 KV heads, head dim 128
    architecture: { layers: 28, kvHeads: 8, headDim: 128, bytesPerValue: 2 },
    toolCalling: "native",
    reasoning: "none",
    tier: "T0-cpu",
    license: "Llama 3.2 Community License",
    licenseNote: "Meta's Llama 3.2 Community License applies; review it before downloading (§6.14).",
    certified: false,
    hostRamHeadroomBytes: Math.round(3 * GB),
  },
];

function materialise(seed: CatalogSeed): ModelProfile {
  const { hostRamHeadroomBytes, ...profile } = seed;
  const required = requiredMemoryBytes(seed, seed.contextTokens);
  return {
    ...profile,
    minimum: {
      vramBytes: required.total,
      ramBytes: required.total + hostRamHeadroomBytes,
    },
  };
}

export const MODEL_CATALOG: ModelProfile[] = SEEDS.map(materialise);

export function getModelCatalog(): ModelProfile[] {
  return MODEL_CATALOG.map(m => ({ ...m }));
}

export function findModelProfile(id: string): ModelProfile | undefined {
  const norm = id.toLowerCase().trim();
  return MODEL_CATALOG.find(m => {
    if (m.id.toLowerCase() === norm) return true;
    for (const val of Object.values(m.runtimeModelName)) {
      if (val && val.toLowerCase() === norm) return true;
    }
    return false;
  });
}

function gb(bytes: number): string {
  return `${(bytes / GB).toFixed(1)} GB`;
}

export function evaluateModelFit(
  model: ModelProfile,
  hardware: HardwareProfile,
  contextTokens = model.contextTokens,
): ModelFit {
  const warnings: string[] = [];
  const required = requiredMemoryBytes(model, contextTokens);
  const maxGpuVram = Math.max(0, ...hardware.gpus.map(g => g.vramBytes ?? 0));
  const hasGpu = hardware.gpus.length > 0 && maxGpuVram > 0;

  if (model.licenseNote) warnings.push(model.licenseNote);
  if (model.sharesGpuWithTranscode) {
    warnings.push(
      "This GPU also serves Jellyfin transcoding; throughput of both drops while a transcode runs (measured in P11).",
    );
  }
  if (!model.certified) {
    warnings.push("Not certified: no lab canary and performance profile have been measured for this model yet.");
  }

  if (hasGpu) {
    if (maxGpuVram >= required.total) {
      return {
        modelId: model.id,
        status: "recommended",
        reason: `GPU has ${gb(maxGpuVram)} of VRAM, above the ${gb(required.total)} this model needs at ${contextTokens} tokens`,
        warnings,
        requiredBytes: required,
      };
    }

    // Does not fit in VRAM. Spilling to CPU only works with enough system RAM.
    if (hardware.ramBytes >= required.total + GB) {
      warnings.push(
        `Only ${gb(maxGpuVram)} of VRAM for ${gb(required.total)} of weights and KV cache: the runtime will spill to CPU and run far slower.`,
      );
      return {
        modelId: model.id,
        status: "supported",
        reason: `System RAM (${gb(hardware.ramBytes)}) can hold the model, but not the GPU`,
        warnings,
        requiredBytes: required,
      };
    }

    return {
      modelId: model.id,
      status: "exceeds_memory",
      reason: `Needs ${gb(required.total)}; host has ${gb(maxGpuVram)} of VRAM and ${gb(hardware.ramBytes)} of RAM`,
      warnings,
      requiredBytes: required,
    };
  }

  // CPU-only host
  if (hardware.ramBytes >= model.minimum.ramBytes) {
    if (model.tier === "T0-cpu") {
      return {
        modelId: model.id,
        status: "recommended",
        reason: `Fits in system RAM (${gb(hardware.ramBytes)}) and is sized for CPU inference`,
        warnings,
        requiredBytes: required,
      };
    }
    warnings.push("Runs on CPU only: expect several seconds per response at this size.");
    return {
      modelId: model.id,
      status: "supported",
      reason: `System RAM (${gb(hardware.ramBytes)}) meets the ${gb(model.minimum.ramBytes)} minimum`,
      warnings,
      requiredBytes: required,
    };
  }

  return {
    modelId: model.id,
    status: "exceeds_memory",
    reason: `Needs ${gb(model.minimum.ramBytes)} of RAM, host has ${gb(hardware.ramBytes)}`,
    warnings,
    requiredBytes: required,
  };
}

/**
 * Models the UI may offer, best first. A model that does not fit is excluded from
 * the recommendations entirely (§3.4): it only appears if the owner forces it, and
 * then `evaluateModelFit` marks it `exceeds_memory` so the UI can say so.
 */
export function getRecommendedModels(
  hardware: HardwareProfile,
): Array<{ profile: ModelProfile; fit: ModelFit }> {
  return MODEL_CATALOG.map(profile => ({ profile, fit: evaluateModelFit(profile, hardware) }))
    .filter(entry => entry.fit.status !== "exceeds_memory")
    .sort((a, b) => {
      const score = (status: string) => (status === "recommended" ? 2 : 1);
      const byStatus = score(b.fit.status) - score(a.fit.status);
      if (byStatus !== 0) return byStatus;
      // Prefer the largest model that still fits.
      return b.profile.paramsTotal - a.profile.paramsTotal;
    });
}

/** Everything in the catalog with its fit, including models that do not fit. */
export function evaluateCatalog(
  hardware: HardwareProfile,
): Array<{ profile: ModelProfile; fit: ModelFit }> {
  return MODEL_CATALOG.map(profile => ({ profile, fit: evaluateModelFit(profile, hardware) }));
}
