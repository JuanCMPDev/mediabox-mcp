import { fetchWithRetry } from "../utils/http.js";
import * as log from "../utils/logger.js";

const BASE = "http://localhost:9696";

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

/**
 * Configure Prowlarr to sync indexers with Sonarr and Radarr.
 */
export async function configureProwlarr(
  prowlarrApiKey: string,
  sonarrApiKey: string,
  radarrApiKey: string
): Promise<void> {
  // Check existing apps
  const existingRes = await fetchWithRetry(`${BASE}/api/v1/applications`, {
    headers: headers(prowlarrApiKey),
  });
  const existingApps = (await existingRes.json()) as Array<{ name: string }>;
  const existingNames = new Set(existingApps.map((a) => a.name));

  // Add Sonarr
  if (!existingNames.has("Sonarr")) {
    await addApplication(prowlarrApiKey, {
      name: "Sonarr",
      implementation: "Sonarr",
      configContract: "SonarrSettings",
      syncLevel: "fullSync",
      fields: [
        { name: "prowlarrUrl", value: "http://prowlarr:9696" },
        { name: "baseUrl", value: "http://sonarr:8989" },
        { name: "apiKey", value: sonarrApiKey },
        { name: "syncCategories", value: [5000, 5010, 5020, 5030, 5040, 5045, 5050, 5060, 5070, 5080] },
      ],
      tags: [],
    });
    log.success("Prowlarr: Added Sonarr sync");
  } else {
    log.info("Prowlarr: Sonarr sync already configured");
  }

  // Add Radarr
  if (!existingNames.has("Radarr")) {
    await addApplication(prowlarrApiKey, {
      name: "Radarr",
      implementation: "Radarr",
      configContract: "RadarrSettings",
      syncLevel: "fullSync",
      fields: [
        { name: "prowlarrUrl", value: "http://prowlarr:9696" },
        { name: "baseUrl", value: "http://radarr:7878" },
        { name: "apiKey", value: radarrApiKey },
        { name: "syncCategories", value: [2000, 2010, 2020, 2030, 2040, 2045, 2050, 2060, 2070, 2080] },
      ],
      tags: [],
    });
    log.success("Prowlarr: Added Radarr sync");
  } else {
    log.info("Prowlarr: Radarr sync already configured");
  }
}

async function addApplication(apiKey: string, app: AppPayload): Promise<void> {
  const res = await fetchWithRetry(`${BASE}/api/v1/applications`, {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify(app),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Prowlarr: Failed to add ${app.name}: ${res.status} ${text}`);
  }
}

/**
 * Configure FlareSolverr as an indexer proxy in Prowlarr.
 */
export async function configureFlareSolverr(prowlarrApiKey: string): Promise<void> {
  // Check if already configured
  const existingRes = await fetchWithRetry(`${BASE}/api/v1/indexerProxy`, {
    headers: headers(prowlarrApiKey),
  });
  const existing = (await existingRes.json()) as Array<{ name: string; implementation: string }>;
  if (existing.some((p) => p.implementation === "FlareSolverr")) {
    log.info("Prowlarr: FlareSolverr proxy already configured");
    return;
  }

  // Get schema
  const schemaRes = await fetchWithRetry(`${BASE}/api/v1/indexerProxy/schema`, {
    headers: headers(prowlarrApiKey),
  });
  const schemas = (await schemaRes.json()) as Array<{
    implementation: string;
    fields: Array<{ name: string; value: any }>;
    [key: string]: any;
  }>;
  const fsSchema = schemas.find((s) => s.implementation === "FlareSolverr");
  if (!fsSchema) throw new Error("FlareSolverr schema not found in Prowlarr");

  // Set host to Docker internal URL
  for (const field of fsSchema.fields) {
    if (field.name === "host") field.value = "http://flaresolverr:8191/";
  }

  const body = { ...fsSchema, name: "FlareSolverr" };
  const res = await fetchWithRetry(`${BASE}/api/v1/indexerProxy`, {
    method: "POST",
    headers: headers(prowlarrApiKey),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Prowlarr: Failed to add FlareSolverr: ${res.status} ${text}`);
  }
  log.success("Prowlarr: FlareSolverr proxy configured");
}
