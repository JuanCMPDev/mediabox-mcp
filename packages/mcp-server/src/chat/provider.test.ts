import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getChatProvider, chatProviderInfo, resetChatProviderForTesting } from "./provider.js";

describe("Chat Provider & Diagnostics (LOC-04, LOC-10)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetChatProviderForTesting();
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.GOOGLE_AI_API_KEY;
    delete process.env.LLM_PROVIDER;
    delete process.env.LLM_MODEL;
    delete process.env.LOCAL_LLM_RUNTIME;
    delete process.env.LOCAL_LLM_BASE_URL;
    delete process.env.LOCAL_LLM_MODEL;
    delete process.env.INFERENCE_BACKEND;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetChatProviderForTesting();
  });

  it("resolves local provider and returns diagnostic info with mode=local", () => {
    process.env.LLM_PROVIDER = "local";
    process.env.LOCAL_LLM_RUNTIME = "ollama";
    process.env.LOCAL_LLM_BASE_URL = "http://127.0.0.1:11434";
    process.env.LOCAL_LLM_MODEL = "qwen2.5:7b";
    process.env.INFERENCE_BACKEND = "rocm";

    const provider = getChatProvider();
    expect(provider.providerName).toBe("local");
    expect(provider.model).toBe("qwen2.5:7b");

    const info = chatProviderInfo();
    expect(info).not.toBeNull();
    expect(info?.mode).toBe("local");
    expect(info?.provider).toBe("local");
    expect(info?.model).toBe("qwen2.5:7b");
    expect(info?.runtime).toBe("ollama");
    expect(info?.backend).toBe("rocm");
    expect(info?.agentCompatible).toBe(true);

    // Diagnostics must not expose any secrets or tokens (LOC-10)
    const jsonStr = JSON.stringify(info);
    expect(jsonStr).not.toContain("API_KEY");
    expect(jsonStr).not.toContain("secret");
  });

  it("resolves openrouter provider and returns mode=cloud", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test-key";
    process.env.LLM_PROVIDER = "openrouter";
    process.env.LLM_MODEL = "openai/gpt-4o-mini";

    const info = chatProviderInfo();
    expect(info).not.toBeNull();
    expect(info?.mode).toBe("cloud");
    expect(info?.provider).toBe("openrouter");
    expect(info?.model).toBe("openai/gpt-4o-mini");

    // Must not leak openrouter key in info
    expect(JSON.stringify(info)).not.toContain("sk-or-test-key");
  });
});
