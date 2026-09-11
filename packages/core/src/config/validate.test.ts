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
