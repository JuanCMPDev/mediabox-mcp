import type { DeployConfig } from "./config/types.js";
import { validateDeployConfig } from "./config/validate.js";
import type { EventHandler } from "./events/types.js";
import type {
  Deployer,
  DeployerContext,
  DeployResult,
  HealthCheck,
} from "./deployer/types.js";

import { generateDockerCompose } from "./generators/docker-compose.js";
import { generateEnv, updateEnvKeys, type DiscoveredKeys } from "./generators/env.js";
import { generateCaddyfile } from "./generators/caddyfile.js";
import { generateQbittorrentConfig } from "./generators/qbittorrent.js";

import { tryParseApiKey } from "./utils/xml.js";

import { configureJellyfin, addJellyfinLibraries } from "./services/jellyfin.js";
import * as sonarr from "./services/sonarr.js";
import * as radarr from "./services/radarr.js";
import {
  configureProwlarr,
  configureFlareSolverr,
} from "./services/prowlarr.js";
import { verifyQbittorrent } from "./services/qbittorrent.js";
import { configureArrAuth } from "./services/arr-auth.js";

export interface DeployStackOptions {
  config: DeployConfig;
  deployer: Deployer;
  workDir: string;
  onEvent: EventHandler;
  /** Skip docker + configure phases — just generate files. */
  generateOnly?: boolean;
  /**
   * Base URLs used by service API clients. Defaults to localhost:* which is
   * correct for DockerCliDeployer; a remote deployer would override.
   */
  serviceUrls?: Partial<ServiceUrls>;
  /** Client version reported to Jellyfin in the X-Emby-Authorization header. */
  jellyfinClientVersion?: string;
}

interface ServiceUrls {
  jellyfin: string;
  qbittorrent: string;
  pyload: string;
  sonarr: string;
  radarr: string;
  prowlarr: string;
  flaresolverr: string;
  mcp: string;
}

const DEFAULT_SERVICE_URLS: ServiceUrls = {
  jellyfin: "http://localhost:8096",
  qbittorrent: "http://localhost:8085",
  pyload: "http://localhost:8001",
  sonarr: "http://localhost:8989",
  radarr: "http://localhost:7878",
  prowlarr: "http://localhost:9696",
  flaresolverr: "http://localhost:8191",
  mcp: "http://localhost:3000",
};

/**
 * Drive the full stack deploy. Never throws — collects errors per phase
 * into DeployResult.errors so callers can render a useful summary.
 */
