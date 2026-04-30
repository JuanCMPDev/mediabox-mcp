import type { DeployConfig, DeployResult } from "@mediabox/core";
import * as log from "./utils/logger.js";

/**
 * Print the final summary: service table, credentials, next steps.
 */
export function printSummary(config: DeployConfig, result: DeployResult): void {
  log.header("Setup Complete!");

  const healthy = (name: string): string =>
    result.healthy[name] ? "Ready" : "Failed";

  log.table(serviceRows(config, healthy));

  console.log();
  log.info(`Jellyfin:     ${config.services.jellyfin.adminUsername} / ********`);
  log.info("qBittorrent:  admin / ********");
  log.info(`PyLoad:       ${config.services.pyload.username} / ********`);
  log.info(`MCP Public:   ${config.mcp.publicUrl}`);

  if (result.errors.length > 0) {
    console.log();
    log.warn(`${result.errors.length} step(s) had issues:`);
    for (const e of result.errors) log.error(`  - [${e.phase}] ${e.message}`);
  }

  console.log();
  log.header("Next Steps");
  printModeNotes(config);

  log.info(`1. Add indexers (torrent trackers) in Prowlarr -> ${prowlarrUrl(config)}`);
  if (config.telegram) {
    log.info("2. Test Telegram bot by sending /start to your bot");
  }
  log.info("");
  log.info(
    `Web UI credentials (Sonarr/Radarr/Prowlarr): ${config.services.jellyfin.adminUsername} / ********`,
  );
  console.log();
}

function serviceRows(
  config: DeployConfig,
  healthy: (name: string) => string,
): [string, string, string][] {
  const domain = config.deployment.baseDomain;
  const rows: [string, string, string][] = [["Service", "URL", "Status"]];

  if (config.deployment.mode === "vps" && domain) {
    rows.push(
      ["MCP Server", `https://${domain}`, "Ready"],
      ["Jellyfin", `https://jellyfin.${domain}`, healthy("jellyfin")],
      ["qBittorrent", `https://qbit.${domain}`, healthy("qbittorrent")],
      ["Sonarr", `https://sonarr.${domain}`, healthy("sonarr")],
      ["Radarr", `https://radarr.${domain}`, healthy("radarr")],
      ["Prowlarr", `https://prowlarr.${domain}`, healthy("prowlarr")],
      ["PyLoad", `https://pyload.${domain}`, healthy("pyload")],
    );
  } else if (config.deployment.mode === "tunnel" && domain) {
    rows.push(
      ["MCP Server", `https://${domain}`, "Ready"],
      ["Jellyfin", `https://jellyfin.${domain}`, healthy("jellyfin")],
      ["qBittorrent", `https://qbit.${domain}`, healthy("qbittorrent")],
      ["Sonarr", `https://sonarr.${domain}`, healthy("sonarr")],
      ["Radarr", `https://radarr.${domain}`, healthy("radarr")],
      ["Prowlarr", `https://prowlarr.${domain}`, healthy("prowlarr")],
      ["PyLoad", `https://pyload.${domain}`, healthy("pyload")],
    );
  } else {
    rows.push(
      ["MCP Server", "http://localhost:3000", "Ready"],
      ["Jellyfin", "http://localhost:8096", healthy("jellyfin")],
      ["qBittorrent", "http://localhost:8085", healthy("qbittorrent")],
      ["Sonarr", "http://localhost:8989", healthy("sonarr")],
      ["Radarr", "http://localhost:7878", healthy("radarr")],
      ["Prowlarr", "http://localhost:9696", healthy("prowlarr")],
      ["PyLoad", "http://localhost:8001", healthy("pyload")],
    );
  }

  if (config.services.bazarr.enabled) {
    const bazarrUrl =
      domain && config.deployment.mode !== "local"
        ? `https://bazarr.${domain}`
        : "http://localhost:6767";
    rows.push(["Bazarr", bazarrUrl, "Ready"]);
  }

  return rows;
}

function printModeNotes(config: DeployConfig): void {
  const domain = config.deployment.baseDomain;

  if (config.deployment.mode === "vps" && domain) {
    log.info("Caddy reverse proxy is running with automatic HTTPS.");
    log.info("HTTPS certificates are managed automatically by Let's Encrypt.");
    return;
  }

  if (config.deployment.mode === "tunnel" && domain) {
    log.info("Cloudflare Tunnel is configured.");
    log.info("Create the listed public hostnames in the Zero Trust dashboard.");
    log.info("No ports need to be opened on your router.");
  }
}

function prowlarrUrl(config: DeployConfig): string {
  const domain = config.deployment.baseDomain;
  if (domain && config.deployment.mode !== "local") return `https://prowlarr.${domain}`;
  return "http://localhost:9696";
}
