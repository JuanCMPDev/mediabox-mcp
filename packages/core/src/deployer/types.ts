import type { DeployPhase, EventHandler } from "../events/types.js";
import type { ArtifactPlatform, ResolvedImageDigests } from "../artifacts/lock.js";

/**
 * Strict-profile phase between file generation and image preparation. Emitted
 * as a DeployPhase until @mediabox/contracts adds it to the union.
 */
export const PREPARE_ARTIFACTS_PHASE = "deploy:prepare-artifacts" as string as DeployPhase;

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

export interface PrepareImagesOptions {
  /**
   * Strict profiles: digest-pinned references to fetch. Compose skips services
   * with `pull_policy: never`, so these are pulled explicitly and nothing else is.
   */
  pinnedImages?: string[];
}

export interface UpOptions {
  recreate?: boolean;
  services?: string[];
  /** Strict profiles pass "never": `run` must not fetch or resolve anything. */
  pull?: "never";
}

/** Model digest the provisioner reported after pulling (§3.2 / §3.3). */
export interface ProvisionedModel {
  name: string;
  manifestDigest: string;
}

/**
 * The Deployer interface isolates all side effects (Docker CLI, filesystem,
 * health polling) from the pure core. `DockerCliDeployer` (./docker-cli.ts)
 * implements this via execa + node:fs. A future RemoteDeployer would do the
 * same over SSH.
 */
export interface Deployer {
  /** Pull images from GHCR (or build from source if localBuild). */
  prepareImages(ctx: DeployerContext, opts?: PrepareImagesOptions): Promise<void>;

  /**
   * Start the stack. Equivalent to `docker compose up -d [--force-recreate]`.
   * When `services` is omitted, all services are started.
   */
  up(ctx: DeployerContext, opts?: UpOptions): Promise<void>;

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

  /** Platform of the container engine that will run the stack. */
  serverPlatform(ctx: DeployerContext): Promise<ArtifactPlatform>;

  /**
   * `prepare` only: resolve an image reference to its platform-specific manifest
   * digest (and the multi-arch index, when there is one) without pulling it.
   */
  resolveImage(
    ctx: DeployerContext,
    ref: string,
    platform: ArtifactPlatform
  ): Promise<ResolvedImageDigests>;

  /**
   * `prepare` only: run the compose `provision` profile once. Resolves to the
   * digest the provisioner reported, or null when it reported none.
   */
  runProvisioner(ctx: DeployerContext): Promise<ProvisionedModel | null>;
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
