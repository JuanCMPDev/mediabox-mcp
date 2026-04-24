import { describe, it, expect } from "vitest";
import { generateCaddyfile } from "./caddyfile.js";
import { baseConfig } from "../config/fixtures.js";

describe("generateCaddyfile", () => {
  it("throws when baseDomain or letsEncryptEmail missing", () => {
    expect(() => generateCaddyfile(baseConfig())).toThrow(/baseDomain/);
  });

  it("emits reverse_proxy blocks for all services", () => {
    const cfg = baseConfig();
    cfg.deployment.mode = "vps";
    cfg.deployment.baseDomain = "mediabox.example.com";
    cfg.deployment.letsEncryptEmail = "me@example.com";
    const out = generateCaddyfile(cfg);
    expect(out).toContain("email me@example.com");
    expect(out).toContain("mediabox.example.com {");
    expect(out).toContain("jellyfin.mediabox.example.com {");
    expect(out).toContain("reverse_proxy mcp-server:3000");
    expect(out).toContain("reverse_proxy jellyfin:8096");
  });

  it("includes bazarr block only when enabled", () => {
    const cfg = baseConfig();
    cfg.deployment.mode = "vps";
    cfg.deployment.baseDomain = "m.example.com";
    cfg.deployment.letsEncryptEmail = "me@example.com";

    const without = generateCaddyfile(cfg);
    expect(without).not.toContain("bazarr.");

    cfg.services.bazarr.enabled = true;
    const withBazarr = generateCaddyfile(cfg);
    expect(withBazarr).toContain("bazarr.m.example.com");
    expect(withBazarr).toContain("reverse_proxy bazarr:6767");
  });
});
