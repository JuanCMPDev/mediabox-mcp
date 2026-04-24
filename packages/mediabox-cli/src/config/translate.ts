import type { DeployConfig, LLMProviderConfig } from "@mediabox/core";
import type { WizardAnswers } from "../types.js";
import { VERSION } from "../utils/version.js";

/**
 * Translate Inquirer-derived WizardAnswers into the normalized domain
 * DeployConfig consumed by @mediabox/core.
 *
 * This is the single bridge between the UI-shaped wizard output and the
 * headless core. Future UIs (Tauri, web) will construct DeployConfig
 * directly and skip this layer.
 */
export function translateWizardAnswers(answers: WizardAnswers): DeployConfig {
  const config: DeployConfig = {
    deployment: {
      mode: answers.deploymentMode,
      baseDomain: answers.baseDomain,
      letsEncryptEmail: answers.letsEncryptEmail,
      tunnelToken: answers.tunnelToken,
      localBuild: answers.localBuild,
      imageTag: VERSION,
    },
    system: {
      timezone: answers.timezone,
      puid: answers.puid,
      pgid: answers.pgid,
    },
    paths: {
      movies: answers.mediaMovies,
      tv: answers.mediaTv,
      anime: answers.mediaAnime,
      music: answers.mediaMusic,
    },
    services: {
      jellyfin: {
        adminUsername: answers.jellyfinUser,
        adminPassword: answers.jellyfinPassword,
      },
      qbittorrent: {
        password: answers.qbitPassword,
      },
      pyload: {
        username: "pyload",
        password: "pyload",
      },
      bazarr: {
        enabled: answers.enableBazarr,
      },
    },
    mcp: {
      publicUrl: answers.mcpPublicUrl,
      internalApiKey: answers.internalApiKey,
    },
  };

  if (answers.enableTelegram) {
    config.telegram = {
      botToken: answers.telegramBotToken ?? "",
      llm: buildLLMConfig(answers),
      allowedUserIds: parseAllowedUsers(answers.allowedTelegramUsers),
    };
  }

  return config;
}

function buildLLMConfig(answers: WizardAnswers): LLMProviderConfig {
  const provider = answers.llmProvider ?? "openrouter";
  const apiKey = answers.llmApiKey ?? "";
  if (provider === "google") {
    return { kind: "google", apiKey };
  }
  return {
    kind: "openrouter",
    apiKey,
    model: answers.llmModel ?? "openai/gpt-4o",
  };
}

function parseAllowedUsers(raw: string | undefined): number[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map(Number)
    .filter((n) => Number.isFinite(n));
}
