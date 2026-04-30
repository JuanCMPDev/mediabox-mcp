import { describe, expect, it, vi, beforeEach } from "vitest";
import { validateUrl, resolveAndCheck, UrlPolicyError } from "./url-allowlist.js";

describe("validateUrl — scheme", () => {
  it.each(["https://example.com/x", "http://example.com/x"])("accepts %s", (u) => {
    expect(validateUrl(u).href).toBe(new URL(u).href);
  });

  it.each([
    "file:///etc/passwd",
    "ftp://example.com/x",
    "data:text/plain;base64,Zm9v",
    "javascript:alert(1)",
    "gopher://example.com/",
  ])("rejects scheme: %s", (u) => {
    expect(() => validateUrl(u)).toThrow(UrlPolicyError);
  });
});

describe("validateUrl — malformed", () => {
  it.each(["", "not a url", "://no-scheme"])("rejects %s", (u) => {
    expect(() => validateUrl(u)).toThrow(UrlPolicyError);
  });

  it("rejects non-string", () => {
    // @ts-expect-error
    expect(() => validateUrl(undefined)).toThrow(UrlPolicyError);
  });
});

describe("validateUrl — IPv4 literals", () => {
  it.each([
    "http://10.0.0.5/x",
    "http://10.255.255.255/",
    "http://127.0.0.1/",
    "http://127.1.2.3/",
    "http://169.254.169.254/latest/meta-data", // cloud metadata
    "http://172.16.0.1/",
    "http://172.31.255.255/",
    "http://192.168.1.1/",
    "http://0.0.0.0/",
    "http://100.64.0.1/",   // CGNAT lower
    "http://100.127.255.254/", // CGNAT upper
  ])("rejects private %s", (u) => {
    expect(() => validateUrl(u)).toThrow(UrlPolicyError);
  });

  it.each([
    "http://1.1.1.1/",
    "http://8.8.8.8/",
    "http://172.15.0.1/",      // just outside RFC1918
    "http://172.32.0.1/",      // just outside RFC1918
    "http://100.63.0.1/",      // just outside CGNAT
    "http://100.128.0.1/",     // just outside CGNAT
    "https://203.0.113.5/",
  ])("accepts public %s", (u) => {
    expect(validateUrl(u).href).toBe(new URL(u).href);
  });
});

describe("validateUrl — IPv6 literals", () => {
  it.each([
    "http://[::1]/",
    "http://[::]/",
    "http://[fc00::1]/",
    "http://[fd12:3456:789a::1]/",
    "http://[fe80::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:10.0.0.1]/",
  ])("rejects private %s", (u) => {
    expect(() => validateUrl(u)).toThrow(UrlPolicyError);
  });

  it.each(["http://[2606:4700:4700::1111]/", "http://[2001:db8::1]/"])("accepts public %s", (u) => {
    expect(validateUrl(u).href).toBe(new URL(u).href);
  });
});

describe("validateUrl — hostnames", () => {
  it.each(["http://localhost/", "http://foo.local/", "http://bar.internal/", "http://baz.localhost/"])(
    "rejects local hostname %s",
    (u) => {
      expect(() => validateUrl(u)).toThrow(UrlPolicyError);
    },
  );

  it.each(["https://example.com/", "https://files.example.org/x.zip"])("accepts public hostname %s", (u) => {
    expect(validateUrl(u).href).toBe(new URL(u).href);
  });
});

// ── resolveAndCheck ────────────────────────────────────────────────────────
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
}));

import { lookup } from "node:dns/promises";

describe("resolveAndCheck", () => {
  beforeEach(() => {
    vi.mocked(lookup).mockReset();
  });

  it("passes when hostname resolves to a public IPv4", async () => {
    vi.mocked(lookup).mockResolvedValueOnce([{ address: "1.1.1.1", family: 4 }]);
    await expect(resolveAndCheck(new URL("https://example.com/"))).resolves.toBeUndefined();
  });

  it("rejects when hostname resolves to a private IPv4", async () => {
    vi.mocked(lookup).mockResolvedValueOnce([{ address: "10.0.0.5", family: 4 }]);
    await expect(resolveAndCheck(new URL("https://internal.example/"))).rejects.toThrow(UrlPolicyError);
  });

  it("rejects when ANY resolved address is private (rebinding-style)", async () => {
    vi.mocked(lookup).mockResolvedValueOnce([
      { address: "1.1.1.1", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    await expect(resolveAndCheck(new URL("https://rebind.example/"))).rejects.toThrow(/private IPv4/);
  });

  it("rejects when hostname resolves to a private IPv6", async () => {
    vi.mocked(lookup).mockResolvedValueOnce([{ address: "::1", family: 6 }]);
    await expect(resolveAndCheck(new URL("https://example.com/"))).rejects.toThrow(UrlPolicyError);
  });

  it("skips DNS for IP-literal hostnames", async () => {
    await resolveAndCheck(new URL("http://1.1.1.1/"));
    expect(lookup).not.toHaveBeenCalled();
  });

  it("wraps DNS resolution failure", async () => {
    vi.mocked(lookup).mockRejectedValueOnce(new Error("ENOTFOUND"));
    await expect(resolveAndCheck(new URL("https://nope.invalid/"))).rejects.toThrow(/DNS resolution failed/);
  });
});
