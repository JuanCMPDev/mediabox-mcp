import { describe, expect, it, vi } from "vitest";
import {
  isAllowedOrigin,
  buildOriginMiddleware,
  buildCorsOriginCallback,
  type OriginPolicy,
} from "./origin.js";

const DEFAULT_POLICY: OriginPolicy = { allowed: [] };

describe("isAllowedOrigin", () => {
  it("rejects empty / non-string", () => {
    expect(isAllowedOrigin("", DEFAULT_POLICY)).toBe(false);
    // @ts-expect-error
    expect(isAllowedOrigin(undefined, DEFAULT_POLICY)).toBe(false);
  });

  describe("default policy (localhost + tauri allowed)", () => {
    it.each([
      "tauri://localhost",
      "http://tauri.localhost",
      "https://tauri.localhost",
      "http://localhost",
      "https://localhost",
      "http://localhost:3000",
      "http://localhost:5173",
      "http://127.0.0.1",
      "http://127.0.0.1:8080",
    ])("accepts %s", (o) => {
      expect(isAllowedOrigin(o, DEFAULT_POLICY)).toBe(true);
    });

    it.each([
      "http://evil.com",
      "https://attacker.example",
      "http://192.168.1.10:3000",
      "http://10.0.0.5",
      "http://example.com",
      "http://localhost.evil.com",
      "http://127.0.0.1.evil.com",
      "tauri://attacker",
    ])("rejects %s", (o) => {
      expect(isAllowedOrigin(o, DEFAULT_POLICY)).toBe(false);
    });
  });

  describe("explicit allowlist", () => {
    const policy: OriginPolicy = { allowed: ["https://mediabox.example.com"] };

    it("accepts an exact-match entry", () => {
      expect(isAllowedOrigin("https://mediabox.example.com", policy)).toBe(true);
    });

    it("rejects a near-match (different scheme)", () => {
      expect(isAllowedOrigin("http://mediabox.example.com", policy)).toBe(false);
    });

    it("rejects a near-match (different port)", () => {
      expect(isAllowedOrigin("https://mediabox.example.com:8443", policy)).toBe(false);
    });

    it("rejects a subdomain unless explicitly listed", () => {
      expect(isAllowedOrigin("https://api.mediabox.example.com", policy)).toBe(false);
    });
  });

  describe("disabled localhost", () => {
    const policy: OriginPolicy = { allowed: ["https://app.example"], allowLocalhost: false };
    it("rejects http://localhost", () => {
      expect(isAllowedOrigin("http://localhost:3000", policy)).toBe(false);
    });
    it("still accepts the explicit allowlist", () => {
      expect(isAllowedOrigin("https://app.example", policy)).toBe(true);
    });
    it("still accepts tauri by default", () => {
      expect(isAllowedOrigin("tauri://localhost", policy)).toBe(true);
    });
  });

  describe("disabled tauri", () => {
    const policy: OriginPolicy = { allowed: [], allowTauri: false };
    it("rejects tauri://localhost", () => {
      expect(isAllowedOrigin("tauri://localhost", policy)).toBe(false);
    });
  });
});

describe("buildOriginMiddleware", () => {
  function callMw(headers: Record<string, string | undefined>, policy = DEFAULT_POLICY) {
    const mw = buildOriginMiddleware(policy);
    const next = vi.fn();
    const status = vi.fn().mockReturnThis();
    const json = vi.fn().mockReturnThis();
    mw(
      { headers } as never,
      { status, json } as never,
      next,
    );
    return { next, status, json };
  }

  it("calls next() when no Origin header is present", () => {
    const { next, status } = callMw({});
    expect(next).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
  });

  it("calls next() when Origin is allowed", () => {
    const { next, status } = callMw({ origin: "tauri://localhost" });
    expect(next).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
  });

  it("returns 403 when Origin is denied", () => {
    const { next, status, json } = callMw({ origin: "http://evil.com" });
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({ error: "Origin not allowed", origin: "http://evil.com" });
  });
});

describe("buildCorsOriginCallback", () => {
  it("allows missing origin (non-browser callers)", () => {
    const cb = buildCorsOriginCallback(DEFAULT_POLICY);
    const next = vi.fn();
    cb(undefined, next);
    expect(next).toHaveBeenCalledWith(null, true);
  });

  it("allows known origins", () => {
    const cb = buildCorsOriginCallback(DEFAULT_POLICY);
    const next = vi.fn();
    cb("tauri://localhost", next);
    expect(next).toHaveBeenCalledWith(null, true);
  });

  it("denies unknown origins (returns false, not error)", () => {
    const cb = buildCorsOriginCallback(DEFAULT_POLICY);
    const next = vi.fn();
    cb("http://evil.com", next);
    expect(next).toHaveBeenCalledWith(null, false);
  });
});
