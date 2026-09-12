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
  PrepareImagesOptions,
  UpOptions,
  ProvisionedModel,
} from "./deployer/types.js";
export { PREPARE_ARTIFACTS_PHASE } from "./deployer/types.js";
export { DockerCliDeployer } from "./deployer/docker-cli.js";

// Generators — pure, no IO
export {
  generateDockerCompose,
  isStrictPrivacyProfile,
  EDGE_IMAGE,
  EDGE_SERVICE,
  PROVISIONER_SERVICE,
  PROVISION_PROFILE,
  type GenerateDockerComposeOptions,
} from "./generators/docker-compose.js";
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
export {
  deployStack,
  sanitizeDeployDiagnostic,
  type DeployStackOptions,
} from "./orchestrate.js";

// Hardware & Local LLM Models (LOC-07, LOC-09)
export * from "./hardware/types.js";
export {
  detectHardware,
  clearHardwareCache,
  parseWindowsGpus,
  parseNvidiaSmiCsv,
  parseRocmInfo,
  parseRocmSmi,
  parseVulkanSummary,
  parseLspci,
  parseMacosDisplays,
  parseCpuFlags,
} from "./hardware/detect.js";
export * from "./models/types.js";
export {
  MODEL_CATALOG,
  getModelCatalog,
  findModelProfile,
  evaluateModelFit,
  evaluateCatalog,
  getRecommendedModels,
  kvCacheBytes,
  requiredMemoryBytes,
  RUNTIME_OVERHEAD_FACTOR,
} from "./models/catalog.js";

// Artifacts & Provisioning (§3.2 / P10)
export * from "./artifacts/manifest.js";
export * from "./artifacts/lock.js";

// Runtime Lifecycle & Resource Admission (§3.2, §3.3 / P10)
export * from "./runtime/lifecycle.js";
