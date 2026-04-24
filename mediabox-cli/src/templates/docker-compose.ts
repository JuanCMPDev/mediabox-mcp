import { stringify } from "yaml";
import type { WizardAnswers } from "../types.js";
import { ensureRelative } from "../utils/paths.js";
import { VERSION } from "../utils/version.js";

const GHCR_MCP_IMAGE = `ghcr.io/juancmpdev/mediabox-mcp:\${IMAGE_TAG:-${VERSION}}`;
const GHCR_TELEGRAM_IMAGE = `ghcr.io/juancmpdev/mediabox-telegram:\${IMAGE_TAG:-${VERSION}}`;

/** Environment array for the Telegram bot — varies by LLM provider */
function buildTelegramEnv(answers: WizardAnswers): string[] {
  const env = [
    "TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}",
    "MCP_SERVER_URL=http://mcp-server:3000/mcp",
    "ALLOWED_TELEGRAM_USERS=${ALLOWED_TELEGRAM_USERS}",
    "MCP_INTERNAL_API_KEY=${INTERNAL_API_KEY}",
  ];

  if (answers.llmProvider === "google") {
    env.push(
      "GOOGLE_AI_API_KEY=${GOOGLE_AI_API_KEY}",
      "LLM_PROVIDER=google",
    );
  } else {
    env.push(
      "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}",
      "LLM_PROVIDER=openrouter",
      "LLM_MODEL=${LLM_MODEL:-openai/gpt-4o}",
    );
  }

  return env;
}

/** Environment array for LinuxServer containers */
function lsEnv(answers: WizardAnswers): string[] {
  const env = [`PUID=${answers.puid}`, `PGID=${answers.pgid}`, "TZ=${TZ:-UTC}"];
  return env;
}

/** In VPS mode, bind a port to 127.0.0.1 only (not exposed to the internet). */
function port(mapping: string, vps: boolean): string {
  return vps ? `127.0.0.1:${mapping}` : mapping;
}

