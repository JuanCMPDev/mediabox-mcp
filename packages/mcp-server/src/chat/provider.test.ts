/* ─── Local provider wiring and diagnostics (LOC-04 / LOC-10) ────────────────
 * Checks the provider the server actually builds from the environment, and the
 * diagnostics it exposes over HTTP: never a key, and never an unmeasured claim.
 * ──────────────────────────────────────────────────────────────────────── */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { getChatProvider, chatProviderInfo, resetChatProviderForTesting, ensureChatProviderReady } from "./provider.js";
import { createApp } from "../index.js";
import { INTERNAL_API_KEY, AGENT_API_KEY } from "../auth.js";

const LOCAL_ENV_KEYS = [
  "OPENROUTER_API_KEY", "GOOGLE_AI_API_KEY", "LLM_PROVIDER", "LLM_MODEL",
  "LOCAL_LLM_RUNTIME", "LOCAL_LLM_BASE_URL", "LOCAL_LLM_MODEL", "LOCAL_LLM_API_KEY",
  "LOCAL_LLM_CONTEXT_TOKENS", "INFERENCE_BACKEND", "INFERENCE_ALLOW_LAN", "INFERENCE_ENDPOINT_HOSTS",
  "LOCAL_BASE_URL", "LOCAL_MODEL", "LOCAL_RUNTIME", "LOCAL_ALLOW_LAN",
];

describe("Chat Provider & Diagnostics (LOC-04, LOC-10)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetChatProviderForTesting();
    for (const key of LOCAL_ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetChatProviderForTesting();
  });

  it("builds the local provider from the canonical variables and reports the mode", () => {
    process.env.LLM_PROVIDER = "local";
    process.env.LOCAL_LLM_RUNTIME = "ollama";
    process.env.LOCAL_LLM_BASE_URL = "http://127.0.0.1:11434";
    process.env.LOCAL_LLM_MODEL = "qwen2.5:7b";
    process.env.LOCAL_LLM_CONTEXT_TOKENS = "8192";
    process.env.INFERENCE_BACKEND = "rocm";

    const provider = getChatProvider();
    expect(provider.providerName).toBe("local");
    expect(provider.model).toBe("qwen2.5:7b");

    const info = chatProviderInfo()!;
    expect(info.mode).toBe("local");
    expect(info.runtime).toBe("ollama");
    expect(info.backend).toBe("rocm");
    expect(info.contextTokens).toBe(8192);
    expect(info.configuredContextTokens).toBe(8192);
    expect(info.endpoint).toBe("http://127.0.0.1:11434");
    expect(info.endpointPolicy).toBe("loopback-only");
    // Tool-calling compatibility is only known after the lab canary: never asserted here.
    expect(info.agentCompatible).toBeUndefined();
  });

  it("never puts a key, a token or a full endpoint credential in the diagnostics", () => {
    process.env.LLM_PROVIDER = "local";
    process.env.LOCAL_LLM_BASE_URL = "http://user:s3cr3t-password@127.0.0.1:11434";
    process.env.LOCAL_LLM_API_KEY = "lm-studio-secret-key";
    process.env.OPENROUTER_API_KEY = "sk-or-v1-should-never-appear";

    const serialized = JSON.stringify(chatProviderInfo());
    expect(serialized).not.toContain("s3cr3t-password");
    expect(serialized).not.toContain("lm-studio-secret-key");
    expect(serialized).not.toContain("sk-or-v1-should-never-appear");
    expect(serialized).not.toContain("API_KEY");
  });

  it("stays local when a cloud key is present (LOC-03 at the server boundary)", () => {
    process.env.LLM_PROVIDER = "local";
    process.env.OPENROUTER_API_KEY = "sk-or-test-key";
    process.env.GOOGLE_AI_API_KEY = "google-test-key";

    expect(getChatProvider().providerName).toBe("local");
    expect(chatProviderInfo()!.mode).toBe("local");
  });

  it("reports the runtime context window when it is smaller than the profile (LOC-05)", async () => {
    const runtime = createServer((req, res) => {
      if (req.url === "/api/show") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ capabilities: ["completion", "tools"], model_info: { "qwen2.context_length": 4096 } }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>(resolve => runtime.listen(0, "127.0.0.1", () => resolve()));
    const port = (runtime.address() as any).port;

    try {
      process.env.LLM_PROVIDER = "local";
      process.env.LOCAL_LLM_BASE_URL = `http://127.0.0.1:${port}`;
      process.env.LOCAL_LLM_CONTEXT_TOKENS = "8192";

      await ensureChatProviderReady();
      const info = chatProviderInfo()!;
      expect(info.configuredContextTokens).toBe(8192);
      expect(info.runtimeContextTokens).toBe(4096);
      expect(info.contextTokens).toBe(4096);
      expect(info.warning).toMatch(/clipped to the runtime value/);
    } finally {
      runtime.close();
    }
  });

  it("resolves openrouter provider and returns mode=cloud", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test-key";
    process.env.LLM_PROVIDER = "openrouter";
    process.env.LLM_MODEL = "openai/gpt-4o-mini";

    const info = chatProviderInfo()!;
    expect(info.mode).toBe("cloud");
    expect(info.provider).toBe("openrouter");
    expect(info.model).toBe("openai/gpt-4o-mini");
    expect(JSON.stringify(info)).not.toContain("sk-or-test-key");
  });
});

