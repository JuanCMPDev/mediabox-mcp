import type { EventHandler } from "../events/types.js";

/**
 * Context passed to every Deployer call. Isolates the workspace location
 * from the deployer's internal state and surfaces a consistent event channel.
 */
export interface DeployerContext {
  /** Directory containing docker-compose.yml and config/. */
  workDir: string;
  onEvent: EventHandler;
}

/**
 * Health check definition. `type: "http"` polls a URL; `type: "file"` polls
 * for a file (optionally containing an XML tag) — used for *arr services
 * that write config.xml before the HTTP API is listening.
 */
export interface HealthCheck {
  name: string;
  type: "http" | "file";
  /** URL for http checks, path relative to workDir for file checks. */
  target: string;
  timeoutMs: number;
  /** For file checks: XML tag whose presence marks readiness. */
  xmlTag?: string;
  /**
   * For http checks: accept any HTTP response (e.g. 401) as "ready".
   * Useful when a service requires auth but we just want to know the
   * HTTP listener is up.
   */
  acceptAnyStatus?: boolean;
}

/**
 * The Deployer interface isolates all side effects (Docker CLI, filesystem,
 * health polling) from the pure core. `DockerCliDeployer` (./docker-cli.ts)
 * implements this via execa + node:fs. A future RemoteDeployer would do the
 * same over SSH.
 */
export interface Deployer {
  /** Pull images from GHCR (or build from source if localBuild). */
  prepareImages(ctx: DeployerContext): Promise<void>;

  /**
   * Start the stack. Equivalent to `docker compose up -d [--force-recreate]`.
   * When `services` is omitted, all services are started.
   */
  up(
    ctx: DeployerContext,
    opts?: { recreate?: boolean; services?: string[] }
  ): Promise<void>;

  /** Poll a health check until healthy or timeout. */
  waitForHealth(
    ctx: DeployerContext,
    check: HealthCheck
  ): Promise<boolean>;

  /** Read a file from workDir (throws if missing). */
  readFile(ctx: DeployerContext, relPath: string): Promise<string>;

  /** Write a file to workDir (creates parent dirs as needed). */
  writeFile(
    ctx: DeployerContext,
    relPath: string,
    content: string
  ): Promise<void>;

  /** Ensure a directory exists under workDir. */
  ensureDir(ctx: DeployerContext, relPath: string): Promise<void>;
}

export interface DeployResult {
  ok: boolean;
  /** Per-service health after deploy:health phase */
  healthy: Record<string, boolean>;
  /** Errors captured per phase (deployStack never throws — it collects and returns) */
  errors: Array<{ phase: string; message: string }>;
  /** API keys discovered during the run */
  discoveredKeys: {
    jellyfinApiKey?: string;
    sonarrApiKey?: string;
    radarrApiKey?: string;
    prowlarrApiKey?: string;
  };
}
