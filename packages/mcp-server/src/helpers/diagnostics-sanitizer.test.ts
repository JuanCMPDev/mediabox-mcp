import { describe, it, expect } from "vitest";
import {
  sanitizeChatInfo,
  sanitizeString,
  findLeakedSecrets,
} from "./diagnostics-sanitizer.js";

describe("DiagnosticsSanitizer (P10 / §3.2, NET-05)", () => {
  it("drops non-allowlisted keys from ChatInfo", () => {
    const raw: any = {
      provider: "local",
      model: "qwen2.5:7b",
      mode: "local",
      secretInternalKey: "supersecret123",
      userPrompt: "¿Cómo descargar una película?",
      headers: { authorization: "Bearer sk-1234567890123456" },
      endpoint: "http://127.0.0.1:11434",
      privacyProfile: "offline-library",
    };

    const sanitized = sanitizeChatInfo(raw);
    expect(sanitized).toBeDefined();
    expect(sanitized!.provider).toBe("local");
    expect(sanitized!.privacyProfile).toBe("offline-library");
    expect((sanitized as any).secretInternalKey).toBeUndefined();
    expect((sanitized as any).userPrompt).toBeUndefined();
    expect((sanitized as any).headers).toBeUndefined();
  });

  it("redacts canary tokens and embedded passwords from strings", () => {
    const text = "Error connecting to http://user:superpass123@127.0.0.1:11434 with key sk-1234567890123456 and canary-abcdef0123456";
    const clean = sanitizeString(text);
    expect(clean).not.toContain("sk-1234567890123456");
    expect(clean).not.toContain("canary-abcdef0123456");
    expect(clean).not.toContain("superpass123");
    expect(clean).toContain("[REDACTED]");
  });

  it("findLeakedSecrets detects literal and URL-encoded secrets", () => {
    const secrets = [
      "canary-token-secret-xyz",
      "sk-proj-supersecretkey999",
      "special#secret%val",
    ];

    const safeReport = { provider: "local", status: "ok" };
    expect(findLeakedSecrets(safeReport, secrets)).toEqual([]);

    const leakyReport = {
      provider: "local",
      error: "Failed using special%23secret%25val to authenticate",
    };
    const leaks = findLeakedSecrets(leakyReport, secrets);
    expect(leaks).toContain("special#secret%val");
  });
});
