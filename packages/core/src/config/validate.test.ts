import { describe, it, expect } from "vitest";
import { validateDeployConfig } from "./validate.js";
import { baseConfig } from "./fixtures.js";

describe("validateDeployConfig — agent credential (Blueprint §4.1 / B02)", () => {
  it("accepts the base config (the agent key is generated at .env time)", () => {
    expect(validateDeployConfig(baseConfig())).toEqual([]);
  });

  it("accepts an explicit agent key that differs from the owner key", () => {
    const cfg = baseConfig();
    cfg.mcp.agentApiKey = "agent-only-credential";
    cfg.mcp.installationId = "11111111-2222-3333-4444-555555555555";
    expect(validateDeployConfig(cfg)).toEqual([]);
  });

  it("rejects an agent key equal to the owner key", () => {
    const cfg = baseConfig();
    cfg.mcp.agentApiKey = cfg.mcp.internalApiKey;
    expect(validateDeployConfig(cfg)).toContain(
      "mcp.agentApiKey must differ from mcp.internalApiKey (Blueprint §4.1 / B02)",
    );
  });

  it("validates local LLM provider configuration and rejects public endpoints", () => {
    const cfg = baseConfig();
    cfg.ai = {
      kind: "local",
      runtime: "ollama",
      baseUrl: "https://api.openai.com/v1",
      model: "qwen2.5:7b",
    };
    const errors = validateDeployConfig(cfg);
    expect(errors).toContain("local provider baseUrl must be loopback (or allowLan must be enabled)");

    // Valid loopback baseUrl passes
    cfg.ai.baseUrl = "http://127.0.0.1:11434";
    expect(validateDeployConfig(cfg)).toEqual([]);

    // Missing runtime/model
    cfg.ai.runtime = "" as any;
    expect(validateDeployConfig(cfg)).toContain("ai.runtime is required for local provider");
  });
});

describe("local inference config alignment with the endpoint policy (LOC-06)", () => {
  function localCfg(overrides: Record<string, unknown>) {
    const cfg: any = baseConfig();
    cfg.ai = {
      kind: "local",
      runtime: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      model: "qwen2.5:7b",
      ...overrides,
    };
    return cfg;
  }

  it("accepts a loopback endpoint", () => {
    expect(validateDeployConfig(localCfg({}))).toEqual([]);
  });

  it("requires the LAN host to be allow-listed", () => {
    const errors = validateDeployConfig(localCfg({ baseUrl: "http://inference.lan:11434", allowLan: true }));
    expect(errors.join(" ")).toContain("ai.endpointHosts must include 'inference.lan'");

    const ok = validateDeployConfig(localCfg({
      baseUrl: "http://inference.lan:11434",
      allowLan: true,
      endpointHosts: ["inference.lan"],
    }));
    expect(ok).toEqual([]);
  });

  it("refuses a LAN endpoint without allowLan", () => {
    const errors = validateDeployConfig(localCfg({ baseUrl: "http://192.168.1.50:11434" }));
    expect(errors.join(" ")).toContain("must be loopback");
  });

  it("refuses a public endpoint even with allowLan", () => {
    const errors = validateDeployConfig(localCfg({ baseUrl: "http://8.8.8.8:11434", allowLan: true }));
    expect(errors.join(" ")).toContain("public internet address");
  });

  it("refuses https because the provider cannot pin a certificate yet", () => {
    const errors = validateDeployConfig(localCfg({ baseUrl: "https://127.0.0.1:11434" }));
    expect(errors.join(" ")).toContain("must use http");
  });
});