export function generateDockerCompose(answers: WizardAnswers): string {
  const mov = ensureRelative(answers.mediaMovies);
  const tv = ensureRelative(answers.mediaTv);
  const anime = ensureRelative(answers.mediaAnime);
  const music = ensureRelative(answers.mediaMusic);
  const vps = answers.deploymentMode === "vps" || answers.deploymentMode === "tunnel";

  const services: Record<string, any> = {};

  // ── Jellyfin ──────────────────────────────────────────────────────────
  const jellyfinPorts = [port("8096:8096", vps), port("8920:8920", vps)];
  // Discovery ports only useful on local networks
  if (!vps) jellyfinPorts.push("7359:7359/udp", "1900:1900/udp");

  services.jellyfin = {
    image: "lscr.io/linuxserver/jellyfin:latest",
    container_name: "jellyfin",
    networks: ["mediabox-net"],
    ports: jellyfinPorts,
    environment: lsEnv(answers),
    volumes: [
      "./config/jellyfin:/config",
      `${mov}:/data/movies`,
      `${tv}:/data/tv`,
      `${music}:/data/music`,
      `${anime}:/data/anime`,
    ],
    restart: "unless-stopped",
    deploy: { resources: { limits: { memory: "4G" } } },
  };

  // ── MCP Server ────────────────────────────────────────────────────────
  const mcpServer: Record<string, any> = {
    container_name: "mcp-server",
    networks: ["mediabox-net"],
    ports: [port("3000:3000", vps)],
    environment: [
      "TZ=${TZ:-UTC}",
      "JELLYFIN_URL=http://jellyfin:8096",
      "JELLYFIN_API_KEY=${JELLYFIN_API_KEY}",
      "MEDIA_PATH=/data",
      "PORT=3000",
      "PUBLIC_URL=${MCP_PUBLIC_URL}",
      "PYLOAD_URL=http://pyload:8000",
      "PYLOAD_USER=${PYLOAD_USER}",
      "PYLOAD_PASSWORD=${PYLOAD_PASSWORD}",
      "SONARR_URL=http://sonarr:8989",
      "SONARR_API_KEY=${SONARR_API_KEY}",
      "RADARR_URL=http://radarr:7878",
      "RADARR_API_KEY=${RADARR_API_KEY}",
      "INTERNAL_API_KEY=${INTERNAL_API_KEY}",
      "QBIT_URL=http://qbittorrent:8085",
      "QBIT_USER=admin",
      "QBIT_PASSWORD=${QBIT_PASSWORD}",
    ],
    volumes: [
      `${mov}:/data/movies`,
      `${tv}:/data/tv`,
      `${music}:/data/music`,
      `${anime}:/data/anime`,
      "./downloads:/downloads",
    ],
    restart: "unless-stopped",
    depends_on: ["jellyfin", "pyload"],
  };

  if (answers.localBuild) {
    mcpServer.build = "./mcp-server";
  } else {
    mcpServer.image = GHCR_MCP_IMAGE;
  }
  services["mcp-server"] = mcpServer;

  // ── PyLoad ────────────────────────────────────────────────────────────
  services.pyload = {
    image: "lscr.io/linuxserver/pyload-ng:latest",
    container_name: "pyload",
    networks: ["mediabox-net"],
    ports: [port("8001:8000", vps)],
    environment: lsEnv(answers),
    volumes: ["./config/pyload:/config", "./downloads:/downloads"],
    restart: "unless-stopped",
  };

  // ── Telegram Bot (optional) ───────────────────────────────────────────
  if (answers.enableTelegram) {
    const telegramBot: Record<string, any> = {
      container_name: "telegram-bot",
      networks: ["mediabox-net"],
      environment: buildTelegramEnv(answers),
      restart: "unless-stopped",
      depends_on: ["mcp-server"],
    };

    if (answers.localBuild) {
      telegramBot.build = "./mcp-telegram-client";
    } else {
      telegramBot.image = GHCR_TELEGRAM_IMAGE;
    }
    services["telegram-bot"] = telegramBot;
  }

  // ── Download Stack ────────────────────────────────────────────────────
  services.qbittorrent = {
    image: "lscr.io/linuxserver/qbittorrent:latest",
    container_name: "qbittorrent",
    networks: ["mediabox-net"],
    ports: [port("8085:8085", vps), "6881:6881", "6881:6881/udp"],
    environment: [...lsEnv(answers), "WEBUI_PORT=8085"],
    volumes: ["./config/qbittorrent:/config", "./downloads:/downloads"],
    restart: "unless-stopped",
  };

  services.flaresolverr = {
    image: "ghcr.io/flaresolverr/flaresolverr:latest",
    container_name: "flaresolverr",
    networks: ["mediabox-net"],
    ports: [port("8191:8191", vps)],
    environment: ["LOG_LEVEL=info", "TZ=${TZ:-UTC}"],
    restart: "unless-stopped",
  };

  services.prowlarr = {
    image: "lscr.io/linuxserver/prowlarr:latest",
    container_name: "prowlarr",
    networks: ["mediabox-net"],
    ports: [port("9696:9696", vps)],
    environment: lsEnv(answers),
    volumes: ["./config/prowlarr:/config"],
    restart: "unless-stopped",
  };

  services.radarr = {
    image: "lscr.io/linuxserver/radarr:latest",
    container_name: "radarr",
    networks: ["mediabox-net"],
    ports: [port("7878:7878", vps)],
    environment: lsEnv(answers),
    volumes: [`./config/radarr:/config`, `${mov}:/movies`, "./downloads:/downloads"],
    restart: "unless-stopped",
    depends_on: ["qbittorrent", "prowlarr"],
  };

  services.sonarr = {
    image: "lscr.io/linuxserver/sonarr:latest",
    container_name: "sonarr",
    networks: ["mediabox-net"],
    ports: [port("8989:8989", vps)],
    environment: lsEnv(answers),
    volumes: [
      "./config/sonarr:/config",
      `${tv}:/tv`,
      `${anime}:/anime`,
      "./downloads:/downloads",
    ],
    restart: "unless-stopped",
    depends_on: ["qbittorrent", "prowlarr"],
  };

  // ── Bazarr (optional) ─────────────────────────────────────────────────
  if (answers.enableBazarr) {
    services.bazarr = {
      image: "lscr.io/linuxserver/bazarr:latest",
      container_name: "bazarr",
      networks: ["mediabox-net"],
      ports: [port("6767:6767", vps)],
      environment: lsEnv(answers),
      volumes: [`./config/bazarr:/config`, `${mov}:/movies`, `${tv}:/tv`],
      restart: "unless-stopped",
    };
  }

  // ── Caddy reverse proxy (VPS mode only) ─────────────────────────────
  const includeCaddy = answers.deploymentMode === "vps";
  if (includeCaddy) {
    services.caddy = {
      image: "caddy:2-alpine",
      container_name: "caddy",
      networks: ["mediabox-net"],
      ports: ["80:80", "443:443", "443:443/udp"],
      volumes: [
        "./config/caddy/Caddyfile:/etc/caddy/Caddyfile:ro",
        "./config/caddy/data:/data",
        "./config/caddy/config:/config",
      ],
      restart: "unless-stopped",
      depends_on: Object.keys(services),
    };
  }

  // ── Cloudflare Tunnel (tunnel mode) ──────────────────────────────────
  if (answers.deploymentMode === "tunnel") {
    services.cloudflared = {
      image: "cloudflare/cloudflared:latest",
      container_name: "cloudflared",
      networks: ["mediabox-net"],
      command: "tunnel --no-autoupdate run",
      environment: ["TUNNEL_TOKEN=${CLOUDFLARE_TUNNEL_TOKEN}"],
      restart: "unless-stopped",
    };
  }

  const compose = {
    networks: { "mediabox-net": { driver: "bridge" } },
    services,
  };

  const header = [
    "###############################################################################",
    "# Mediabox MCP — Docker Compose",
    "# Generated by create-mediabox CLI",
    "###############################################################################",
    "",
  ].join("\n");

  return header + stringify(compose, { lineWidth: 0 });
}
