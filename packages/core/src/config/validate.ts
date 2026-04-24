import type { DeployConfig } from "./types.js";

/**
 * Shallow validation of DeployConfig. Returns an array of error messages;
 * empty array = valid. Designed to be cheap and actionable — not a schema
 * replacement. The CLI is expected to collect these and surface them.
 */
export function validateDeployConfig(config: DeployConfig): string[] {
  const errors: string[] = [];

  // Deployment
  const d = config.deployment;
  if (d.mode === "vps") {
    if (!d.baseDomain) errors.push("deployment.baseDomain is required for mode=vps");
    if (!d.letsEncryptEmail) {
      errors.push("deployment.letsEncryptEmail is required for mode=vps");
    }
  }
  if (d.mode === "tunnel") {
    if (!d.baseDomain) errors.push("deployment.baseDomain is required for mode=tunnel");
    if (!d.tunnelToken) errors.push("deployment.tunnelToken is required for mode=tunnel");
  }
  if (!d.imageTag) errors.push("deployment.imageTag is required");

  // System
  if (!config.system.timezone) errors.push("system.timezone is required");
  if (!Number.isFinite(config.system.puid)) errors.push("system.puid must be a number");
  if (!Number.isFinite(config.system.pgid)) errors.push("system.pgid must be a number");

  // Paths
  for (const key of ["movies", "tv", "anime", "music"] as const) {
    if (!config.paths[key]) errors.push(`paths.${key} is required`);
  }

  // Services
  const s = config.services;
  if (!s.jellyfin.adminUsername) errors.push("services.jellyfin.adminUsername is required");
  if (!s.jellyfin.adminPassword) errors.push("services.jellyfin.adminPassword is required");
  if (!s.qbittorrent.password) errors.push("services.qbittorrent.password is required");

  // MCP
  if (!config.mcp.publicUrl) errors.push("mcp.publicUrl is required");
  if (!config.mcp.internalApiKey) errors.push("mcp.internalApiKey is required");

  // Telegram (only if enabled)
  if (config.telegram) {
    if (!config.telegram.botToken) errors.push("telegram.botToken is required when telegram is enabled");
    if (!config.telegram.llm.apiKey) errors.push("telegram.llm.apiKey is required when telegram is enabled");
    if (config.telegram.llm.kind === "openrouter" && !config.telegram.llm.model) {
      errors.push("telegram.llm.model is required for openrouter provider");
    }
  }

  return errors;
}
