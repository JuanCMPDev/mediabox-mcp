/* ─── /api/setup — Desktop Wizard + Settings Admin ──────────────────────────
 *
 * Wizard endpoints (Tier-0):
 *   POST /api/setup/start              — kick off a deploy, NDJSON stream
 *   GET  /api/setup/status             — is a deploy in progress?
 *
 * Tier-A admin endpoints (edit runtime config without re-deploy):
 *   GET  /api/setup/info               — sanitised config snapshot
 *   GET  /api/setup/env-raw            — raw .env (UI masks secrets)
 *   PATCH /api/setup/env               — partial update of allowlisted keys
 *   POST /api/setup/restart-services   — `docker compose restart <svc...>`
 *   POST /api/setup/stack/restart      — restart all containers
 *   POST /api/setup/stack/stop         — stop all containers
 *   POST /api/setup/stack/start        — start all containers
 *
 * Tier-B admin endpoints (per-service integration):
 *   GET  /api/setup/logs/:service      — live NDJSON tail of container logs
 *
 * Auth: every route under /api/setup/* sits behind authMiddleware.
 * ──────────────────────────────────────────────────────────────────────── */
import { Router, type Request, type Response } from "express";
import { mkdir } from "node:fs/promises";
import {
  deployStack,
  validateDeployConfig,
  DockerCliDeployer,
  type DeployConfig,
} from "@mediabox/core";
import type {
  DeployEvent,
  SetupStatus,
  SetupInfo,
  EnvUpdateResult,
  RestartServicesRequest,
  RestartServicesResult,
} from "@mediabox/contracts";
import { VERSION } from "../version.js";
import { readEnvFile, readEnvMap, patchEnvFile, filterEditable, stackDir } from "../helpers/stack-env.js";
import {
  restartServices as runRestartServices,
  stackRestart,
  stackStop,
  stackStart,
  StackUnavailableError,
} from "../helpers/docker-compose.js";
import {
  streamServiceLogs,
  LOG_SERVICE_ALLOWLIST,
} from "../helpers/log-stream.js";

export const setupRouter = Router();

// In-memory single-flight guard — prevents two concurrent deploys against
// the same workdir from corrupting docker-compose.yml. Cleared on completion
// or on stream client disconnect.
let activeDeploy: { startedAt: number; workDir: string } | null = null;

// ── POST /start ──────────────────────────────────────────────────────────────

