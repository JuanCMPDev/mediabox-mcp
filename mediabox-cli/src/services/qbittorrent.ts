import { fetchWithRetry } from "../utils/http.js";
import * as log from "../utils/logger.js";

const BASE = "http://localhost:8085";

/**
 * Verify qBittorrent is accessible with the configured password.
 * Password was pre-configured via qBittorrent.conf in Phase 2.
 */
export async function verifyQbittorrent(password: string): Promise<boolean> {
  try {
    const res = await fetchWithRetry(`${BASE}/api/v2/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: "admin", password }).toString(),
      retries: 2,
    });

    const text = await res.text();
    if (text === "Ok.") {
      log.success("qBittorrent: Login verified");
      return true;
    }

    log.warn("qBittorrent: Login failed — password may not have been applied");
    log.warn("  Manual fix: Open http://localhost:8085 and set password manually");
    return false;
  } catch (err) {
    log.warn(`qBittorrent: Could not verify login — ${(err as Error).message}`);
    return false;
  }
}
