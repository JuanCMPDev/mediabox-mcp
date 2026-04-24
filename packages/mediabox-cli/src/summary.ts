import type { DeployConfig, DeployResult } from "@mediabox/core";
import * as log from "./utils/logger.js";

/**
 * Print the final summary: service table, credentials, next steps.
 */
export function printSummary(config: DeployConfig, result: DeployResult): void {
  log.header("Setup Complete!");

  const healthy = (name: string): string =>
    result.healthy[name] ? "Ready" : "Failed";

  const rows: [string, string, string][] = [
    ["Service", "URL", "Status"],
    ["Jellyfin", "http://localhost:8096", healthy("jellyfin")],
    ["MCP Server", "http://localhost:3000", "Ready"],
    ["qBittorrent", "http://localhost:8085", healthy("qbittorrent")],
    ["Sonarr", "http://localhost:8989", healthy("sonarr")],
    ["Radarr", "http://localhost:7878", healthy("radarr")],
    ["Prowlarr", "http://localhost:9696", healthy("prowlarr")],
    ["PyLoad", "http://localhost:8001", healthy("pyload")],
  ];
  log.table(rows);

  console.log();
  log.info(`Jellyfin:     ${config.services.jellyfin.adminUsername} / ********`);
  log.info(`qBittorrent:  admin / ********`);
  log.info(`PyLoad:       ${config.services.pyload.username} / ********`);
  log.info(`MCP Public:   ${config.mcp.publicUrl}`);

  if (result.errors.length > 0) {
    console.log();
    log.warn(`${result.errors.length} step(s) had issues:`);
    for (const e of result.errors) log.error(`  - [${e.phase}] ${e.message}`);
  }

  console.log();
  log.header("Next Steps");

  const domain = config.deployment.baseDomain;
  if (config.deployment.mode === "vps" && domain) {
    log.info("Caddy reverse proxy is running with automatic HTTPS:");
    console.log();
    const urlRows: [string, string, string][] = [
      ["Service", "URL", "Status"],
      ["MCP Server", `https://${domain}`, "Ready"],
      ["Jellyfin", `https://jellyfin.${domain}`, healthy("jellyfin")],
      ["Sonarr", `https://sonarr.${domain}`, healthy("sonarr")],
      ["Radarr", `https://radarr.${domain}`, healthy("radarr")],
      ["Prowlarr", `https://prowlarr.${domain}`, healthy("prowlarr")],
      ["qBittorrent", `https://qbit.${domain}`, healthy("qbittorrent")],
      ["PyLoad", `https://pyload.${domain}`, healthy("pyload")],
    ];
    if (config.services.bazarr.enabled) {
      urlRows.push(["Bazarr", `https://bazarr.${domain}`, "Ready"]);
    }
    log.table(urlRows);
    console.log();
    log.info("HTTPS certificates are managed automatically by Let's Encrypt");
    console.log();
  }

  if (config.deployment.mode === "tunnel" && domain) {
    log.info(
      "Cloudflare Tunnel is configured. Set up these hostnames in Zero Trust dashboard:",
    );
    console.log();
    const tunnelRows: [string, string, string][] = [
      ["Service", "Public hostname", "Service URL"],
      ["MCP Server", domain, "http://mcp-server:3000"],
      ["Jellyfin", `jellyfin.${domain}`, "http://jellyfin:8096"],
      ["Sonarr", `sonarr.${domain}`, "http://sonarr:8989"],
      ["Radarr", `radarr.${domain}`, "http://radarr:7878"],
      ["Prowlarr", `prowlarr.${domain}`, "http://prowlarr:9696"],
      ["qBittorrent", `qbit.${domain}`, "http://qbittorrent:8085"],
      ["PyLoad", `pyload.${domain}`, "http://pyload:8000"],
    ];
    if (config.services.bazarr.enabled) {
      tunnelRows.push(["Bazarr", `bazarr.${domain}`, "http://bazarr:6767"]);
    }
    log.table(tunnelRows);
    console.log();
    log.info("No ports need to be opened on your router");
    log.info("HTTPS is managed automatically by Cloudflare");
    console.log();
  }

  log.info("1. Add indexers (torrent trackers) in Prowlarr → http://localhost:9696");
  if (config.telegram) {
    log.info("2. Test Telegram bot by sending /start to your bot");
  }
  log.info("");
  log.info(
    `Web UI credentials (Sonarr/Radarr/Prowlarr): ${config.services.jellyfin.adminUsername} / ********`,
  );
  console.log();
}
