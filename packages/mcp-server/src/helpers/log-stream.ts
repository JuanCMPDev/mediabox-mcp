/* ─── Live container log streaming ─────────────────────────────────────────
 * Wraps `docker compose logs -f` and emits each line as a LogEvent over an
 * Express Response so the UI can tail container output in real time.
 *
 * One process per service. Callers must call stopLogStream(service) (or let
 * the response close) before opening a second stream on the same service —
 * the route handler does this automatically on reconnect.
 * ──────────────────────────────────────────────────────────────────────── */
import readline from "node:readline";
import type { Response }       from "express";
import { execa } from "execa";
import { stackDir }            from "./stack-env.js";

export const LOG_SERVICE_ALLOWLIST = new Set([
  "jellyfin",
  "sonarr",
  "radarr",
  "prowlarr",
  "qbittorrent",
  "pyload",
  "flaresolverr",
  "bazarr",
]);

// One active child process per service name.
const activeStreams = new Map<string, ReturnType<typeof execa>>();

/**
 * Kill the log stream for `service` if one is already running.
 * Called before opening a new stream so reconnects don't stack up processes.
 */
export function stopLogStream(service: string): void {
  const prev = activeStreams.get(service);
  if (prev) {
    prev.kill("SIGTERM");
    activeStreams.delete(service);
  }
}

/**
 * Spawn `docker compose logs -f` for `service`, pipe each line as NDJSON
 * `LogEvent` objects to `res`, and clean up when the client disconnects.
 *
 * The caller is responsible for setting NDJSON response headers and calling
 * `res.flushHeaders()` before invoking this function.
 */
export function streamServiceLogs(
  service: string,
  res: Response,
  tail = 200,
): void {
  const cwd = stackDir();
  if (!cwd) {
    res.write(JSON.stringify({ type: "closed", reason: "error", message: "STACK_DIR not set — wizard has not completed yet." }) + "\n");
    res.end();
    return;
  }

  stopLogStream(service); // kill any previous stream for this service

  const child = execa(
    "docker",
    ["compose", "logs", "-f", "--tail", String(tail), "--timestamps", service],
    { cwd, reject: false, stdio: ["ignore", "pipe", "pipe"] },
  );

  activeStreams.set(service, child);

  // Line-buffer stdout. Each line arrives asynchronously so we write directly
  // (no queue needed — readline already serialises the lines).
  const rl = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });

  rl.on("line", (raw) => {
    if (!res.writable) return;
    res.write(JSON.stringify({ type: "log", line: raw, ts: new Date().toISOString() }) + "\n");
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    const msg = chunk.toString().trim();
    if (!msg || !res.writable) return;
    // stderr from docker compose (e.g. "service not found") — surface as log lines
    res.write(JSON.stringify({ type: "log", line: `[stderr] ${msg}`, ts: new Date().toISOString() }) + "\n");
  });

  child.on("exit", (code: number | null, signal: string | null) => {
    activeStreams.delete(service);
    if (!res.writable) return;
    const reason = signal === "SIGTERM" ? "killed" : code === 0 ? "eof" : "error";
    res.write(JSON.stringify({ type: "closed", reason, message: code !== 0 && !signal ? `exit ${code}` : undefined }) + "\n");
    res.end();
  });

  // Client disconnected — kill child gracefully.
  res.on("close", () => {
    if (activeStreams.get(service) === child) {
      child.kill("SIGTERM");
      activeStreams.delete(service);
    }
  });
}
