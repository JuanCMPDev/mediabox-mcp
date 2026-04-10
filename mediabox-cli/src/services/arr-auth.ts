import { fetchWithRetry } from "../utils/http.js";
import * as log from "../utils/logger.js";

interface ArrService {
  name: string;
  baseUrl: string;
  apiVersion: string;
}

const SERVICES: ArrService[] = [
  { name: "Sonarr", baseUrl: "http://localhost:8989", apiVersion: "v3" },
  { name: "Radarr", baseUrl: "http://localhost:7878", apiVersion: "v3" },
  { name: "Prowlarr", baseUrl: "http://localhost:9696", apiVersion: "v1" },
];

/**
 * Configure web UI authentication for Sonarr, Radarr, and Prowlarr.
 * Sets username/password so the user doesn't get prompted on first web access.
 */
export async function configureArrAuth(
  apiKeys: { sonarr?: string; radarr?: string; prowlarr?: string },
  username: string,
  password: string
): Promise<void> {
  const keyMap: Record<string, string | undefined> = {
    Sonarr: apiKeys.sonarr,
    Radarr: apiKeys.radarr,
    Prowlarr: apiKeys.prowlarr,
  };

  for (const svc of SERVICES) {
    const apiKey = keyMap[svc.name];
    if (!apiKey) continue;

    try {
      await setAuth(svc, apiKey, username, password);
      log.success(`${svc.name}: Web UI auth configured`);
    } catch (err) {
      log.warn(`${svc.name}: Could not set web auth — ${(err as Error).message}`);
    }
  }
}

async function setAuth(
  svc: ArrService,
  apiKey: string,
  username: string,
  password: string
): Promise<void> {
  const headers = { "X-Api-Key": apiKey, "Content-Type": "application/json" };

  // Get current config
  const getRes = await fetchWithRetry(`${svc.baseUrl}/api/${svc.apiVersion}/config/host`, {
    headers,
  });
  if (!getRes.ok) throw new Error(`GET config failed: ${getRes.status}`);
  const config = await getRes.json();

  // Update auth fields
  config.authenticationMethod = "forms";
  config.authenticationRequired = "enabled";
  config.username = username;
  config.password = password;
  config.passwordConfirmation = password;

  // PUT updated config
  const putRes = await fetchWithRetry(`${svc.baseUrl}/api/${svc.apiVersion}/config/host`, {
    method: "PUT",
    headers,
    body: JSON.stringify(config),
  });
  if (!putRes.ok) {
    const body = await putRes.text().catch(() => "");
    throw new Error(`PUT config failed: ${putRes.status} ${body}`);
  }
}
