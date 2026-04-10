import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import type { WizardAnswers, DiscoveredKeys } from "./types.js";
import { readApiKeyFromConfig } from "./utils/xml.js";
import { updateEnvKeys } from "./templates/env.js";
import { pollUntilReady } from "./utils/http.js";
import * as log from "./utils/logger.js";

// Service configurators
import { configureJellyfin, addJellyfinLibraries } from "./services/jellyfin.js";
import * as sonarr from "./services/sonarr.js";
import * as radarr from "./services/radarr.js";
import { configureProwlarr, configureFlareSolverr } from "./services/prowlarr.js";
import { verifyQbittorrent } from "./services/qbittorrent.js";
import { configureArrAuth } from "./services/arr-auth.js";

/**
 * Phase 4: Auto-configure all services via their APIs.
 */
export async function autoConfigureServices(
  answers: WizardAnswers,
  serviceStatus: Map<string, boolean>,
  outputDir: string
): Promise<void> {
  log.header("Phase 4 — Auto-configuring services");

  const keys: Partial<DiscoveredKeys> = {};
  const errors: string[] = [];

  // Helper to run a config step with error isolation
  async function step(name: string, fn: () => Promise<void>): Promise<boolean> {
    try {
      await fn();
      return true;
    } catch (err) {
      const msg = `${name}: ${(err as Error).message}`;
      log.error(msg);
      errors.push(msg);
      return false;
    }
  }

  // ── 4.1: Extract API Keys from XML ──────────────────────────────────
  await step("Extract Sonarr API key", async () => {
    if (!serviceStatus.get("sonarr")) throw new Error("Service not ready");
    keys.sonarrApiKey = await readApiKeyFromConfig(
      path.join(outputDir, "config", "sonarr", "config.xml")
    );
    log.success(`Sonarr API key extracted`);
  });

  await step("Extract Radarr API key", async () => {
    if (!serviceStatus.get("radarr")) throw new Error("Service not ready");
    keys.radarrApiKey = await readApiKeyFromConfig(
      path.join(outputDir, "config", "radarr", "config.xml")
    );
    log.success(`Radarr API key extracted`);
  });

  let prowlarrApiKey = "";
  await step("Extract Prowlarr API key", async () => {
    if (!serviceStatus.get("prowlarr")) throw new Error("Service not ready");
    prowlarrApiKey = await readApiKeyFromConfig(
      path.join(outputDir, "config", "prowlarr", "config.xml")
    );
    log.success(`Prowlarr API key extracted`);
  });

  // ── 4.2: Verify qBittorrent ─────────────────────────────────────────
  if (serviceStatus.get("qbittorrent")) {
    await step("Verify qBittorrent", async () => {
      await verifyQbittorrent(answers.qbitPassword);
    });
  }

  // ── 4.3: Jellyfin setup ─────────────────────────────────────────────
  await step("Configure Jellyfin", async () => {
    if (!serviceStatus.get("jellyfin")) throw new Error("Service not ready");
    keys.jellyfinApiKey = await configureJellyfin(
      answers.jellyfinUser,
      answers.jellyfinPassword
    );
  });

  // ── 4.4: Update .env with discovered keys ───────────────────────────
  await step("Update .env with API keys", async () => {
    const envPath = path.join(outputDir, ".env");
    let envContent = await readFile(envPath, "utf-8");
    const updates: Record<string, string> = {};
    if (keys.jellyfinApiKey) updates.JELLYFIN_API_KEY = keys.jellyfinApiKey;
    if (keys.sonarrApiKey) updates.SONARR_API_KEY = keys.sonarrApiKey;
    if (keys.radarrApiKey) updates.RADARR_API_KEY = keys.radarrApiKey;

    if (Object.keys(updates).length > 0) {
      envContent = updateEnvKeys(envContent, updates);
      await writeFile(envPath, envContent, "utf-8");
      log.success(`Updated .env with ${Object.keys(updates).length} API keys`);
    }
  });

  // ── 4.4b: Configure web UI auth for *arr services ───────────────────
  await step("Configure *arr web UI auth", () =>
    configureArrAuth(
      { sonarr: keys.sonarrApiKey, radarr: keys.radarrApiKey, prowlarr: prowlarrApiKey },
      answers.jellyfinUser,
      answers.jellyfinPassword
    )
  );

  // ── 4.5/4.6: Configure download clients (parallel) ─────────────────
  const dlClientPromises: Promise<boolean>[] = [];

  if (keys.sonarrApiKey && serviceStatus.get("sonarr")) {
    dlClientPromises.push(
      step("Sonarr download client", () =>
        sonarr.addDownloadClient(keys.sonarrApiKey!, answers.qbitPassword)
      )
    );
  }
  if (keys.radarrApiKey && serviceStatus.get("radarr")) {
    dlClientPromises.push(
      step("Radarr download client", () =>
        radarr.addDownloadClient(keys.radarrApiKey!, answers.qbitPassword)
      )
    );
  }
  await Promise.all(dlClientPromises);

  // ── 4.7/4.8: Add root folders (parallel) ────────────────────────────
  const rootFolderPromises: Promise<boolean>[] = [];

  if (keys.sonarrApiKey && serviceStatus.get("sonarr")) {
    rootFolderPromises.push(
      step("Sonarr root folders", () => sonarr.addRootFolders(keys.sonarrApiKey!))
    );
  }
  if (keys.radarrApiKey && serviceStatus.get("radarr")) {
    rootFolderPromises.push(
      step("Radarr root folders", () => radarr.addRootFolders(keys.radarrApiKey!))
    );
  }
  await Promise.all(rootFolderPromises);

  // ── 4.9: Prowlarr sync + FlareSolverr ────────────────────────────────
  if (prowlarrApiKey && keys.sonarrApiKey && keys.radarrApiKey) {
    await step("Prowlarr sync", () =>
      configureProwlarr(prowlarrApiKey, keys.sonarrApiKey!, keys.radarrApiKey!)
    );
    if (serviceStatus.get("flaresolverr")) {
      await step("FlareSolverr proxy", () =>
        configureFlareSolverr(prowlarrApiKey)
      );
    }
  }

  // ── 4.9b: Jellyfin libraries ───────────────────────────────────────
  if (keys.jellyfinApiKey) {
    await step("Jellyfin libraries", () =>
      addJellyfinLibraries(keys.jellyfinApiKey!)
    );
  }

  // ── 4.10: Recreate mcp-server + telegram-bot with updated .env ──────
  // docker compose restart does NOT reload .env — must use "up -d" to
  // recreate containers with the new environment variables.
  await step("Restart services", async () => {
    const spin = log.spinner("Restarting services with updated API keys...");
    const targets = ["mcp-server"];
    if (answers.enableTelegram) targets.push("telegram-bot");
    await execa("docker", ["compose", "up", "-d", "--no-build", "--force-recreate", ...targets], {
      cwd: outputDir,
      stdio: "pipe",
    });
    const ready = await pollUntilReady("http://localhost:3000/health", 30_000);
    if (ready) {
      spin.succeed("Services restarted and healthy");
    } else {
      spin.warn("Services restarted but MCP health check not confirmed");
    }
  });

  // ── 4.11: Print summary ─────────────────────────────────────────────
  printSummary(answers, serviceStatus, errors);
}

