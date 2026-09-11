import { describe, it, expect } from "vitest";
import {
  getModelCatalog,
  findModelProfile,
  evaluateModelFit,
  getRecommendedModels,
} from "./catalog.js";
import type { HardwareProfile } from "../hardware/types.js";

const GB = 1024 * 1024 * 1024;

function createMockHardware(vramGb: number, ramGb: number): HardwareProfile {
  return {
    os: "windows",
    arch: "x64",
    cpu: { model: "AMD Ryzen 7", cores: 8, flags: ["avx2"] },
    ramBytes: ramGb * GB,
    gpus: vramGb > 0 ? [
      {
        vendor: "amd",
        name: "AMD Radeon RX 7800 XT",
        vramBytes: vramGb * GB,
        backends: ["rocm", "vulkan"],
      },
    ] : [],
    container: { runtime: "docker", nvidiaToolkit: false, kfd: false, dri: false },
    detectedRuntimes: [],
    observedAt: new Date().toISOString(),
    probeErrors: [],
  };
}

describe("Model Profiles Catalog (LOC-09)", () => {
  it("exposes catalog with expected certified and tier properties", () => {
    const catalog = getModelCatalog();
    expect(catalog.length).toBeGreaterThanOrEqual(3);

    const qwen7b = catalog.find((m) => m.id === "qwen2.5-7b-instruct");
    expect(qwen7b).toBeDefined();
    expect(qwen7b?.contextTokens).toBe(8192);
    expect(qwen7b?.toolCalling).toBe("native");
    expect(qwen7b?.certified).toBe(true);
  });

  it("finds models by canonical ID or runtime model name", () => {
    expect(findModelProfile("qwen2.5-7b-instruct")?.id).toBe("qwen2.5-7b-instruct");
    expect(findModelProfile("qwen2.5:7b")?.id).toBe("qwen2.5-7b-instruct");
    expect(findModelProfile("qwen2.5:14b")?.id).toBe("qwen2.5-14b-instruct");
    expect(findModelProfile("llama3.2:3b")?.id).toBe("llama3.2-3b");
    expect(findModelProfile("unknown-model-xyz")).toBeUndefined();
  });

  it("evaluates model fit for 16 GB VRAM host (e.g. RX 7800 XT)", () => {
    const host = createMockHardware(16, 32);
    const qwen7b = findModelProfile("qwen2.5-7b-instruct")!;
    const qwen14b = findModelProfile("qwen2.5-14b-instruct")!;

    const fit7b = evaluateModelFit(qwen7b, host);
    expect(fit7b.status).toBe("recommended");
    expect(fit7b.warnings).toHaveLength(0);

    const fit14b = evaluateModelFit(qwen14b, host);
    expect(fit14b.status).toBe("recommended");
  });

  it("evaluates model fit for 6 GB VRAM host", () => {
    const host = createMockHardware(6, 32);
    const qwen14b = findModelProfile("qwen2.5-14b-instruct")!;

    const fit14b = evaluateModelFit(qwen14b, host);
    expect(fit14b.status).toBe("supported"); // spills to 32 GB system RAM
    expect(fit14b.warnings.some((w) => w.includes("spill"))).toBe(true);
  });

  it("evaluates model fit for low memory machine (4 GB RAM, 0 VRAM)", () => {
    const host = createMockHardware(0, 4);
    const qwen7b = findModelProfile("qwen2.5-7b-instruct")!;
    const fit7b = evaluateModelFit(qwen7b, host);
    expect(fit7b.status).toBe("exceeds_memory");
  });

  it("sorts recommended models before unsupported models", () => {
    const host = createMockHardware(6, 16);
    const recommendations = getRecommendedModels(host);
    expect(recommendations.length).toBeGreaterThan(0);
    // First should be recommended
    expect(recommendations[0].fit.status).toBe("recommended");
  });
});
