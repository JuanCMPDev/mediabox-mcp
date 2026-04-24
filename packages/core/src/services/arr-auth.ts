import type { EventHandler } from "../events/types.js";
import { fetchWithRetry } from "../utils/http.js";

export interface ArrServiceTarget {
  /** Display name in logs ("Sonarr", "Radarr", "Prowlarr") */
  name: string;
  baseUrl: string;
  apiVersion: "v1" | "v3";
  apiKey: string;
}

export interface ArrAuthInput {
  services: ArrServiceTarget[];
  username: string;
  password: string;
}

/**
 * Configure web UI authentication for Sonarr, Radarr, and Prowlarr.
 * Sets username/password so the user doesn't get prompted on first web access.
 *
 * Failures per service are reported as warnings — the deploy continues.
 */
export async function configureArrAuth(
  input: ArrAuthInput,
  onEvent: EventHandler,
): Promise<void> {
  for (const svc of input.services) {
    try {
      await setAuth(svc, input.username, input.password);
      onEvent({
        kind: "success",
        phase: "configure:arr-auth",
        message: `${svc.name}: Web UI auth configured`,
      });
    } catch (err) {
      onEvent({
        kind: "warn",
        phase: "configure:arr-auth",
        message: `${svc.name}: Could not set web auth — ${(err as Error).message}`,
      });
    }
  }
}

async function setAuth(
  svc: ArrServiceTarget,
  username: string,
  password: string,
): Promise<void> {
  const headers = { "X-Api-Key": svc.apiKey, "Content-Type": "application/json" };

  const getRes = await fetchWithRetry(
    `${svc.baseUrl}/api/${svc.apiVersion}/config/host`,
    { headers },
  );
  if (!getRes.ok) throw new Error(`GET config failed: ${getRes.status}`);
  const config = (await getRes.json()) as Record<string, unknown>;

  config.authenticationMethod = "forms";
  config.authenticationRequired = "enabled";
  config.username = username;
  config.password = password;
  config.passwordConfirmation = password;

  const putRes = await fetchWithRetry(
    `${svc.baseUrl}/api/${svc.apiVersion}/config/host`,
    { method: "PUT", headers, body: JSON.stringify(config) },
  );
  if (!putRes.ok) {
    const body = await putRes.text().catch(() => "");
    throw new Error(`PUT config failed: ${putRes.status} ${body}`);
  }
}