function printSummary(
  answers: WizardAnswers,
  serviceStatus: Map<string, boolean>,
  errors: string[]
): void {
  log.header("Setup Complete!");

  const rows: [string, string, string][] = [
    ["Service", "URL", "Status"],
    ["Jellyfin", "http://localhost:8096", serviceStatus.get("jellyfin") ? "Ready" : "Failed"],
    ["MCP Server", "http://localhost:3000", "Ready"],
    ["qBittorrent", "http://localhost:8085", serviceStatus.get("qbittorrent") ? "Ready" : "Failed"],
    ["Sonarr", "http://localhost:8989", serviceStatus.get("sonarr") ? "Ready" : "Failed"],
    ["Radarr", "http://localhost:7878", serviceStatus.get("radarr") ? "Ready" : "Failed"],
    ["Prowlarr", "http://localhost:9696", serviceStatus.get("prowlarr") ? "Ready" : "Failed"],
    ["PyLoad", "http://localhost:8001", serviceStatus.get("pyload") ? "Ready" : "Failed"],
  ];
  log.table(rows);

  console.log();
  log.info(`Jellyfin:     ${answers.jellyfinUser} / ********`);
  log.info(`qBittorrent:  admin / ********`);
  log.info(`PyLoad:       pyload / pyload (default)`);
  log.info(`MCP Public:   ${answers.mcpPublicUrl}`);

  if (errors.length > 0) {
    console.log();
    log.warn(`${errors.length} step(s) had issues:`);
    for (const e of errors) {
      log.error(`  - ${e}`);
    }
  }

  console.log();
  log.header("Next Steps");
  log.info("1. Add indexers (torrent trackers) in Prowlarr → http://localhost:9696");
  if (answers.enableTelegram) {
    log.info("2. Test Telegram bot by sending /start to your bot");
  }
  log.info("");
  log.info(`Web UI credentials (Sonarr/Radarr/Prowlarr): ${answers.jellyfinUser} / ********`);
  console.log();
}
