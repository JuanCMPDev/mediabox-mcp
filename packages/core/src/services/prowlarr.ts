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

/** Configure FlareSolverr as an indexer proxy in Prowlarr.
 *
 * Prowlarr's indexer proxies are inert without a tag — the proxy only routes
 * traffic for indexers that carry a matching tag. So we ensure a `flaresolverr`
 * tag exists, attach it to the proxy, and tell the user to apply that same tag
 * to any Cloudflare-protected indexer they add later. */
export async function configureFlareSolverr(
  input: ProwlarrInput,
  onEvent: EventHandler,
): Promise<void> {
  const { baseUrl, apiKey } = input;
  const TAG_LABEL = "flaresolverr";

  // 1. Ensure the `flaresolverr` tag exists; reuse if it does.
  const tagId = await ensureTag(baseUrl, apiKey, TAG_LABEL);

  // 2. Skip the proxy creation if it already exists, but make sure the tag is
  //    attached — older deploys created the proxy without one.
  const existingRes = await fetchWithRetry(`${baseUrl}/api/v1/indexerProxy`, {
    headers: headers(apiKey),
  });
  const existing = (await existingRes.json()) as Array<{
    id: number;
    name: string;
    implementation: string;
    tags: number[];
    [key: string]: any;
  }>;
  const existingProxy = existing.find((p) => p.implementation === "FlareSolverr");
  if (existingProxy) {
    if (!existingProxy.tags.includes(tagId)) {
      // Attach the tag so the proxy actually applies to tagged indexers.
      const updated = { ...existingProxy, tags: [...existingProxy.tags, tagId] };
      await fetchWithRetry(`${baseUrl}/api/v1/indexerProxy/${existingProxy.id}`, {
        method: "PUT",
        headers: headers(apiKey),
        body: JSON.stringify(updated),
      });
      onEvent({
        kind: "success",
        phase: "configure:flaresolverr",
        message: `Prowlarr: attached "${TAG_LABEL}" tag to existing FlareSolverr proxy`,
      });
    } else {
      onEvent({
        kind: "log",
        level: "info",
        message: "Prowlarr: FlareSolverr proxy already configured",
      });
    }
    return;
  }

  // 3. Create the proxy from the schema, populating the host and the tag.
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

  const body = { ...fsSchema, name: "FlareSolverr", tags: [tagId] };
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
    message: `Prowlarr: FlareSolverr proxy configured with "${TAG_LABEL}" tag — apply it to any Cloudflare-protected indexer.`,
  });
}

/** Find a Prowlarr tag by label, creating it if it doesn't exist. */
async function ensureTag(
  baseUrl: string,
  apiKey: string,
  label: string,
): Promise<number> {
  const listRes = await fetchWithRetry(`${baseUrl}/api/v1/tag`, {
    headers: headers(apiKey),
  });
  const tags = (await listRes.json()) as Array<{ id: number; label: string }>;
  const existing = tags.find((t) => t.label === label);
  if (existing) return existing.id;

  const createRes = await fetchWithRetry(`${baseUrl}/api/v1/tag`, {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify({ label }),
  });
  if (!createRes.ok) {
    const text = await createRes.text();
    throw new Error(`Prowlarr: Failed to create tag "${label}": ${createRes.status} ${text}`);
  }
  const created = (await createRes.json()) as { id: number };
  return created.id;
}
