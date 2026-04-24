/**
 * Clean, domain-oriented deployment config used by @mediabox/core.
 *
 * The CLI is responsible for translating its Inquirer-derived `WizardAnswers`
 * into this shape. Future UIs (Tauri, Web) will construct this type directly.
 */
export interface DeployConfig {
  deployment: DeploymentConfig;
  system: SystemConfig;
  paths: MediaPathsConfig;
  services: ServicesConfig;
  mcp: McpConfig;
  telegram?: TelegramConfig;
}

export interface DeploymentConfig {
  mode: "local" | "vps" | "tunnel";
  /** Required for mode = vps | tunnel */
  baseDomain?: string;
  /** Required for mode = vps */
  letsEncryptEmail?: string;
  /** Required for mode = tunnel */
  tunnelToken?: string;
  /** Build container images from ./packages/* instead of pulling from GHCR. */
  localBuild: boolean;
  /** GHCR image tag. Ignored when localBuild is true. */
  imageTag: string;
}

export interface SystemConfig {
  /** IANA timezone (e.g. "Europe/Madrid") */
  timezone: string;
  puid: number;
  pgid: number;
}

export interface MediaPathsConfig {
  movies: string;
  tv: string;
  anime: string;
  music: string;
}

export interface ServicesConfig {
  jellyfin: {
    adminUsername: string;
    adminPassword: string;
  };
  qbittorrent: {
    password: string;
  };
  pyload: {
    username: string;
    password: string;
  };
  bazarr: {
    enabled: boolean;
  };
}

export interface McpConfig {
  publicUrl: string;
  internalApiKey: string;
}

export type LLMProviderConfig =
  | { kind: "openrouter"; apiKey: string; model: string }
  | { kind: "google"; apiKey: string; model?: string };

export interface TelegramConfig {
  botToken: string;
  llm: LLMProviderConfig;
  /** Empty array = allow any user */
  allowedUserIds: number[];
}
