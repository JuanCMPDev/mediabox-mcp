/**
 * Wire-format types for the deploy config live in @mediabox/contracts so the
 * UI can build a payload without taking a runtime dep on @mediabox/core
 * (which carries execa, yaml, fast-xml-parser etc into the bundle).
 * Re-exported here for ergonomic consumption by core's own callers
 * (orchestrate, generators, validators, the CLI translator).
 */
export type {
  DeployConfig,
  DeploymentConfig,
  SystemConfig,
  MediaPathsConfig,
  ServicesConfig,
  McpConfig,
  TelegramConfig,
  LLMProviderConfig,
} from "@mediabox/contracts";
