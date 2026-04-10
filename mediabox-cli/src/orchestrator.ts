import { execa } from "execa";
import path from "node:path";
import type { ServiceHealth } from "./types.js";
import { pollUntilReady, sleep } from "./utils/http.js";
import { tryReadApiKey } from "./utils/xml.js";
import * as log from "./utils/logger.js";

interface ReadinessResult {
  name: string;
  ready: boolean;
}

/**
 * Phase 3: Start Docker Compose and poll until all services are ready.
 *
 * Readiness = the service's HTTP API actually responds.
 * For Sonarr/Radarr/Prowlarr we first wait for config.xml (API key),
 * then confirm the HTTP API is up — config.xml appears well before the
 * API is listening, so file-only checks cause Phase 4 race conditions.
 */
export async function orchestrate(outputDir: string): Promise<Map<string, boolean>> {
  log.header("Phase 3 — Starting Docker containers");

  // Step 1: Pull images (quiet — Docker's ANSI progress spam breaks non-TTY terminals)
  const pullSpin = log.spinner("Pulling Docker images...");
  try {
    await execa("docker", ["compose", "pull", "--quiet"], {
      cwd: outputDir,
      stdio: "pipe",
    });
    pullSpin.succeed("Docker images pulled");
  } catch (err) {
    pullSpin.fail("Failed to pull images");
    log.error((err as any).stderr || (err as Error).message);
    throw new Error("Failed to pull Docker images");
  }

  // Step 2: Build local images if needed (plain progress — one line per step, no ANSI rewriting)
  const buildSpin = log.spinner("Building local images...");
  try {
    const result = await execa(
      "docker", ["compose", "build", "--progress=plain"],
      { cwd: outputDir, stdio: "pipe" }
    );
    // Check if there was actually anything to build
    if (result.stdout.includes("DONE") || result.stderr.includes("DONE")) {
      buildSpin.succeed("Local images built");
    } else {
      buildSpin.succeed("No local images to build");
    }
  } catch (err) {
    // Build fails if there are no build: directives — that's fine
    const stderr = (err as any).stderr || "";
    if (stderr.includes("no build") || stderr.includes("no service")) {
      buildSpin.succeed("No local images to build");
    } else {
      buildSpin.fail("Build failed");
      log.error(stderr || (err as Error).message);
      throw new Error("Failed to build Docker images");
    }
  }

  // Step 3: Start containers (fast — images already ready)
  const upSpin = log.spinner("Starting containers...");
  try {
    await execa("docker", ["compose", "up", "-d", "--no-build"], {
      cwd: outputDir,
      stdio: "pipe",
    });
    upSpin.succeed("Docker containers started");
  } catch (err) {
    upSpin.fail("Failed to start containers");
    log.error((err as any).stderr || (err as Error).message);
    throw new Error("Failed to start Docker containers");
  }

  // Define service readiness checks — all use HTTP as the final gate
  const services: ServiceHealth[] = [
    {
      name: "jellyfin",
      status: "pending",
      checkType: "http",
      target: "http://localhost:8096/System/Info/Public",
      timeoutMs: 150_000,
    },
    {
      name: "qbittorrent",
      status: "pending",
      checkType: "http",
      target: "http://localhost:8085",
      timeoutMs: 60_000,
    },
    {
      name: "pyload",
      status: "pending",
      checkType: "http",
      target: "http://localhost:8001",
      timeoutMs: 60_000,
    },
    {
      name: "sonarr",
      status: "pending",
      checkType: "http",
      target: "http://localhost:8989/api/v3/system/status",
      timeoutMs: 150_000,
      xmlTag: "ApiKey",
    },
    {
      name: "radarr",
      status: "pending",
      checkType: "http",
      target: "http://localhost:7878/api/v3/system/status",
      timeoutMs: 150_000,
      xmlTag: "ApiKey",
    },
    {
      name: "prowlarr",
      status: "pending",
      checkType: "http",
      target: "http://localhost:9696/api/v1/health",
      timeoutMs: 150_000,
      xmlTag: "ApiKey",
    },
    {
      name: "flaresolverr",
      status: "pending",
      checkType: "http",
      target: "http://localhost:8191",
      timeoutMs: 90_000,
    },
  ];

  log.info(`Waiting for ${services.length} services to become ready...`);
  console.log();

  // Poll all services in parallel
  const results = await Promise.all(
    services.map((svc) => pollService(svc, outputDir))
  );

  // Build results map
  const statusMap = new Map<string, boolean>();
  for (const result of results) {
    statusMap.set(result.name, result.ready);
  }

  // Summary
  const readyCount = results.filter((r) => r.ready).length;
  console.log();
  if (readyCount === results.length) {
    log.success(`All ${readyCount} services are ready`);
  } else {
    log.warn(`${readyCount}/${results.length} services ready`);
    for (const r of results.filter((r) => !r.ready)) {
      log.error(`  ${r.name} failed to start — run: docker compose logs ${r.name}`);
    }
  }

  return statusMap;
}

async function pollService(
  svc: ServiceHealth,
  outputDir: string
): Promise<ReadinessResult> {
  const spin = log.spinner(`Waiting for ${svc.name}...`);
  const start = Date.now();

  // For *arr services: first wait for config.xml (API key), then confirm HTTP is up
  if (svc.xmlTag) {
    const configMap: Record<string, string> = {
      sonarr: path.join(outputDir, "config", "sonarr", "config.xml"),
      radarr: path.join(outputDir, "config", "radarr", "config.xml"),
      prowlarr: path.join(outputDir, "config", "prowlarr", "config.xml"),
    };
    const configPath = configMap[svc.name];
    if (configPath) {
      const fileReady = await pollFileReady(configPath, svc.timeoutMs);
      if (!fileReady) {
        spin.fail(`${svc.name} config.xml not found after ${svc.timeoutMs / 1000}s`);
        return { name: svc.name, ready: false };
      }
    }
  }

  // HTTP readiness gate — for *arr services accept any response (they return 401
  // without auth, but that still means the API is up and listening)
  const remaining = svc.timeoutMs - (Date.now() - start);
  const needsAuth = !!svc.xmlTag;
  const ready = await pollUntilReady(svc.target, Math.max(remaining, 30_000), {
    acceptAny: needsAuth,
  });

  if (ready) {
    spin.succeed(`${svc.name} is ready`);
  } else {
    spin.fail(`${svc.name} timed out after ${svc.timeoutMs / 1000}s`);
  }

  return { name: svc.name, ready };
}

async function pollFileReady(filePath: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  let delay = 2000;

  while (Date.now() - start < timeoutMs) {
    const key = await tryReadApiKey(filePath);
    if (key) return true;
    await sleep(delay);
    delay = Math.min(delay * 2, 8000);
  }
  return false;
}
