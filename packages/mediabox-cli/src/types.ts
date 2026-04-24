/**
 * Raw output of the Inquirer-based interactive wizard.
 * Translated to `@mediabox/core`'s DeployConfig by `src/config/translate.ts`.
 */
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
