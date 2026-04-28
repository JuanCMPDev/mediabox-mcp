/* ─── docker compose runner ────────────────────────────────────────────────
 * Thin wrapper around `docker compose` for the admin endpoints. All commands
 * run with cwd = STACK_DIR so they target the right project automatically
 * (no need for `-p <name>` flags or .env juggling).
 *
 * Returns structured results so the API layer can build user-friendly
 * `RestartServicesResult` payloads without parsing stderr text.
 * ──────────────────────────────────────────────────────────────────────── */
import readline from "node:readline";
import type { Response } from "express";
import { execa, type Subprocess } from "execa";
import type { PullEvent } from "@mediabox/contracts";
import { stackDir } from "./stack-env.js";

export class StackUnavailableError extends Error {
  constructor() {
    super("STACK_DIR is not set — the wizard has not completed yet.");
  }
}

async function compose(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const cwd = stackDir();
  if (!cwd) throw new StackUnavailableError();

  const { stdout, stderr, exitCode } = await execa("docker", ["compose", ...args], {
    cwd,
    stdio: "pipe",
    reject: false,
    timeout: 5 * 60_000, // 5 min — `pull` can take a while
  });

  if (exitCode !== 0) {
    const tail = (stderr || stdout || "").split("\n").slice(-3).join(" ").trim();
    throw new Error(`docker compose ${args.join(" ")} failed (exit ${exitCode}): ${tail}`);
  }
  return { stdout, stderr };
}

export async function restartServices(services: string[]): Promise<{
  restarted: string[];
  errors:    Array<{ service: string; message: string }>;
}> {
  const restarted: string[] = [];
  const errors:    Array<{ service: string; message: string }> = [];

  // Run sequentially so one slow service doesn't compound failures.
  for (const svc of services) {
    try {
      await compose(["restart", svc]);
      restarted.push(svc);
    } catch (err) {
      errors.push({ service: svc, message: err instanceof Error ? err.message : String(err) });
    }
  }

  return { restarted, errors };
}

export async function stackRestart(): Promise<void> {
  await compose(["restart"]);
}

export async function stackStop(): Promise<void> {
  await compose(["stop"]);
}

export async function stackStart(): Promise<void> {
  await compose(["start"]);
}

export async function stackUp(): Promise<void> {
  await compose(["up", "-d", "--remove-orphans"]);
}

export async function stopServices(services: string[]): Promise<void> {
  for (const svc of services) {
    await compose(["stop", svc]);
  }
}

export async function startServices(services: string[]): Promise<void> {
  for (const svc of services) {
    await compose(["start", svc]);
  }
}

/**
 * Recreate one or more containers against the current `.env` and
 * `docker-compose.yml` — required when the change is something Docker bakes
 * into the container at `up` time (env vars like `TZ`, `PUID`, `PGID`, or
 * bind-mount sources resolved from `${MOVIES_PATH}` etc.). A simple
 * `restart` is a no-op for those because the container already has the old
 * value baked in.
 *
 * `--no-deps` keeps Compose from also recreating dependent containers that
 * don't actually need it. Volumes survive recreate (this is named-volume
 * docker-compose behaviour), so user data is preserved.
 *
 * Errors are collected per-service so a single failing container doesn't
 * abort the whole batch — caller decides how to surface them.
 */
export async function recreateServices(services: string[]): Promise<{
  recreated: string[];
  errors:    Array<{ service: string; message: string }>;
}> {
  const recreated: string[] = [];
  const errors:    Array<{ service: string; message: string }> = [];

  for (const svc of services) {
    try {
      await compose(["up", "-d", "--no-deps", "--force-recreate", svc]);
      recreated.push(svc);
    } catch (err) {
      errors.push({ service: svc, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { recreated, errors };
}

/**
 * Recreate every container in the stack. Used when the affected env var
 * (TZ, PUID, PGID) is consumed by every service.
 */
export async function recreateAll(): Promise<void> {
  await compose(["up", "-d", "--force-recreate"]);
}

/**
 * Stream `docker compose pull --progress plain` to `res` as NDJSON PullEvents.
 * The caller must set NDJSON headers and call `res.flushHeaders()` first.
 * Kills the child process when the client disconnects.
 */
export function streamDockerPull(res: Response, t?: (key: string, opts?: any) => string): void {
  const cwd = stackDir();
  if (!cwd) {
    res.write(JSON.stringify({ type: "done", ok: false, message: t ? t("errors.stackUnavailable") : "STACK_DIR is not configured — wizard not completed." } satisfies PullEvent) + "\n");
    res.end();
    return;
  }

  // Note: `docker compose pull` does NOT accept --progress (only `up` and
  // `build` do). Default output goes to stderr line-by-line, which is what
  // we want — readline picks it up below.
  const child = execa(
    "docker",
    ["compose", "pull"],
    { cwd, reject: false, stdio: ["ignore", "pipe", "pipe"] },
  );

  let closed = false;
  res.on("close", () => {
    closed = true;
    child.kill("SIGTERM");
  });

  function writeLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed && !closed) {
      res.write(JSON.stringify({ type: "log", line: trimmed } satisfies PullEvent) + "\n");
    }
  }

  const rlOut = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
  const rlErr = readline.createInterface({ input: child.stderr!, crlfDelay: Infinity });
  rlOut.on("line", writeLine);
  rlErr.on("line", writeLine);

  void child.then(result => {
    rlOut.close();
    rlErr.close();
    if (closed) return;
    const exitCode = result.exitCode ?? 1;
    const lastErr = (result.stderr ?? "").trim().split("\n").pop()?.trim();
    const msg = exitCode !== 0 ? lastErr : undefined;
    res.write(JSON.stringify({ type: "done", ok: exitCode === 0, message: msg } satisfies PullEvent) + "\n");
    res.end();
  });
}

/** `docker compose ps --format json` — returns one JSON object per line. */
export async function stackPs(): Promise<Array<{
  Service: string;
  State:   string;
  Health:  string;
  Status:  string;
}>> {
  const { stdout } = await compose(["ps", "--format", "json"]);
  return stdout
    .split("\n")
    .map(s => s.trim())
    .filter(Boolean)
    .map(line => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
}
