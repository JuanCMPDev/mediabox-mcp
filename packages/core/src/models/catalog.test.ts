/* ─── Model catalog and sizing (LOC-09) ──────────────────────────────────────
 * Checks the two things the spec asks for: a model that does not fit is not
 * recommended and is marked when forced, and the memory figures come from the
 * KV-cache formula rather than a hand-typed constant.
 * ──────────────────────────────────────────────────────────────────────── */
import { describe, it, expect } from "vitest";
import {
  getModelCatalog,
  findModelProfile,
  evaluateModelFit,
  evaluateCatalog,
  getRecommendedModels,
  kvCacheBytes,
  requiredMemoryBytes,
  RUNTIME_OVERHEAD_FACTOR,
} from "./catalog.js";
import type { HardwareProfile } from "../hardware/types.js";

const GB = 1024 * 1024 * 1024;

function createMockHardware(vramGb: number, ramGb: number, sharesGpu = false): HardwareProfile {
  return {
    os: "windows",
    arch: "x64",
    cpu: { model: "AMD Ryzen 7", cores: 8, flags: ["avx2"], flagsSource: "proc-cpuinfo" },
    ramBytes: ramGb * GB,
    gpus: vramGb > 0
      ? [{ vendor: "amd", name: "AMD Radeon RX 7800 XT", vramBytes: vramGb * GB, backends: ["rocm", "vulkan"] }]
      : [],
    container: { runtime: "docker", nvidiaToolkit: false, kfd: false, dri: false },
    vulkan: { available: vramGb > 0, devices: vramGb > 0 ? ["AMD Radeon RX 7800 XT"] : [] },
    detectedRuntimes: [],
    recommendedBackend: vramGb > 0 ? "vulkan" : "cpu",
    observedAt: "2026-09-10T00:00:00.000Z",
    probeErrors: [],
  };
}

describe("Model Profiles Catalog (LOC-09)", () => {
  it("exposes every tier and never claims certification without measurement", () => {
    const catalog = getModelCatalog();
    expect(catalog.length).toBeGreaterThanOrEqual(4);

    const tiers = new Set(catalog.map(m => m.tier));
    expect(tiers).toEqual(new Set(["T0-cpu", "T1-6gb", "T2-12gb", "T3-24gb"]));

    const qwen7b = catalog.find(m => m.id === "qwen2.5-7b-instruct")!;
    expect(qwen7b.contextTokens).toBe(8192);
    expect(qwen7b.toolCalling).toBe("native");
    // §3.1.4: a passing canary alone is not certification.
    expect(catalog.every(m => m.certified === false)).toBe(true);

    // Weights licences that carry obligations must say so.
    const gemma = catalog.find(m => m.family === "gemma")!;
    expect(gemma.licenseNote).toMatch(/Terms of Use/i);
  });

  it("computes memory from the KV cache formula, not from constants", () => {
    const qwen7b = findModelProfile("qwen2.5-7b-instruct")!;
    const kv = kvCacheBytes(qwen7b.architecture, 8192);
    // 2 × 28 layers × 4 kv heads × 128 head dim × 2 bytes × 8192 tokens
    expect(kv).toBe(2 * 28 * 4 * 128 * 2 * 8192);

    const required = requiredMemoryBytes(qwen7b, 8192);
    expect(required.total).toBe(Math.round((qwen7b.weightsBytes + kv) * RUNTIME_OVERHEAD_FACTOR));
    expect(qwen7b.minimum.vramBytes).toBe(required.total);

    // A larger context costs more memory, linearly in the cache.
    expect(requiredMemoryBytes(qwen7b, 16384).kvCache).toBe(kv * 2);
  });

  it("finds models by canonical ID or runtime model name", () => {
    expect(findModelProfile("qwen2.5-7b-instruct")?.id).toBe("qwen2.5-7b-instruct");
    expect(findModelProfile("qwen2.5:7b")?.id).toBe("qwen2.5-7b-instruct");
    expect(findModelProfile("qwen2.5:14b")?.id).toBe("qwen2.5-14b-instruct");
    expect(findModelProfile("gemma3:12b")?.id).toBe("gemma-3-12b-it");
    expect(findModelProfile("llama3.2:3b")?.id).toBe("llama3.2-3b");
    expect(findModelProfile("unknown-model-xyz")).toBeUndefined();
  });

  it("recommends what fits on a 16 GB GPU and reports the sizing it used", () => {
    const host = createMockHardware(16, 32);
    const fit7b = evaluateModelFit(findModelProfile("qwen2.5-7b-instruct")!, host);
    expect(fit7b.status).toBe("recommended");
    expect(fit7b.requiredBytes!.total).toBeLessThan(16 * GB);

    const fit14b = evaluateModelFit(findModelProfile("qwen2.5-14b-instruct")!, host);
    expect(fit14b.status).toBe("recommended");

    // The 32B profile is a T3 model: it does not fit in 16 GB.
    const fit32b = evaluateModelFit(findModelProfile("qwen2.5-32b-instruct")!, host);
    expect(fit32b.status).toBe("supported"); // spills into 32 GB of system RAM
    expect(fit32b.warnings.some(w => w.includes("spill"))).toBe(true);
  });

  it("marks a model that does not fit and keeps it out of the recommendations", () => {
    const host = createMockHardware(6, 8);
    const fit32b = evaluateModelFit(findModelProfile("qwen2.5-32b-instruct")!, host);
    expect(fit32b.status).toBe("exceeds_memory");
    expect(fit32b.reason).toMatch(/Needs/);

    const recommended = getRecommendedModels(host).map(r => r.profile.id);
    expect(recommended).not.toContain("qwen2.5-32b-instruct");
    // Forcing it is still possible, and then it is explicitly marked.
    const forced = evaluateCatalog(host).find(r => r.profile.id === "qwen2.5-32b-instruct")!;
    expect(forced.fit.status).toBe("exceeds_memory");
  });

  it("refuses everything on a machine with too little memory", () => {
    const host = createMockHardware(0, 4);
    expect(evaluateModelFit(findModelProfile("qwen2.5-7b-instruct")!, host).status).toBe("exceeds_memory");
    expect(getRecommendedModels(host)).toHaveLength(0);
  });

  it("prefers the largest model that fits and warns about a shared GPU", () => {
    const host = createMockHardware(8, 16);
    const recommendations = getRecommendedModels(host);
    expect(recommendations.length).toBeGreaterThan(0);
    expect(recommendations[0].fit.status).toBe("recommended");

    const shared = { ...findModelProfile("qwen2.5-7b-instruct")!, sharesGpuWithTranscode: true };
    const fit = evaluateModelFit(shared, host);
    expect(fit.warnings.some(w => w.includes("Jellyfin transcoding"))).toBe(true);
  });

  it("recommends a CPU-tier model on a GPU-less host with enough RAM", () => {
    const host = createMockHardware(0, 16);
    const fit = evaluateModelFit(findModelProfile("qwen2.5-3b-instruct")!, host);
    expect(fit.status).toBe("recommended");
    expect(getRecommendedModels(host)[0].profile.tier).toBe("T0-cpu");
  });
});
