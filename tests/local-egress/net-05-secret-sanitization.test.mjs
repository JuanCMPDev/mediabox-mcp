import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeChatInfo,
  findLeakedSecrets,
} from "../../packages/mcp-server/dist/helpers/diagnostics-sanitizer.js";
import { chatProviderInfo } from "../../packages/mcp-server/dist/chat/provider.js";

describe("NET-05: Saneamiento de diagnósticos, secretos canario y conversaciones (§3.4)", () => {
  it("diagnostics and exportable reports contain zero canary secrets or user conversation phrases", () => {
    const canarySecrets = [
      "canary-secret-xyz-987",
      "sk-proj-super-secret-token-12345",
      "my_db_password_4321",
      "frase_conversacion_privada_usuario_888",
    ];

    // Simulate diagnostic report with in-memory state
    const rawReport = {
      provider: "local",
      model: "qwen2.5:7b",
      mode: "local",
      runtime: "ollama",
      endpoint: "http://127.0.0.1:11434",
      privacyProfile: "offline-library",
      // Potentially leaky fields that must be stripped:
      internalKey: canarySecrets[0],
      cloudToken: canarySecrets[1],
      dbUrl: `postgresql://user:${canarySecrets[2]}@localhost/db`,
      lastPrompt: `Por favor responde a: ${canarySecrets[3]}`,
    };

    const cleanReport = sanitizeChatInfo(rawReport);

    // Deep scan for secrets and unique phrases in clean report (literal and URL-encoded)
    const leaks = findLeakedSecrets(cleanReport, canarySecrets);
    assert.equal(
      leaks.length,
      0,
      `Diagnostics sanitizer leaked secrets: ${leaks.join(", ")}`,
    );

    // Verify only allowlisted fields survive
    assert.deepEqual(Object.keys(cleanReport).sort(), [
      "endpoint",
      "mode",
      "model",
      "privacyProfile",
      "provider",
      "runtime",
    ]);
  });

  it("chatProviderInfo() never leaks secrets from environment or runtime probes", () => {
    const oldKey = process.env.LOCAL_LLM_API_KEY;
    const canarySecret = "canary-api-key-secret-999";
    try {
      process.env.LOCAL_LLM_API_KEY = canarySecret;
      process.env.PRIVACY_PROFILE = "offline-library";

      const info = chatProviderInfo();
      if (info) {
        const leaks = findLeakedSecrets(info, [canarySecret]);
        assert.equal(leaks.length, 0, "chatProviderInfo must never expose LOCAL_LLM_API_KEY");
      }
    } finally {
      if (oldKey) process.env.LOCAL_LLM_API_KEY = oldKey;
      else delete process.env.LOCAL_LLM_API_KEY;
    }
  });
});