setupRouter.post("/start", async (req: Request, res: Response): Promise<void> => {
  const { config, workDir, generateOnly } = (req.body ?? {}) as {
    config?: DeployConfig;
    workDir?: string;
    generateOnly?: boolean;
  };

  if (!config) {
    res.status(400).json({ error: "config is required" });
    return;
  }
  if (!workDir?.trim()) {
    res.status(400).json({ error: "workDir is required" });
    return;
  }

  const validation = validateDeployConfig(config);
  if (validation.length > 0) {
    res.status(400).json({ error: "Invalid config", issues: validation });
    return;
  }

  if (activeDeploy) {
    res.status(409).json({
      error: "A deploy is already in progress",
      since: new Date(activeDeploy.startedAt).toISOString(),
      workDir: activeDeploy.workDir,
    });
    return;
  }

  // NDJSON streaming headers — tell any reverse proxy not to buffer.
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Transfer-Encoding", "chunked");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  // Detect client disconnect via the *response* stream — `req.on('close')`
  // fires after express.json() consumes the body (immediately, since the
  // body is small), which would mark us as closed before the first event.
  let closed = false;
  res.on("close", () => { closed = true; });

  // Events from deployStack arrive in fast bursts (file IO is quick). Without
  // an explicit yield between writes, Node's HTTP module batches the chunks
  // and the client only sees the final concatenated payload at res.end().
  // We drain via a microtask + setImmediate pump so each line lands as its
  // own NDJSON chunk.
  const queue: SetupStatus[] = [];
  let pumping = false;

  async function pump(): Promise<void> {
    if (pumping) return;
    pumping = true;
    while (queue.length > 0 && !closed) {
      const payload = queue.shift()!;
      const ok = res.write(JSON.stringify(payload) + "\n");
      if (!ok) {
        await new Promise<void>(resolve => res.once("drain", () => resolve()));
      }
      // Yield once per chunk so Node can flush the TCP packet before we add more.
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    pumping = false;
  }

  function emit(payload: SetupStatus): void {
    if (closed) return;
    queue.push(payload);
    void pump();
  }

  async function flushAndEnd(): Promise<void> {
    while (queue.length > 0 && !closed) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    res.end();
  }

  activeDeploy = { startedAt: Date.now(), workDir };
  const startTime = Date.now();
  const warnings: string[] = [];
  let hadFatalError = false;

  emit({ type: "starting" });

  try {
    await mkdir(workDir, { recursive: true });

    const deployer = new DockerCliDeployer();

    await deployStack({
      config,
      deployer,
      workDir,
      generateOnly: !!generateOnly,
      jellyfinClientVersion: VERSION,
      onEvent: (event: DeployEvent) => {
        if (event.kind === "warn") warnings.push(event.message);
        if (event.kind === "error") hadFatalError = true;
        emit({ type: "event", event });
      },
    });

    emit({
      type: "finished",
      ok: !hadFatalError,
      warnings,
      durationMs: Date.now() - startTime,
    });
  } catch (err) {
    emit({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    activeDeploy = null;
    await flushAndEnd();
  }
});

// ── GET /status ──────────────────────────────────────────────────────────────

setupRouter.get("/status", (_req: Request, res: Response): void => {
  res.json({
    active: !!activeDeploy,
    since: activeDeploy ? new Date(activeDeploy.startedAt).toISOString() : null,
    workDir: activeDeploy?.workDir ?? null,
  });
});

// ── GET /info ────────────────────────────────────────────────────────────────
// Sanitised snapshot of process.env — no passwords or API keys are returned,
// only `hasX: boolean` flags so the Settings panel can render "•••• configured"
// without ever shipping the secret to the webview.

setupRouter.get("/info", async (_req: Request, res: Response): Promise<void> => {
  const env = await readEnvMap();
  const has = (k: string) => Boolean((process.env[k] || env[k] || "").trim());

  // ai provider — derive from which key is set (defaults to "none")
  const aiProvider: SetupInfo["ai"]["provider"] =
    has("OPENROUTER_API_KEY") ? "openrouter"
    : has("GOOGLE_AI_API_KEY") ? "google"
    : "none";

  const allowedIds = (process.env.ALLOWED_TELEGRAM_USERS || env.ALLOWED_TELEGRAM_USERS || "")
    .split(",")
    .map(s => parseInt(s.trim(), 10))
    .filter(n => Number.isFinite(n));

  const info: SetupInfo = {
    stack: {
      workDir:        stackDir(),
      deploymentMode: env.DEPLOYMENT_MODE || "local",
      imageTag:       env.IMAGE_TAG || "latest",
      baseDomain:     env.BASE_DOMAIN?.trim() || null,
    },
    system: {
      timezone: process.env.TZ || env.TZ || "UTC",
      puid:     parseInt(env.PUID || "1000", 10),
      pgid:     parseInt(env.PGID || "1000", 10),
    },
    paths: {
      movies: env.MOVIES_PATH || "./media/movies",
      tv:     env.TV_PATH     || "./media/tv",
      anime:  env.ANIME_PATH  || "./media/anime",
      music:  env.MUSIC_PATH  || "./media/music",
    },
    services: {
      jellyfin: {
        url:        process.env.JELLYFIN_URL    || "http://localhost:8096",
        user:       env.JELLYFIN_ADMIN_USER     || undefined,
        hasApiKey:  has("JELLYFIN_API_KEY"),
      },
      qbittorrent: {
        url:         process.env.QBIT_URL || "http://localhost:8085",
        user:        process.env.QBIT_USER || "admin",
        hasPassword: has("QBIT_PASSWORD"),
      },
      pyload: {
        url:         process.env.PYLOAD_URL || "http://localhost:8001",
        user:        process.env.PYLOAD_USER || "pyload",
        hasPassword: has("PYLOAD_PASSWORD"),
      },
      sonarr: {
        url:        process.env.SONARR_URL || "http://localhost:8989",
        hasApiKey:  has("SONARR_API_KEY"),
      },
      radarr: {
        url:        process.env.RADARR_URL || "http://localhost:7878",
        hasApiKey:  has("RADARR_API_KEY"),
      },
      prowlarr: {
        url:        process.env.PROWLARR_URL || "http://localhost:9696",
        hasApiKey:  has("PROWLARR_API_KEY"),
      },
      flaresolverr: {
        url:        process.env.FLARESOLVERR_URL || "http://localhost:8191",
      },
      bazarr: {
        url:         process.env.BAZARR_URL || "http://localhost:6767",
        enabled:     (process.env.BAZARR_ENABLED || env.BAZARR_ENABLED || "false") === "true",
      },
    },
    ai: {
      provider: aiProvider,
      model:    env.LLM_MODEL?.trim() || null,
      hasKey:   aiProvider !== "none" && has(aiProvider === "openrouter" ? "OPENROUTER_API_KEY" : "GOOGLE_AI_API_KEY"),
    },
    telegram: {
      enabled:        has("TELEGRAM_BOT_TOKEN"),
      hasToken:       has("TELEGRAM_BOT_TOKEN"),
      allowedUserIds: allowedIds,
    },
    app: {
      version: VERSION,
    },
  };

  res.json(info);
});

// ── GET /env-raw ─────────────────────────────────────────────────────────────
// Returns the raw `.env` content. The Settings UI masks anything matching
// /API_KEY|PASSWORD|TOKEN/i before displaying it — we ship the file as-is
// because round-tripping through a mask would lose the plain values that
// the user might want to copy out (e.g. for reuse on another machine).

setupRouter.get("/env-raw", async (_req: Request, res: Response): Promise<void> => {
  const content = await readEnvFile();
  if (content === null) {
    res.status(404).json({ error: "Stack .env not found" });
    return;
  }
  res.type("text/plain").send(content);
});

// ── PATCH /env ───────────────────────────────────────────────────────────────
// Atomic partial update. Rejects any key not in the allowlist. Returns which
// containers must restart for the change to take effect — the UI calls
// /restart-services with that list (and may also call Tauri's restart_sidecar
// if "sidecar" is included).

setupRouter.patch("/env", async (req: Request, res: Response): Promise<void> => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const updates: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) {
    if (typeof v !== "string") {
      res.status(400).json({ error: `value for ${k} must be a string` });
      return;
    }
    updates[k] = v;
  }

  const { accepted, rejected, restarts } = filterEditable(updates);

  const errors: EnvUpdateResult["errors"] = [];
  for (const k of rejected) {
    errors.push({ key: k, message: "key is not in the editable allowlist" });
  }

  if (Object.keys(accepted).length === 0) {
    res.status(400).json({ updated: [], restartRequired: [], errors });
    return;
  }

  try {
    await patchEnvFile(accepted);
  } catch (err) {
    res.status(500).json({
      updated: [],
      restartRequired: [],
      errors: [...errors, { key: "*", message: err instanceof Error ? err.message : String(err) }],
    });
    return;
  }

  const result: EnvUpdateResult = {
    updated:         Object.keys(accepted),
    restartRequired: [...restarts],
    errors,
  };
  res.json(result);
});

// ── POST /restart-services ───────────────────────────────────────────────────

setupRouter.post("/restart-services", async (req: Request, res: Response): Promise<void> => {
  const body = (req.body ?? {}) as Partial<RestartServicesRequest>;
  if (!Array.isArray(body.services) || body.services.length === 0) {
    res.status(400).json({ error: "services[] is required and must be non-empty" });
    return;
  }

  // Filter out "sidecar" — that's restarted from the Tauri Rust side, not here.
  const dockerSvcs = body.services.filter(s => s !== "sidecar");
  if (dockerSvcs.length === 0) {
    res.json({ restarted: [], errors: [] } satisfies RestartServicesResult);
    return;
  }

  try {
    const result = await runRestartServices(dockerSvcs);
    res.json(result satisfies RestartServicesResult);
  } catch (err) {
    if (err instanceof StackUnavailableError) {
      res.status(503).json({ error: err.message });
      return;
    }
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// ── POST /stack/{restart,stop,start} ─────────────────────────────────────────

setupRouter.post("/stack/restart", async (_req: Request, res: Response): Promise<void> => {
  try {
    await stackRestart();
    res.json({ ok: true });
  } catch (err) {
    handleStackError(err, res);
  }
});

setupRouter.post("/stack/stop", async (_req: Request, res: Response): Promise<void> => {
  try {
    await stackStop();
    res.json({ ok: true });
  } catch (err) {
    handleStackError(err, res);
  }
});

setupRouter.post("/stack/start", async (_req: Request, res: Response): Promise<void> => {
  try {
    await stackStart();
    res.json({ ok: true });
  } catch (err) {
    handleStackError(err, res);
  }
});

// ── GET /logs/:service ────────────────────────────────────────────────────────
// Streams `docker compose logs -f --tail=N <service>` as NDJSON LogEvents.
// Reconnects kill the previous child for the same service automatically.

setupRouter.get("/logs/:service", (req: Request, res: Response): void => {
  const { service } = req.params as { service: string };
  const tail = Math.min(Math.max(parseInt((req.query["tail"] as string) || "200", 10), 1), 2000);

  if (!LOG_SERVICE_ALLOWLIST.has(service)) {
    res.status(400).json({
      error: `Unknown service "${service}". Allowed: ${[...LOG_SERVICE_ALLOWLIST].join(", ")}.`,
    });
    return;
  }

  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Transfer-Encoding", "chunked");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  streamServiceLogs(service, res, tail);
});

function handleStackError(err: unknown, res: Response): void {
  if (err instanceof StackUnavailableError) {
    res.status(503).json({ error: err.message });
    return;
  }
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
}