export async function deployStack(opts: DeployStackOptions): Promise<DeployResult> {
  const {
    config,
    deployer,
    workDir,
    onEvent,
    generateOnly = false,
    jellyfinClientVersion = "unknown",
  } = opts;
  const serviceUrls: ServiceUrls = { ...DEFAULT_SERVICE_URLS, ...opts.serviceUrls };

  const result: DeployResult = {
    ok: true,
    healthy: {},
    errors: [],
    discoveredKeys: {},
  };
  const ctx: DeployerContext = { workDir, onEvent };

  const step = async (phase: string, startMsg: string, fn: () => Promise<void>) => {
    onEvent({ kind: "start", phase: phase as any, message: startMsg });
    try {
      await fn();
    } catch (err) {
      const message = (err as Error).message || String(err);
      result.errors.push({ phase, message });
      result.ok = false;
      onEvent({ kind: "error", phase: phase as any, message, cause: err });
    }
  };

  // ── Validate ────────────────────────────────────────────────────────
  const validationErrors = validateDeployConfig(config);
  if (validationErrors.length > 0) {
    for (const msg of validationErrors) {
      result.errors.push({ phase: "config:validate", message: msg });
      onEvent({ kind: "error", phase: "config:validate", message: msg });
    }
    result.ok = false;
    return result;
  }
  onEvent({
    kind: "success",
    phase: "config:validate",
    message: "Config validated",
  });

  // ── Generate files ──────────────────────────────────────────────────
  await step("generate:directories", "Creating directory structure", async () => {
    const dirs = [
      "config/jellyfin",
      "config/qbittorrent/qBittorrent",
      "config/sonarr",
      "config/radarr",
      "config/prowlarr",
      "config/pyload",
      "downloads",
      config.paths.movies,
      config.paths.tv,
      config.paths.anime,
      config.paths.music,
    ];
    if (config.services.bazarr.enabled) dirs.push("config/bazarr");
    if (config.deployment.mode === "vps") {
      dirs.push("config/caddy", "config/caddy/data", "config/caddy/config");
    }
    for (const dir of dirs) await deployer.ensureDir(ctx, dir);
    onEvent({
      kind: "success",
      phase: "generate:directories",
      message: `Created ${dirs.length} directories`,
    });
  });

  await step("generate:env", "Generating .env", async () => {
    await deployer.writeFile(ctx, ".env", generateEnv(config));
    onEvent({ kind: "success", phase: "generate:env", message: "Generated .env" });
  });

  await step("generate:compose", "Generating docker-compose.yml", async () => {
    await deployer.writeFile(ctx, "docker-compose.yml", generateDockerCompose(config));
    onEvent({
      kind: "success",
      phase: "generate:compose",
      message: "Generated docker-compose.yml",
    });
  });

  await step(
    "generate:qbittorrent",
    "Pre-configuring qBittorrent password (PBKDF2)",
    async () => {
      await deployer.writeFile(
        ctx,
        "config/qbittorrent/qBittorrent/qBittorrent.conf",
        generateQbittorrentConfig(config.services.qbittorrent.password),
      );
      onEvent({
        kind: "success",
        phase: "generate:qbittorrent",
        message: "Pre-configured qBittorrent password",
      });
    },
  );

  if (config.deployment.mode === "vps") {
    await step("generate:caddy", "Generating Caddyfile", async () => {
      await deployer.writeFile(ctx, "config/caddy/Caddyfile", generateCaddyfile(config));
      onEvent({
        kind: "success",
        phase: "generate:caddy",
        message: "Generated Caddyfile",
      });
    });
  }

  if (generateOnly) return result;

  // ── Deploy ──────────────────────────────────────────────────────────
  await step("deploy:prepare-images", "Preparing Docker images", async () => {
    await deployer.prepareImages(ctx);
  });
  if (!result.ok) return result;

  await step("deploy:start", "Starting Docker containers", async () => {
    await deployer.up(ctx);
  });
  if (!result.ok) return result;

  // ── Health checks ──────────────────────────────────────────────────
  const healthChecks: HealthCheck[] = [
    {
      name: "jellyfin",
      type: "http",
      target: `${serviceUrls.jellyfin}/System/Info/Public`,
      timeoutMs: 150_000,
    },
    {
      name: "qbittorrent",
      type: "http",
      target: serviceUrls.qbittorrent,
      timeoutMs: 60_000,
    },
    {
      name: "pyload",
      type: "http",
      target: serviceUrls.pyload,
      timeoutMs: 60_000,
    },
    {
      name: "sonarr",
      type: "http",
      target: `${serviceUrls.sonarr}/api/v3/system/status`,
      timeoutMs: 150_000,
      acceptAnyStatus: true,
    },
    {
      name: "radarr",
      type: "http",
      target: `${serviceUrls.radarr}/api/v3/system/status`,
      timeoutMs: 150_000,
      acceptAnyStatus: true,
    },
    {
      name: "prowlarr",
      type: "http",
      target: `${serviceUrls.prowlarr}/api/v1/health`,
      timeoutMs: 150_000,
      acceptAnyStatus: true,
    },
    {
      name: "flaresolverr",
      type: "http",
      target: serviceUrls.flaresolverr,
      timeoutMs: 90_000,
    },
  ];

  onEvent({
    kind: "start",
    phase: "deploy:health",
    message: `Waiting for ${healthChecks.length} services to become ready`,
  });
  const healthResults = await Promise.all(
    healthChecks.map(async (check) => {
      const ready = await deployer.waitForHealth(ctx, check);
      return { name: check.name, ready };
    }),
  );
  for (const { name, ready } of healthResults) result.healthy[name] = ready;
  const readyCount = healthResults.filter((r) => r.ready).length;
  if (readyCount === healthResults.length) {
    onEvent({
      kind: "success",
      phase: "deploy:health",
      message: `All ${readyCount} services are ready`,
    });
  } else {
    onEvent({
      kind: "warn",
      phase: "deploy:health",
      message: `${readyCount}/${healthResults.length} services ready`,
    });
  }

  // ── Discover API keys (reads config/*/config.xml through the Deployer) ──
  const discoveredKeys: DiscoveredKeys = {};
  for (const [name, relPath] of [
    ["sonarr", "config/sonarr/config.xml"],
    ["radarr", "config/radarr/config.xml"],
    ["prowlarr", "config/prowlarr/config.xml"],
  ] as const) {
    if (!result.healthy[name]) continue;
    await step(
      "discover:api-keys",
      `Reading ${name} API key`,
      async () => {
        const xml = await deployer.readFile(ctx, relPath);
        const key = tryParseApiKey(xml);
        if (!key) throw new Error(`Could not parse ApiKey from ${relPath}`);
        if (name === "sonarr") discoveredKeys.sonarrApiKey = key;
        if (name === "radarr") discoveredKeys.radarrApiKey = key;
        if (name === "prowlarr") discoveredKeys.prowlarrApiKey = key;
        onEvent({
          kind: "success",
          phase: "discover:api-keys",
          message: `${name} API key extracted`,
        });
      },
    );
  }

  // ── qBittorrent verify ─────────────────────────────────────────────
  if (result.healthy.qbittorrent) {
    await step("configure:qbittorrent", "Verifying qBittorrent login", async () => {
      await verifyQbittorrent(
        {
          baseUrl: serviceUrls.qbittorrent,
          password: config.services.qbittorrent.password,
        },
        onEvent,
      );
    });
  }

  // ── Jellyfin setup ─────────────────────────────────────────────────
  await step("configure:jellyfin", "Configuring Jellyfin", async () => {
    if (!result.healthy.jellyfin) throw new Error("Jellyfin not ready");
    const jfKey = await configureJellyfin(
      {
        baseUrl: serviceUrls.jellyfin,
        adminUsername: config.services.jellyfin.adminUsername,
        adminPassword: config.services.jellyfin.adminPassword,
        clientVersion: jellyfinClientVersion,
      },
      onEvent,
    );
    discoveredKeys.jellyfinApiKey = jfKey;
  });

  // ── Update .env with discovered keys ───────────────────────────────
  await step("write:env-update", "Updating .env with discovered API keys", async () => {
    const existingEnv = await deployer.readFile(ctx, ".env");
    const updates: Record<string, string> = {};
    if (discoveredKeys.jellyfinApiKey) updates.JELLYFIN_API_KEY = discoveredKeys.jellyfinApiKey;
    if (discoveredKeys.sonarrApiKey) updates.SONARR_API_KEY = discoveredKeys.sonarrApiKey;
    if (discoveredKeys.radarrApiKey) updates.RADARR_API_KEY = discoveredKeys.radarrApiKey;
    if (Object.keys(updates).length > 0) {
      const updated = updateEnvKeys(existingEnv, updates);
      await deployer.writeFile(ctx, ".env", updated);
      onEvent({
        kind: "success",
        phase: "write:env-update",
        message: `Updated .env with ${Object.keys(updates).length} API keys`,
      });
    }
  });

  // ── *arr web UI auth (non-fatal) ──────────────────────────────────
  const arrAuthTargets = [
    {
      name: "Sonarr",
      baseUrl: serviceUrls.sonarr,
      apiVersion: "v3" as const,
      apiKey: discoveredKeys.sonarrApiKey,
    },
    {
      name: "Radarr",
      baseUrl: serviceUrls.radarr,
      apiVersion: "v3" as const,
      apiKey: discoveredKeys.radarrApiKey,
    },
    {
      name: "Prowlarr",
      baseUrl: serviceUrls.prowlarr,
      apiVersion: "v1" as const,
      apiKey: discoveredKeys.prowlarrApiKey,
    },
  ]
    .filter((s): s is { name: string; baseUrl: string; apiVersion: "v1" | "v3"; apiKey: string } =>
      Boolean(s.apiKey),
    );

  if (arrAuthTargets.length > 0) {
    await step("configure:arr-auth", "Configuring *arr web UI auth", async () => {
      await configureArrAuth(
        {
          services: arrAuthTargets,
          username: config.services.jellyfin.adminUsername,
          password: config.services.jellyfin.adminPassword,
        },
        onEvent,
      );
    });
  }

  // ── Download clients (parallel) ────────────────────────────────────
  const downloadClientPromises: Promise<void>[] = [];
  if (discoveredKeys.sonarrApiKey && result.healthy.sonarr) {
    downloadClientPromises.push(
      step("configure:sonarr", "Adding Sonarr download client", async () => {
        await sonarr.addDownloadClient(
          {
            baseUrl: serviceUrls.sonarr,
            apiKey: discoveredKeys.sonarrApiKey!,
            qbitPassword: config.services.qbittorrent.password,
          },
          onEvent,
        );
      }),
    );
  }
  if (discoveredKeys.radarrApiKey && result.healthy.radarr) {
    downloadClientPromises.push(
      step("configure:radarr", "Adding Radarr download client", async () => {
        await radarr.addDownloadClient(
          {
            baseUrl: serviceUrls.radarr,
            apiKey: discoveredKeys.radarrApiKey!,
            qbitPassword: config.services.qbittorrent.password,
          },
          onEvent,
        );
      }),
    );
  }
  await Promise.all(downloadClientPromises);

  // ── Root folders (parallel) ────────────────────────────────────────
  const rootFolderPromises: Promise<void>[] = [];
  if (discoveredKeys.sonarrApiKey && result.healthy.sonarr) {
    rootFolderPromises.push(
      step("configure:sonarr", "Adding Sonarr root folders", async () => {
        await sonarr.addRootFolders(
          { baseUrl: serviceUrls.sonarr, apiKey: discoveredKeys.sonarrApiKey! },
          onEvent,
        );
      }),
    );
  }
  if (discoveredKeys.radarrApiKey && result.healthy.radarr) {
    rootFolderPromises.push(
      step("configure:radarr", "Adding Radarr root folder", async () => {
        await radarr.addRootFolders(
          { baseUrl: serviceUrls.radarr, apiKey: discoveredKeys.radarrApiKey! },
          onEvent,
        );
      }),
    );
  }
  await Promise.all(rootFolderPromises);

  // ── Prowlarr sync + FlareSolverr ──────────────────────────────────
  if (
    discoveredKeys.prowlarrApiKey &&
    discoveredKeys.sonarrApiKey &&
    discoveredKeys.radarrApiKey
  ) {
    await step("configure:prowlarr", "Configuring Prowlarr sync", async () => {
      await configureProwlarr(
        {
          baseUrl: serviceUrls.prowlarr,
          apiKey: discoveredKeys.prowlarrApiKey!,
          sonarrApiKey: discoveredKeys.sonarrApiKey!,
          radarrApiKey: discoveredKeys.radarrApiKey!,
        },
        onEvent,
      );
    });
    if (result.healthy.flaresolverr) {
      await step("configure:flaresolverr", "Configuring FlareSolverr proxy", async () => {
        await configureFlareSolverr(
          {
            baseUrl: serviceUrls.prowlarr,
            apiKey: discoveredKeys.prowlarrApiKey!,
          },
          onEvent,
        );
      });
    }
  }

  // ── Jellyfin libraries ─────────────────────────────────────────────
  if (discoveredKeys.jellyfinApiKey) {
    await step("configure:jellyfin-libraries", "Adding Jellyfin libraries", async () => {
      await addJellyfinLibraries(
        { baseUrl: serviceUrls.jellyfin, apiKey: discoveredKeys.jellyfinApiKey! },
        onEvent,
      );
    });
  }

  // ── Recreate mcp-server + telegram-bot with the fresh .env ────────
  await step("deploy:restart", "Restarting services with new API keys", async () => {
    const targets = ["mcp-server"];
    if (config.telegram) targets.push("telegram-bot");
    await deployer.up(ctx, { recreate: true, services: targets });
    // Wait for MCP to come back
    const ready = await deployer.waitForHealth(ctx, {
      name: "mcp-server",
      type: "http",
      target: `${serviceUrls.mcp}/health`,
      timeoutMs: 30_000,
    });
    if (ready) {
      onEvent({
        kind: "success",
        phase: "deploy:restart",
        message: "Services restarted and healthy",
      });
    } else {
      onEvent({
        kind: "warn",
        phase: "deploy:restart",
        message: "Services restarted but MCP health check not confirmed",
      });
    }
  });

  result.discoveredKeys = discoveredKeys;
  return result;
}