describe("GET /api/chat/info over HTTP (LOC-10)", () => {
  let server: Server;
  let baseUrl: string;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.LLM_PROVIDER = "local";
    process.env.LOCAL_LLM_BASE_URL = "http://127.0.0.1:11434";
    process.env.LOCAL_LLM_MODEL = "qwen2.5:7b";
    process.env.LOCAL_LLM_API_KEY = "local-secret-key";
    process.env.OPENROUTER_API_KEY = "sk-or-v1-must-not-leak";
    resetChatProviderForTesting();

    const app = createApp();
    await new Promise<void>(resolve => {
      server = app.listen(0, "127.0.0.1", () => {
        baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    process.env = { ...originalEnv };
    resetChatProviderForTesting();
  });

  it("reports local mode to the owner without leaking any secret", async () => {
    const res = await fetch(`${baseUrl}/api/chat/info`, {
      headers: { Authorization: `Bearer ${INTERNAL_API_KEY}` },
    });
    expect(res.status).toBe(200);
    const body = await res.text();

    expect(body).not.toContain("local-secret-key");
    expect(body).not.toContain("sk-or-v1-must-not-leak");

    const info = JSON.parse(body);
    expect(info.mode).toBe("local");
    expect(info.model).toBe("qwen2.5:7b");
    expect(info.endpoint).toBe("http://127.0.0.1:11434");
    expect(info.agentCompatible).toBeUndefined();
  });

  it("reports the hardware profile and which models fit it (§3.3 / §3.4)", async () => {
    const res = await fetch(`${baseUrl}/api/setup/hardware`, {
      headers: { Authorization: `Bearer ${INTERNAL_API_KEY}` },
    });
    expect(res.status).toBe(200);
    const report = await res.json();

    expect(report.profile.cpu.cores).toBeGreaterThan(0);
    expect(report.profile.ramBytes).toBeGreaterThan(0);
    expect(Array.isArray(report.profile.detectedRuntimes)).toBe(true);
    expect(report.profile.recommendedBackend).toBeTruthy();
    expect(report.models.length).toBeGreaterThan(0);

    for (const model of report.models) {
      expect(["recommended", "supported", "exceeds_memory"]).toContain(model.status);
      // No model may claim certification without a measured lab profile (§3.1.4).
      expect(model.certified).toBe(false);
      expect(model.requiredBytes.total).toBeGreaterThan(0);
    }
    // The suggested model, when there is one, must be a model that fits.
    if (report.recommendedModelId) {
      const suggested = report.models.find((m: any) => m.id === report.recommendedModelId);
      expect(suggested.status).not.toBe("exceeds_memory");
    }
  }, 20_000);

  it("refuses a trace read to a non-owner principal", async () => {
    const res = await fetch(`${baseUrl}/api/chat/conv-does-not-exist/trace`, {
      headers: { Authorization: `Bearer ${AGENT_API_KEY}` },
    });
    // Either the policy layer rejects the agent, or the route does: never 200.
    expect([401, 403]).toContain(res.status);
  });
});
