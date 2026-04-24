import type { EventHandler } from "../events/types.js";
import { fetchWithRetry } from "../utils/http.js";

export interface SonarrInput {
  baseUrl: string;
  apiKey: string;
}

function headers(apiKey: string): Record<string, string> {
  return { "X-Api-Key": apiKey, "Content-Type": "application/json" };
}

/** Configure qBittorrent as download client in Sonarr. */
export async function addDownloadClient(
  input: SonarrInput & { qbitPassword: string },
  onEvent: EventHandler,
): Promise<void> {
  const { baseUrl, apiKey, qbitPassword } = input;

  const existing = await fetchWithRetry(`${baseUrl}/api/v3/downloadclient`, {
    headers: headers(apiKey),
  });
  const clients = (await existing.json()) as Array<{ name: string }>;
  if (clients.some((c) => c.name === "qBittorrent")) {
    onEvent({
      kind: "log",
      level: "info",
      message: "Sonarr: qBittorrent download client already configured",
    });
    return;
  }

  const schemaRes = await fetchWithRetry(`${baseUrl}/api/v3/downloadclient/schema`, {
    headers: headers(apiKey),
  });
  const schemas = (await schemaRes.json()) as Array<{
    implementation: string;
    fields: Array<{ name: string; value: any }>;
    [key: string]: any;
  }>;
  const qbitSchema = schemas.find((s) => s.implementation === "QBittorrent");
  if (!qbitSchema) throw new Error("QBittorrent schema not found in Sonarr");

  const fieldValues: Record<string, any> = {
    host: "qbittorrent",
    port: 8085,
    username: "admin",
    password: qbitPassword,
    tvCategory: "tv-sonarr",
  };
  for (const field of qbitSchema.fields) {
    if (fieldValues[field.name] !== undefined) field.value = fieldValues[field.name];
  }

  const body = { ...qbitSchema, enable: true, name: "qBittorrent", priority: 1 };
  const res = await fetchWithRetry(`${baseUrl}/api/v3/downloadclient`, {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Sonarr: Failed to add download client: ${res.status} ${text}`);
  }
  onEvent({
    kind: "success",
    phase: "configure:sonarr",
    message: "Sonarr: qBittorrent configured as download client",
  });
}

/** Add root folders for TV and Anime in Sonarr. */
export async function addRootFolders(
  input: SonarrInput,
  onEvent: EventHandler,
): Promise<void> {
  const { baseUrl, apiKey } = input;
  const existing = await fetchWithRetry(`${baseUrl}/api/v3/rootfolder`, {
    headers: headers(apiKey),
  });
  const folders = (await existing.json()) as Array<{ path: string }>;
  const existingPaths = new Set(folders.map((f) => f.path));

  for (const folderPath of ["/tv", "/anime"]) {
    if (existingPaths.has(folderPath)) {
      onEvent({
        kind: "log",
        level: "info",
        message: `Sonarr: Root folder ${folderPath} already exists`,
      });
      continue;
    }

    const res = await fetchWithRetry(`${baseUrl}/api/v3/rootfolder`, {
      method: "POST",
      headers: headers(apiKey),
      body: JSON.stringify({ path: folderPath }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `Sonarr: Failed to add root folder ${folderPath}: ${res.status} ${text}`,
      );
    }
    onEvent({
      kind: "success",
      phase: "configure:sonarr",
      message: `Sonarr: Added root folder ${folderPath}`,
    });
  }
}
