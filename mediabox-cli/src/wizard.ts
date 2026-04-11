import { input, password, confirm, select, search } from "@inquirer/prompts";
import os from "node:os";
import chalk from "chalk";
import type { WizardAnswers } from "./types.js";
import { randomHex } from "./utils/crypto.js";

/** All IANA timezones available in the runtime */
const TIMEZONES: string[] = (() => {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    // Fallback for older Node versions
    return [
      "UTC",
      "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
      "America/Bogota", "America/Mexico_City", "America/Sao_Paulo", "America/Argentina/Buenos_Aires",
      "America/Lima", "America/Santiago", "America/Caracas",
      "Europe/London", "Europe/Paris", "Europe/Berlin", "Europe/Madrid", "Europe/Rome",
      "Asia/Tokyo", "Asia/Shanghai", "Asia/Kolkata", "Asia/Dubai",
      "Australia/Sydney", "Pacific/Auckland",
    ];
  }
})();

function detectTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

function detectUidGid(): { uid: number; gid: number } {
  if (process.platform === "win32") {
    return { uid: 1000, gid: 1000 };
  }
  try {
    const info = os.userInfo();
    return { uid: info.uid, gid: info.gid };
  } catch {
    return { uid: 1000, gid: 1000 };
  }
}

export async function runWizard(localBuild: boolean): Promise<WizardAnswers> {
  console.log();
  console.log(chalk.bold.cyan("🎬 Mediabox MCP — Setup Wizard"));
  console.log(chalk.dim("Configure your self-hosted media server stack\n"));

  // ── Deployment Mode ─────────────────────────────────────────────────
  const deploymentMode = await select({
    message: "Where are you installing?",
    choices: [
      { value: "local" as const, name: "Local (home network)" },
      { value: "vps" as const, name: "VPS / Cloud server" },
    ],
  });

  let baseDomain: string | undefined;
  let hasProxy: boolean | undefined;
  let letsEncryptEmail: string | undefined;

  if (deploymentMode === "vps") {
    hasProxy = await confirm({
      message: "Do you already have a reverse proxy? (Coolify, nginx, Traefik...)",
      default: false,
    });

    baseDomain = await input({
      message: "Base domain (e.g. mediabox.example.com)",
      validate: (val) => {
        if (!val.trim()) return "Domain is required for VPS deployment";
        if (/^https?:\/\//.test(val)) return "Enter the domain without http:// or https://";
        if (val.endsWith("/")) return "Remove the trailing slash";
        return true;
      },
    });

    if (!hasProxy) {
      letsEncryptEmail = await input({
        message: "Email for Let's Encrypt HTTPS certificates",
        validate: (val) => {
          if (!val.trim()) return "Email is required for Let's Encrypt";
          if (!val.includes("@")) return "Enter a valid email address";
          return true;
        },
      });
    }
  }

  // ── System ──────────────────────────────────────────────────────────
  const detectedTz = detectTimezone();
  const timezone = await search({
    message: "Timezone (type to filter)",
    source: (term) => {
      const query = (term ?? "").toLowerCase();
      const filtered = query
        ? TIMEZONES.filter((tz) => tz.toLowerCase().includes(query))
        : TIMEZONES;
      // Put detected timezone first when no filter is active
      const sorted = query
        ? filtered
        : [detectedTz, ...filtered.filter((tz) => tz !== detectedTz)];
      return sorted.map((tz) => ({
        value: tz,
        name: tz === detectedTz ? `${tz} (detected)` : tz,
      }));
    },
  });

  // ── Media Paths ─────────────────────────────────────────────────────
  console.log(chalk.dim("\n📁 Media Storage Paths"));

  const mediaMovies = await input({
    message: "Movies path",
    default: "./media/movies",
  });
  const mediaTv = await input({
    message: "TV Shows path",
    default: "./media/tv",
  });
  const mediaAnime = await input({
    message: "Anime path",
    default: "./media/anime",
  });
  const mediaMusic = await input({
    message: "Music path",
    default: "./media/music",
  });

  // ── qBittorrent ─────────────────────────────────────────────────────
  console.log(chalk.dim("\n🔒 Service Credentials"));

  const qbitPassword = await password({
    message: "qBittorrent password (min 8 chars)",
    mask: "*",
    validate: (val) => val.length >= 8 || "Password must be at least 8 characters",
  });

  // ── Jellyfin ────────────────────────────────────────────────────────
  const jellyfinUser = await input({
    message: "Jellyfin admin username",
    default: "admin",
  });

  const jellyfinPassword = await password({
    message: "Jellyfin admin password",
    mask: "*",
    validate: (val) => val.length >= 4 || "Password must be at least 4 characters",
  });

  // ── MCP Server ──────────────────────────────────────────────────────
  console.log(chalk.dim("\n🌐 MCP Server Configuration"));

  const mcpDefaultUrl = baseDomain
    ? `https://${baseDomain}`
    : "http://localhost:3000";

  const mcpPublicUrl = await input({
    message: "MCP public URL (for OAuth2 / client access)",
    default: mcpDefaultUrl,
    validate: (val) => {
      try {
        new URL(val);
        return true;
      } catch {
        return "Must be a valid URL";
      }
    },
  });

  const autoSecret = randomHex(32);
  const mcpAuthSecret = await input({
    message: "MCP auth secret (auto-generated)",
    default: autoSecret,
  });

  const autoApiKey = randomHex(32);
  const internalApiKey = await input({
    message: "Internal API key (auto-generated)",
    default: autoApiKey,
  });

  // ── Telegram Bot ────────────────────────────────────────────────────
  console.log(chalk.dim("\n🤖 Optional Integrations"));

  const enableTelegram = await confirm({
    message: "Enable Telegram bot?",
    default: false,
  });

  let telegramBotToken: string | undefined;
  let llmProvider: "openrouter" | "google" | undefined;
  let llmApiKey: string | undefined;
  let llmModel: string | undefined;
  let allowedTelegramUsers: string | undefined;

  if (enableTelegram) {
    telegramBotToken = await input({
      message: "Telegram Bot Token (from @BotFather)",
      validate: (val) => val.length > 0 || "Token is required",
    });

    llmProvider = await select({
      message: "LLM provider for the bot",
      choices: [
        { value: "openrouter" as const, name: "OpenRouter (recommended)" },
        { value: "google" as const, name: "Google Gemini" },
      ],
    });

    llmApiKey = await input({
      message: `${llmProvider === "openrouter" ? "OpenRouter" : "Google AI"} API key`,
      validate: (val) => val.length > 0 || "API key is required",
    });

    if (llmProvider === "openrouter") {
      llmModel = await input({
        message: "OpenRouter model",
        default: "openai/gpt-4o",
      });
    }

    allowedTelegramUsers = await input({
      message: "Allowed Telegram user IDs (comma-separated, empty = all)",
      default: "",
    });
  }

  // ── Bazarr ──────────────────────────────────────────────────────────
  const enableBazarr = await confirm({
    message: "Enable Bazarr (automatic subtitles)?",
    default: false,
  });

  // ── Auto-detect system info ─────────────────────────────────────────
  const { uid, gid } = detectUidGid();

  return {
    deploymentMode,
    baseDomain,
    hasProxy,
    letsEncryptEmail,
    timezone,
    mediaMovies,
    mediaTv,
    mediaAnime,
    mediaMusic,
    qbitPassword,
    mcpPublicUrl,
    mcpAuthSecret,
    internalApiKey,
    jellyfinUser,
    jellyfinPassword,
    enableTelegram,
    telegramBotToken,
    llmProvider,
    llmApiKey,
    llmModel,
    allowedTelegramUsers,
    enableBazarr,
    puid: uid,
    pgid: gid,
    localBuild,
  };
}
