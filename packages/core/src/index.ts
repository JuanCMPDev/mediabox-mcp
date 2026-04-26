// Types
export type {
  DeployConfig,
  DeploymentConfig,
  SystemConfig,
  MediaPathsConfig,
  ServicesConfig,
  McpConfig,
  TelegramConfig,
  LLMProviderConfig,
} from "./config/types.js";

export { validateDeployConfig } from "./config/validate.js";

export type {
  DeployEvent,
  DeployPhase,
  EventHandler,
} from "./events/types.js";
export { noopEventHandler } from "./events/types.js";

export type {
  Deployer,
  DeployerContext,
  HealthCheck,
  DeployResult,
} from "./deployer/types.js";
export { DockerCliDeployer } from "./deployer/docker-cli.js";

// Generators — pure, no IO
export { generateDockerCompose } from "./generators/docker-compose.js";
export {
  generateEnv,
  updateEnvKeys,
  type DiscoveredKeys,
} from "./generators/env.js";
export { generateCaddyfile } from "./generators/caddyfile.js";
export {
  generateQbittorrentConfig,
  qbitPasswordHash,
} from "./generators/qbittorrent.js";

// Utilities
export { fetchWithRetry, pollUntilReady, sleep } from "./utils/http.js";
export { parseApiKey, tryParseApiKey } from "./utils/xml.js";
export { toPosix, ensureRelative } from "./utils/paths.js";

// Service API clients
export * as jellyfin from "./services/jellyfin.js";
export * as sonarr from "./services/sonarr.js";
export * as radarr from "./services/radarr.js";
export * as prowlarr from "./services/prowlarr.js";
export * as qbittorrent from "./services/qbittorrent.js";
export * as arrAuth from "./services/arr-auth.js";

// High-level orchestrator
export { deployStack, type DeployStackOptions } from "./orchestrate.js";
