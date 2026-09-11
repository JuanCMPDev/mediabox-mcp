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
  // Blueprint §4.1 / B02: the agent credential must never equal the owner key,
  // otherwise the Telegram bot / loopback client would carry owner authority.
  if (config.mcp.agentApiKey && config.mcp.agentApiKey === config.mcp.internalApiKey) {
    errors.push("mcp.agentApiKey must differ from mcp.internalApiKey (Blueprint §4.1 / B02)");
  }

  // AI / LLM Provider validation
  const llm = config.ai ?? config.telegram?.llm;
  if (llm?.kind === "local") {
    if (!llm.runtime) errors.push("ai.runtime is required for local provider");
    if (!llm.baseUrl) errors.push("ai.baseUrl is required for local provider");
    if (!llm.model) errors.push("ai.model is required for local provider");
    if (llm.baseUrl) {
      try {
        const parsed = new URL(llm.baseUrl);
        const hostname = parsed.hostname.toLowerCase();
        const isLoopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
        if (!isLoopback && !llm.allowLan) {
          errors.push("local provider baseUrl must be loopback (or allowLan must be enabled)");
        } else if (!isLoopback && llm.allowLan) {
          const isPrivateIpv4 = /^(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})$/.test(hostname);
          const isLocalName = hostname.endsWith(".local") || hostname.endsWith(".lan") || hostname === "host.docker.internal";
          if (!isPrivateIpv4 && !isLocalName) {
            errors.push("local provider baseUrl cannot point to a public internet address");
          }
        }
      } catch {
        errors.push("local provider baseUrl is not a valid URL");
      }
    }
  }

  // Telegram (only if enabled)
  if (config.telegram) {
    if (!config.telegram.botToken) errors.push("telegram.botToken is required when telegram is enabled");
    if (config.telegram.llm.kind !== "local" && !config.telegram.llm.apiKey) {
      errors.push("telegram.llm.apiKey is required when telegram is enabled");
    }
    if (config.telegram.llm.kind === "openrouter" && !config.telegram.llm.model) {
      errors.push("telegram.llm.model is required for openrouter provider");
    }
  }

  return errors;
}
