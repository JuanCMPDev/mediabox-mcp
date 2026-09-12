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

describe("PrivacyProfile validation (§3.1)", () => {
  it("accepts valid privacy profiles", () => {
    const cfg1 = baseConfig();
    cfg1.deployment.privacyProfile = "offline-library";
    cfg1.telegram = undefined;
    cfg1.ai = { kind: "local", runtime: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen2.5:7b" };
    expect(validateDeployConfig(cfg1)).toEqual([]);

    const cfg2 = baseConfig();
    cfg2.deployment.privacyProfile = "local-agent-online-media";
    cfg2.ai = { kind: "local", runtime: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen2.5:7b" };
    expect(validateDeployConfig(cfg2)).toEqual([]);
  });

  it("rejects unknown privacy profile", () => {
    const cfg = baseConfig();
    cfg.deployment.privacyProfile = "invalid-profile" as any;
    expect(validateDeployConfig(cfg)).toContain(
      "deployment.privacyProfile 'invalid-profile' is not a valid privacy profile",
    );
  });

  it("in offline-library: rejects cloud LLM provider and telegram bot", () => {
    const cfg = baseConfig();
    cfg.deployment.privacyProfile = "offline-library";
    cfg.telegram = {
      botToken: "tok",
      llm: { kind: "openrouter", apiKey: "k", model: "m" },
      allowedUserIds: [],
    };
    const errors = validateDeployConfig(cfg);
    expect(errors).toContain("deployment.privacyProfile=offline-library requires telegram to be disabled");
    expect(errors).toContain("deployment.privacyProfile=offline-library forbids cloud LLM provider 'openrouter'");
  });

  it("in local-agent-online-media: rejects cloud LLM provider for agent", () => {
    const cfg = baseConfig();
    cfg.deployment.privacyProfile = "local-agent-online-media";
    cfg.ai = { kind: "openrouter", apiKey: "k", model: "m" };
    const errors = validateDeployConfig(cfg);
    expect(errors).toContain(
      "deployment.privacyProfile=local-agent-online-media forbids cloud LLM provider 'openrouter' for agent inference",
    );
  });

  it("in offline-library: rejects mode=vps, whose Caddy needs Internet", () => {
    const cfg = baseConfig();
    cfg.deployment.privacyProfile = "offline-library";
    cfg.deployment.mode = "vps";
    cfg.deployment.baseDomain = "mediabox.example.com";
    cfg.deployment.letsEncryptEmail = "me@example.com";
    expect(validateDeployConfig(cfg)).toContain(
      "deployment.privacyProfile=offline-library is not available with mode=vps: Caddy needs Internet for certificates",
    );
  });

  it("accepts a strict profile without any AI provider", () => {
    const cfg = baseConfig();
    cfg.deployment.privacyProfile = "offline-library";
    expect(validateDeployConfig(cfg)).toEqual([]);
  });
});

describe("strict profiles need the containerized, pinnable runtime (§3.1, §3.2)", () => {
  const PROFILES = ["offline-library", "local-agent-online-media"] as const;

  function strictCfg(profile: (typeof PROFILES)[number], overrides: Record<string, unknown>) {
    const cfg: any = baseConfig();
    cfg.deployment.privacyProfile = profile;
    cfg.ai = { kind: "local", runtime: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen2.5:7b", ...overrides };
    return cfg;
  }

  it.each(PROFILES)("%s: rejects runtimes whose weights prepare cannot pin", (profile) => {
    for (const runtime of ["llamacpp", "lmstudio", "vllm", "openai-compatible"]) {
      expect(validateDeployConfig(strictCfg(profile, { runtime }))).toContain(
        `deployment.privacyProfile=${profile} requires ai.runtime 'ollama': prepare can only pin and verify Ollama model manifests before run (got '${runtime}')`,
      );
    }
  });

  it.each(PROFILES)("%s: rejects host-native and LAN endpoints the internal network cannot reach", (profile) => {
    for (const host of ["host.docker.internal", "192.168.1.50", "inference.lan"]) {
      const errors = validateDeployConfig(strictCfg(profile, {
        baseUrl: `http://${host}:11434`,
        allowLan: true,
        endpointHosts: [host],
      }));
      expect(errors).toEqual([
        `deployment.privacyProfile=${profile} requires a loopback ai.baseUrl served by the compose inference container (mediabox-inference); '${host}' is a host-native or LAN runtime that the internal inference network cannot reach`,
      ]);
    }
  });

  it("applies to the Telegram LLM when it is the only local provider", () => {
    const cfg: any = baseConfig();
    cfg.deployment.privacyProfile = "local-agent-online-media";
    cfg.telegram = {
      botToken: "tok",
      llm: { kind: "local", runtime: "lmstudio", baseUrl: "http://127.0.0.1:1234", model: "m" },
      allowedUserIds: [],
    };
    expect(validateDeployConfig(cfg).join(" ")).toContain("requires ai.runtime 'ollama'");
  });

  it("keeps accepting LAN and non-Ollama runtimes without a privacy profile", () => {
    const cfg: any = baseConfig();
    cfg.ai = {
      kind: "local",
      runtime: "lmstudio",
      baseUrl: "http://host.docker.internal:1234",
      model: "m",
      allowLan: true,
      endpointHosts: ["host.docker.internal"],
    };
    expect(validateDeployConfig(cfg)).toEqual([]);
  });
});
