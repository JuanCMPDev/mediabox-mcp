export interface WizardAnswers {
  // Deployment
  deploymentMode: "local" | "vps" | "tunnel";
  baseDomain?: string;
  letsEncryptEmail?: string;
  tunnelToken?: string;

  // System
  timezone: string;

  // Media paths
  mediaMovies: string;
  mediaTv: string;
  mediaAnime: string;
  mediaMusic: string;

  // qBittorrent
  qbitPassword: string;

  // MCP Server
  mcpPublicUrl: string;
  internalApiKey: string;

  // Jellyfin
  jellyfinUser: string;
  jellyfinPassword: string;

  // Telegram (optional)
  enableTelegram: boolean;
  telegramBotToken?: string;
  llmProvider?: "openrouter" | "google";
  llmApiKey?: string;
  llmModel?: string;
  allowedTelegramUsers?: string;

  // Bazarr (optional)
  enableBazarr: boolean;

  // System (auto-detected)
  puid: number;
  pgid: number;

  // Build mode
  localBuild: boolean;
}

export interface ServiceHealth {
  name: string;
  status: "pending" | "ready" | "failed";
  checkType: "http" | "file";
  /** URL for http checks, file path for file checks */
  target: string;
  timeoutMs: number;
  /** For file checks: the XML tag to look for */
  xmlTag?: string;
}

export interface DiscoveredKeys {
  sonarrApiKey: string;
  radarrApiKey: string;
  prowlarrApiKey: string;
  jellyfinApiKey: string;
}
