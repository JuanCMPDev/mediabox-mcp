/* ─── Stack `.env` I/O helpers ──────────────────────────────────────────────
 * Read / mutate `<STACK_DIR>/.env` from the desktop sidecar's admin endpoints.
 * Reuses `updateEnvKeys` from `@mediabox/core` for line-level precision.
 *
 * The sidecar receives STACK_DIR as an env var from the Tauri Rust shell at
 * spawn time (set by `sidecar.rs` after reading state.json). All admin
 * mutations are anchored to that path — we never edit anything outside it.
 * ──────────────────────────────────────────────────────────────────────── */
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { updateEnvKeys, generateQbittorrentConfig } from "@mediabox/core";

export function stackDir(): string | null {
  return process.env.STACK_DIR?.trim() || null;
}

export function envPath(): string | null {
  const d = stackDir();
  return d ? path.join(d, ".env") : null;
}

export async function readEnvFile(): Promise<string | null> {
  const p = envPath();
  if (!p) return null;
  try {
    return await readFile(p, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function readEnvMap(): Promise<Record<string, string>> {
  const content = await readEnvFile();
  if (!content) return {};
  const out: Record<string, string> = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx < 1) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
    out[k] = v;
  }
  return out;
}

/**
 * Apply a partial env update atomically. Reads current `.env`, runs
 * `updateEnvKeys`, writes to a temp file, then renames over the original
 * so a crash mid-write can never corrupt the file.
 *
 * Also re-generates `config/qbittorrent/qBittorrent/qBittorrent.conf` with
 * the new PBKDF2 hash if `QBIT_PASSWORD` is among the patched keys —
 * otherwise the qBittorrent container would still authenticate with the
 * old hash on next restart.
 */
export async function patchEnvFile(updates: Record<string, string>): Promise<void> {
  const current = await readEnvFile() ?? "";
  const next = updateEnvKeys(current, updates);

  const target = envPath();
  if (!target) throw new Error("STACK_DIR is not set; sidecar cannot edit .env");

  const tmp = `${target}.tmp-${Date.now()}`;
  await writeFile(tmp, next, "utf-8");
  await rename(tmp, target);

  // qBittorrent stores its password as a PBKDF2 hash inside qBittorrent.conf.
  // The .env's QBIT_PASSWORD is just for downstream consumers (mcp-server's
  // qBit client). The container reads its own config file, so we have to
  // regenerate that file too whenever the password rotates.
  if (Object.prototype.hasOwnProperty.call(updates, "QBIT_PASSWORD")) {
    const dir = stackDir()!;
    const confPath = path.join(dir, "config", "qbittorrent", "qBittorrent");
    await mkdir(confPath, { recursive: true });
    const conf = generateQbittorrentConfig(updates.QBIT_PASSWORD);
    await writeFile(path.join(confPath, "qBittorrent.conf"), conf, "utf-8");
  }
}

/* ─── Allowlist of editable keys ─────────────────────────────────────────────
 * Anything outside this list is rejected by `PATCH /api/setup/env`. Prevents
 * the UI (or a malicious script in the webview) from breaking foundational
 * runtime config like INTERNAL_API_KEY, PORT, MCP_PUBLIC_URL, image_tag, etc.
 *
 * Each key declares a `strategy` and a `targets` list:
 *   - "restart"  — services react to env changes by restarting the existing
 *                  container (`docker compose restart`). Use for credentials
 *                  the container reads at request time, or "sidecar" / the
 *                  bundled telegram-bot which the Tauri shell respawns.
 *   - "recreate" — Docker bakes the env var into the container at `up` time
 *                  (TZ, PUID, PGID) or the value is part of a bind-mount
 *                  spec (path vars). A simple restart is a no-op for these;
 *                  the container has to be torn down and recreated against
 *                  the updated `.env`. Use the special target `"all"` when
 *                  the change affects every container in the stack.
 * ──────────────────────────────────────────────────────────────────────── */
export type EditableEnvStrategy = "restart" | "recreate";

export interface EditableEnvSpec {
  strategy: EditableEnvStrategy;
  targets:  string[];
}

export const EDITABLE_ENV_KEYS: Record<string, EditableEnvSpec> = {
  // ── AI provider (chat in app + telegram bot) ──────────────────────────────
  LLM_PROVIDER:        { strategy: "restart", targets: ["sidecar", "telegram-bot"] },
  OPENROUTER_API_KEY:  { strategy: "restart", targets: ["sidecar", "telegram-bot"] },
  GOOGLE_AI_API_KEY:   { strategy: "restart", targets: ["sidecar", "telegram-bot"] },
  LLM_MODEL:           { strategy: "restart", targets: ["sidecar", "telegram-bot"] },

  // ── Telegram bot config ───────────────────────────────────────────────────
  TELEGRAM_BOT_TOKEN:      { strategy: "restart", targets: ["telegram-bot"] },
  ALLOWED_TELEGRAM_USERS:  { strategy: "restart", targets: ["telegram-bot"] },

  // ── Service credentials ───────────────────────────────────────────────────
  // qBittorrent stores its actual password as a PBKDF2 hash inside
  // qBittorrent.conf — patchEnvFile regenerates that file. The qbittorrent
  // container has to be stopped before we edit (otherwise it overwrites
  // our hash on SIGTERM); the PATCH /env handler does that dance, so we
  // don't return "qbittorrent" in restart targets here. The sidecar still
  // needs to restart so its qBit client uses the new password.
  QBIT_PASSWORD:    { strategy: "restart", targets: ["sidecar"] },
  // PyLoad's actual user/password live in its own DB and are not read from
  // env vars. Changing these just syncs mcp-server's auth credentials —
  // the user must change the real password through PyLoad's UI first.
  PYLOAD_USER:      { strategy: "restart", targets: ["sidecar"] },
  PYLOAD_PASSWORD:  { strategy: "restart", targets: ["sidecar"] },

  // ── Infrastructure (PR 3.4a) ──────────────────────────────────────────────
  // Media paths are referenced from docker-compose.yml as ${VAR} bind-mount
  // sources, so a `restart` keeps the old mount and silently does nothing.
  // We need to recreate the affected containers against the new `.env`.
  MOVIES_PATH:  { strategy: "recreate", targets: ["radarr", "jellyfin", "mcp-server"] },
  TV_PATH:      { strategy: "recreate", targets: ["sonarr", "jellyfin", "mcp-server"] },
  ANIME_PATH:   { strategy: "recreate", targets: ["sonarr", "jellyfin", "mcp-server"] },
  MUSIC_PATH:   { strategy: "recreate", targets: ["jellyfin", "mcp-server"] },
  // TZ / PUID / PGID are baked into every container's env at `up` time;
  // recreating the whole stack is the cleanest way to apply them. The
  // "all" sentinel translates to `docker compose up -d --force-recreate`
  // (no service arg) inside the recreate handler.
  TZ:    { strategy: "recreate", targets: ["all"] },
  PUID:  { strategy: "recreate", targets: ["all"] },
  PGID:  { strategy: "recreate", targets: ["all"] },
};

export function filterEditable(updates: Record<string, string>): {
  accepted:  Record<string, string>;
  rejected:  string[];
  restarts:  Set<string>;
  recreates: Set<string>;
} {
  const accepted: Record<string, string> = {};
  const rejected: string[] = [];
  const restarts  = new Set<string>();
  const recreates = new Set<string>();

  for (const [k, v] of Object.entries(updates)) {
    const spec = EDITABLE_ENV_KEYS[k];
    if (!spec) {
      rejected.push(k);
      continue;
    }
    accepted[k] = v;
    const bucket = spec.strategy === "restart" ? restarts : recreates;
    for (const svc of spec.targets) bucket.add(svc);
  }
  return { accepted, rejected, restarts, recreates };
}
