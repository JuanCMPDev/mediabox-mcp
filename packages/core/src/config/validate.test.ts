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
});
