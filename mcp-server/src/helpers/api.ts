import { JELLYFIN_URL, API_KEY, SONARR_URL, SONARR_API_KEY, RADARR_URL, RADARR_API_KEY } from "../config.js";

export async function jfApi(endpoint: string, method = "GET", body?: unknown): Promise<any> {
  const res = await fetch(`${JELLYFIN_URL}${endpoint}`, { method, headers: { "X-Emby-Token": API_KEY, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`Jellyfin API ${res.status}: ${await res.text()}`);
  return res.headers.get("content-type")?.includes("json") ? res.json() : { status: res.status };
}

export async function sonarrApi(ep: string, method: "GET" | "POST" | "PUT" | "DELETE" = "GET", body?: unknown): Promise<any> {
  const res = await fetch(`${SONARR_URL}/api/v3/${ep}`, { method, headers: { "X-Api-Key": SONARR_API_KEY, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`Sonarr ${res.status}: ${await res.text()}`);
  return res.headers.get("content-type")?.includes("json") ? res.json() : { status: res.status };
}

export async function radarrApi(ep: string, method: "GET" | "POST" | "PUT" | "DELETE" = "GET", body?: unknown): Promise<any> {
  const res = await fetch(`${RADARR_URL}/api/v3/${ep}`, { method, headers: { "X-Api-Key": RADARR_API_KEY, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`Radarr ${res.status}: ${await res.text()}`);
  return res.headers.get("content-type")?.includes("json") ? res.json() : { status: res.status };
}

export function textResult(data: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] }; }
