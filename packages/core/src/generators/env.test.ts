import { describe, it, expect } from "vitest";
import { generateEnv, updateEnvKeys } from "./env.js";
import { baseConfig } from "../config/fixtures.js";

describe("generateEnv", () => {
  it("emits the baseline fields for a local deployment", () => {
    const env = generateEnv(baseConfig());
    expect(env).toContain("DEPLOYMENT_MODE=local");
    expect(env).toContain("TZ=UTC");
    expect(env).toContain("JELLYFIN_API_KEY=");
    expect(env).toContain("QBIT_PASSWORD=qbitpass1");
    expect(env).toContain("MCP_PUBLIC_URL=http://localhost:3000");
    expect(env).toContain("INTERNAL_API_KEY=deadbeef");
    expect(env).toContain("IMAGE_TAG=2.1.0-beta.0");
    // Telegram is absent → no LLM_PROVIDER line
    expect(env).not.toContain("LLM_PROVIDER=");
    expect(env).not.toContain("BASE_DOMAIN=");
  });

  it("fills in discovered API keys when provided", () => {
    const env = generateEnv(baseConfig(), {
      jellyfinApiKey: "jf-key",
      sonarrApiKey: "sn-key",
      radarrApiKey: "rd-key",
    });
    expect(env).toContain("JELLYFIN_API_KEY=jf-key");
    expect(env).toContain("SONARR_API_KEY=sn-key");
    expect(env).toContain("RADARR_API_KEY=rd-key");
  });

  it("emits BASE_DOMAIN when baseDomain is set", () => {
    const cfg = baseConfig();
    cfg.deployment.mode = "vps";
    cfg.deployment.baseDomain = "mediabox.example.com";
    cfg.deployment.letsEncryptEmail = "me@example.com";
    const env = generateEnv(cfg);
    expect(env).toContain("BASE_DOMAIN=mediabox.example.com");
  });

  it("emits CLOUDFLARE_TUNNEL_TOKEN when tunnelToken is set", () => {
    const cfg = baseConfig();
    cfg.deployment.mode = "tunnel";
    cfg.deployment.baseDomain = "mediabox.example.com";
    cfg.deployment.tunnelToken = "eyJt0k3n";
    const env = generateEnv(cfg);
    expect(env).toContain("CLOUDFLARE_TUNNEL_TOKEN=eyJt0k3n");
  });

  it("emits the openrouter telegram block", () => {
    const cfg = baseConfig();
    cfg.telegram = {
      botToken: "bot-tok",
      llm: { kind: "openrouter", apiKey: "or-key", model: "openai/gpt-4o" },
      allowedUserIds: [1, 2, 3],
    };
    const env = generateEnv(cfg);
    expect(env).toContain("TELEGRAM_BOT_TOKEN=bot-tok");
    expect(env).toContain("LLM_PROVIDER=openrouter");
    expect(env).toContain("OPENROUTER_API_KEY=or-key");
    expect(env).toContain("LLM_MODEL=openai/gpt-4o");
    expect(env).toContain("ALLOWED_TELEGRAM_USERS=1,2,3");
  });

  it("emits the google telegram block", () => {
    const cfg = baseConfig();
    cfg.telegram = {
      botToken: "bot-tok",
      llm: { kind: "google", apiKey: "g-key" },
      allowedUserIds: [],
    };
    const env = generateEnv(cfg);
    expect(env).toContain("LLM_PROVIDER=google");
    expect(env).toContain("GOOGLE_AI_API_KEY=g-key");
    expect(env).not.toContain("OPENROUTER_API_KEY=");
    expect(env).toContain("ALLOWED_TELEGRAM_USERS=");
  });
});

describe("updateEnvKeys", () => {
  it("replaces existing keys in place", () => {
    const input = "FOO=1\nBAR=2\nBAZ=3";
    const out = updateEnvKeys(input, { BAR: "22" });
    expect(out).toBe("FOO=1\nBAR=22\nBAZ=3");
  });

  it("appends new keys not already present", () => {
    const input = "FOO=1";
    const out = updateEnvKeys(input, { NEW: "x" });
    expect(out).toBe("FOO=1\nNEW=x");
  });

  it("handles an empty updates map", () => {
    const input = "FOO=1";
    expect(updateEnvKeys(input, {})).toBe(input);
  });

  it("replaces empty values", () => {
    const input = "SONARR_API_KEY=";
    expect(updateEnvKeys(input, { SONARR_API_KEY: "real" })).toBe(
      "SONARR_API_KEY=real",
    );
  });
});
