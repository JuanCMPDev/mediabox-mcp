import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { generateDockerCompose } from "./docker-compose.js";
import { baseConfig } from "../config/fixtures.js";

describe("generateDockerCompose", () => {
  it("generates valid YAML with expected top-level keys", () => {
    const yaml = generateDockerCompose(baseConfig());
    const parsed = parse(yaml) as Record<string, unknown>;
    expect(parsed).toHaveProperty("services");
    expect(parsed).toHaveProperty("networks");
  });

  it("includes the core services for a local deployment", () => {
    const parsed = parse(generateDockerCompose(baseConfig())) as {
      services: Record<string, unknown>;
    };
    expect(Object.keys(parsed.services).sort()).toEqual(
      [
        "jellyfin",
        "mcp-server",
        "pyload",
        "qbittorrent",
        "flaresolverr",
        "prowlarr",
        "radarr",
        "sonarr",
      ].sort(),
    );
  });

  it("exposes ports publicly in local mode", () => {
    const parsed = parse(generateDockerCompose(baseConfig())) as any;
    expect(parsed.services.jellyfin.ports).toContain("8096:8096");
    // UDP discovery ports present only in local mode
    expect(parsed.services.jellyfin.ports).toContain("7359:7359/udp");
  });

  it("binds ports to 127.0.0.1 in VPS mode and adds caddy", () => {
    const cfg = baseConfig();
    cfg.deployment.mode = "vps";
    cfg.deployment.baseDomain = "mediabox.example.com";
    cfg.deployment.letsEncryptEmail = "me@example.com";
    const parsed = parse(generateDockerCompose(cfg)) as any;
    expect(parsed.services.jellyfin.ports).toContain("127.0.0.1:8096:8096");
    expect(parsed.services.jellyfin.ports).not.toContain("7359:7359/udp");
    expect(parsed.services).toHaveProperty("caddy");
  });

  it("adds cloudflared (and no caddy) in tunnel mode", () => {
    const cfg = baseConfig();
    cfg.deployment.mode = "tunnel";
    cfg.deployment.baseDomain = "mediabox.example.com";
    cfg.deployment.tunnelToken = "tok";
    const parsed = parse(generateDockerCompose(cfg)) as any;
    expect(parsed.services).toHaveProperty("cloudflared");
    expect(parsed.services).not.toHaveProperty("caddy");
    expect(parsed.services.jellyfin.ports).toContain("127.0.0.1:8096:8096");
  });

  it("includes telegram-bot when telegram config is present", () => {
    const cfg = baseConfig();
    cfg.telegram = {
      botToken: "bot",
      llm: { kind: "openrouter", apiKey: "k", model: "m" },
      allowedUserIds: [],
    };
    const parsed = parse(generateDockerCompose(cfg)) as any;
    expect(parsed.services).toHaveProperty("telegram-bot");
    expect(parsed.services["telegram-bot"].environment).toContain(
      "LLM_PROVIDER=openrouter",
    );
  });

  it("omits telegram-bot when telegram is absent", () => {
    const parsed = parse(generateDockerCompose(baseConfig())) as any;
    expect(parsed.services).not.toHaveProperty("telegram-bot");
  });

  it("includes bazarr when enabled", () => {
    const cfg = baseConfig();
    cfg.services.bazarr.enabled = true;
    const parsed = parse(generateDockerCompose(cfg)) as any;
    expect(parsed.services).toHaveProperty("bazarr");
  });

  it("uses a monorepo-root build context for mcp-server when localBuild is true (P0.3)", () => {
    const cfg = baseConfig();
    cfg.deployment.localBuild = true;
    const parsed = parse(generateDockerCompose(cfg)) as any;
    expect(parsed.services["mcp-server"].build).toEqual({
      context: ".",
      dockerfile: "packages/mcp-server/Dockerfile",
    });
    expect(parsed.services["mcp-server"].image).toBeUndefined();
  });

  it("uses a monorepo-root build context for telegram when localBuild is true (P0.3)", () => {
    const cfg = baseConfig();
    cfg.deployment.localBuild = true;
    cfg.telegram = {
      botToken: "bot",
      llm: { kind: "openrouter", apiKey: "k", model: "m" },
      allowedUserIds: [],
    };
    const parsed = parse(generateDockerCompose(cfg)) as any;
    expect(parsed.services["telegram-bot"].build).toEqual({
      context: ".",
      dockerfile: "packages/mcp-telegram-client/Dockerfile",
    });
    expect(parsed.services["telegram-bot"].image).toBeUndefined();
  });

  it("uses a GHCR image (with IMAGE_TAG default) when localBuild is false", () => {
    const parsed = parse(generateDockerCompose(baseConfig())) as any;
    expect(parsed.services["mcp-server"].image).toBe(
      "ghcr.io/juancmpdev/mediabox-mcp:${IMAGE_TAG:-2.2.0-beta.1}",
    );
    expect(parsed.services["mcp-server"].build).toBeUndefined();
  });

  it("renders media paths as ${MOVIES_PATH} env-var refs with the configured value as default", () => {
    const cfg = baseConfig();
    cfg.paths.movies = "media\\movies";
    const parsed = parse(generateDockerCompose(cfg)) as any;
    // PR 3.4a: paths are emitted as `${MOVIES_PATH:-./media/movies}` so
    // PATCH /api/setup/env can rewrite the path in `.env` and a recreate
    // picks it up. The default keeps backslashes normalized to POSIX.
    expect(parsed.services.jellyfin.volumes).toContain("${MOVIES_PATH:-./media/movies}:/data/movies");
  });

  it("never emits MCP_AUTH_SECRET (confirmed dead config)", () => {
    const yaml = generateDockerCompose(baseConfig());
    expect(yaml).not.toContain("MCP_AUTH_SECRET");
  });

  it("emits ALLOWED_ORIGINS defaulting to MCP_PUBLIC_URL (P0.2)", () => {
    const parsed = parse(generateDockerCompose(baseConfig())) as any;
    expect(parsed.services["mcp-server"].environment).toContain(
      "ALLOWED_ORIGINS=${ALLOWED_ORIGINS:-${MCP_PUBLIC_URL}}",
    );
  });
});
