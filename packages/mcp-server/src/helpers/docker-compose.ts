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

/**
 * Stream `docker compose pull --progress plain` to `res` as NDJSON PullEvents.
 * The caller must set NDJSON headers and call `res.flushHeaders()` first.
 * Kills the child process when the client disconnects.
 */
export function streamDockerPull(res: Response): void {
  const cwd = stackDir();
  if (!cwd) {
    res.write(JSON.stringify({ type: "done", ok: false, message: "STACK_DIR is not configured — wizard not completed." } satisfies PullEvent) + "\n");
    res.end();
    return;
  }

  const child = execa(
    "docker",
    ["compose", "pull", "--progress", "plain"],
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
