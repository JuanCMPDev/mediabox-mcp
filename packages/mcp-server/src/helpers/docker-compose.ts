/* ─── docker compose runner ────────────────────────────────────────────────
 * Thin wrapper around `docker compose` for the admin endpoints. All commands
 * run with cwd = STACK_DIR so they target the right project automatically
 * (no need for `-p <name>` flags or .env juggling).
 *
 * Returns structured results so the API layer can build user-friendly
 * `RestartServicesResult` payloads without parsing stderr text.
 * ──────────────────────────────────────────────────────────────────────── */
import { execa } from "execa";
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
