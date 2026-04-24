import type { EventHandler } from "../events/types.js";
import { fetchWithRetry } from "../utils/http.js";

export interface ProwlarrInput {
  baseUrl: string;
  apiKey: string;
}

function headers(apiKey: string): Record<string, string> {
  return { "X-Api-Key": apiKey, "Content-Type": "application/json" };
}

interface AppPayload {
  name: string;
  implementation: string;
  configContract: string;
  syncLevel: string;
  fields: Array<{ name: string; value: any }>;
  tags: number[];
}

/** Configure Prowlarr to sync indexers with Sonarr and Radarr. */
export async function configureProwlarr(
  input: ProwlarrInput & { sonarrApiKey: string; radarrApiKey: string },
  onEvent: EventHandler,
): Promise<void> {
  const { baseUrl, apiKey, sonarrApiKey, radarrApiKey } = input;

  const existingRes = await fetchWithRetry(`${baseUrl}/api/v1/applications`, {
    headers: headers(apiKey),
  });
  const existingApps = (await existingRes.json()) as Array<{ name: string }>;
  const existingNames = new Set(existingApps.map((a) => a.name));

  if (!existingNames.has("Sonarr")) {
    await addApplication(baseUrl, apiKey, {
      name: "Sonarr",
      implementation: "Sonarr",
      configContract: "SonarrSettings",
      syncLevel: "fullSync",
      fields: [
        { name: "prowlarrUrl", value: "http://prowlarr:9696" },
        { name: "baseUrl", value: "http://sonarr:8989" },
        { name: "apiKey", value: sonarrApiKey },
        {
          name: "syncCategories",
          value: [5000, 5010, 5020, 5030, 5040, 5045, 5050, 5060, 5070, 5080],
        },
      ],
      tags: [],
    });
    onEvent({
      kind: "success",
      phase: "configure:prowlarr",
      message: "Prowlarr: Added Sonarr sync",
    });
  } else {
    onEvent({
      kind: "log",
      level: "info",
      message: "Prowlarr: Sonarr sync already configured",
    });
  }

  if (!existingNames.has("Radarr")) {
    await addApplication(baseUrl, apiKey, {
      name: "Radarr",
      implementation: "Radarr",
      configContract: "RadarrSettings",
      syncLevel: "fullSync",
      fields: [
        { name: "prowlarrUrl", value: "http://prowlarr:9696" },
        { name: "baseUrl", value: "http://radarr:7878" },
        { name: "apiKey", value: radarrApiKey },
        {
          name: "syncCategories",
          value: [2000, 2010, 2020, 2030, 2040, 2045, 2050, 2060, 2070, 2080],
        },
      ],
      tags: [],
    });
    onEvent({
      kind: "success",
      phase: "configure:prowlarr",
      message: "Prowlarr: Added Radarr sync",
    });
  } else {
    onEvent({
      kind: "log",
      level: "info",
      message: "Prowlarr: Radarr sync already configured",
    });
  }
}

async function addApplication(
  baseUrl: string,
  apiKey: string,
  app: AppPayload,
): Promise<void> {
  const res = await fetchWithRetry(`${baseUrl}/api/v1/applications`, {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify(app),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Prowlarr: Failed to add ${app.name}: ${res.status} ${text}`);
  }
}

/** Configure FlareSolverr as an indexer proxy in Prowlarr. */
export async function configureFlareSolverr(
  input: ProwlarrInput,
  onEvent: EventHandler,
): Promise<void> {
  const { baseUrl, apiKey } = input;
  const existingRes = await fetchWithRetry(`${baseUrl}/api/v1/indexerProxy`, {
    headers: headers(apiKey),
  });
  const existing = (await existingRes.json()) as Array<{
    name: string;
    implementation: string;
  }>;
  if (existing.some((p) => p.implementation === "FlareSolverr")) {
    onEvent({
      kind: "log",
      level: "info",
      message: "Prowlarr: FlareSolverr proxy already configured",
    });
    return;
  }

  const schemaRes = await fetchWithRetry(`${baseUrl}/api/v1/indexerProxy/schema`, {
    headers: headers(apiKey),
  });
  const schemas = (await schemaRes.json()) as Array<{
    implementation: string;
    fields: Array<{ name: string; value: any }>;
    [key: string]: any;
  }>;
  const fsSchema = schemas.find((s) => s.implementation === "FlareSolverr");
  if (!fsSchema) throw new Error("FlareSolverr schema not found in Prowlarr");

  for (const field of fsSchema.fields) {
    if (field.name === "host") field.value = "http://flaresolverr:8191/";
  }

  const body = { ...fsSchema, name: "FlareSolverr" };
  const res = await fetchWithRetry(`${baseUrl}/api/v1/indexerProxy`, {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Prowlarr: Failed to add FlareSolverr: ${res.status} ${text}`);
  }
  onEvent({
    kind: "success",
    phase: "configure:flaresolverr",
    message: "Prowlarr: FlareSolverr proxy configured",
  });
}
