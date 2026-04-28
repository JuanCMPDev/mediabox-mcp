import { QBIT_URL, QBIT_USER, QBIT_PASS } from "../config.js";

let qbitCookie: string | null = null;

export async function qbitLogin(): Promise<void> {
  const res = await fetch(`${QBIT_URL}/api/v2/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: QBIT_USER, password: QBIT_PASS }),
  });
  const text = await res.text();
  if (text !== "Ok.") throw new Error("qBittorrent login failed");
  const cookie = res.headers.get("set-cookie")?.split(";")[0];
  if (cookie) qbitCookie = cookie;
}

export async function qbitApi(endpoint: string, method: "GET" | "POST" = "GET", body?: Record<string, string>): Promise<any> {
  if (!qbitCookie) await qbitLogin();
  const opts: RequestInit = { method, headers: { Cookie: qbitCookie! } };
  if (body) { (opts.headers as Record<string, string>)["Content-Type"] = "application/x-www-form-urlencoded"; opts.body = new URLSearchParams(body); }
  let res = await fetch(`${QBIT_URL}/api/v2/${endpoint}`, opts);
  if (res.status === 403) { await qbitLogin(); opts.headers = { Cookie: qbitCookie! }; if (body) (opts.headers as Record<string, string>)["Content-Type"] = "application/x-www-form-urlencoded"; res = await fetch(`${QBIT_URL}/api/v2/${endpoint}`, opts); }
  if (!res.ok) throw new Error(`qBit ${res.status}: ${await res.text()}`);
  const ct = res.headers.get("content-type");
  return ct?.includes("json") ? res.json() : res.text();
}

/**
 * Pause / resume helpers that work across qBittorrent versions.
 * qBit v5 renamed `torrents/pause` → `torrents/stop` and `torrents/resume`
 * → `torrents/start`. The old endpoints now return 404. linuxserver's
 * `qbittorrent:latest` tracks v5, so most users are on the new names.
 *
 * We try the v5 endpoint first and fall back to v4 only on 404 — every
 * other status (5xx, auth) bubbles up unchanged. The detected variant is
 * cached for the process lifetime to avoid the second request after the
 * first call lands.
 */
let pauseEndpoint:  "torrents/stop"  | "torrents/pause"  | null = null;
let resumeEndpoint: "torrents/start" | "torrents/resume" | null = null;

async function qbitPauseOrResume(
  cached: typeof pauseEndpoint | typeof resumeEndpoint,
  primary: string,
  fallback: string,
  hashes: string,
): Promise<{ used: string }> {
  if (cached) {
    await qbitApi(cached, "POST", { hashes });
    return { used: cached };
  }
  try {
    await qbitApi(primary, "POST", { hashes });
    return { used: primary };
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("qBit 404")) {
      await qbitApi(fallback, "POST", { hashes });
      return { used: fallback };
    }
    throw err;
  }
}

export async function qbitPause(hashes: string): Promise<void> {
  const { used } = await qbitPauseOrResume(pauseEndpoint, "torrents/stop", "torrents/pause", hashes);
  pauseEndpoint = used as typeof pauseEndpoint;
}

export async function qbitResume(hashes: string): Promise<void> {
  const { used } = await qbitPauseOrResume(resumeEndpoint, "torrents/start", "torrents/resume", hashes);
  resumeEndpoint = used as typeof resumeEndpoint;
}
