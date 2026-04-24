import type { EventHandler } from "../events/types.js";
import { fetchWithRetry } from "../utils/http.js";

export interface QbittorrentInput {
  baseUrl: string;
  password: string;
}

/**
 * Verify qBittorrent is accessible with the configured password.
 * Password was pre-configured via qBittorrent.conf in Phase 2.
 */
export async function verifyQbittorrent(
  input: QbittorrentInput,
  onEvent: EventHandler,
): Promise<boolean> {
  const { baseUrl, password } = input;
  try {
    const res = await fetchWithRetry(`${baseUrl}/api/v2/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "admin", password }).toString(),
      retries: 2,
    });

    const text = await res.text();
    if (text === "Ok.") {
      onEvent({
        kind: "success",
        phase: "configure:qbittorrent",
        message: "qBittorrent: Login verified",
      });
      return true;
    }

    onEvent({
      kind: "warn",
      phase: "configure:qbittorrent",
      message:
        "qBittorrent: Login failed — password may not have been applied. Set manually via Web UI.",
    });
    return false;
  } catch (err) {
    onEvent({
      kind: "warn",
      phase: "configure:qbittorrent",
      message: `qBittorrent: Could not verify login — ${(err as Error).message}`,
    });
    return false;
  }
}
