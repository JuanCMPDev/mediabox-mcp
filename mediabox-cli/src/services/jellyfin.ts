import { fetchWithRetry, pollUntilReady, sleep } from "../utils/http.js";
import * as log from "../utils/logger.js";

const BASE = "http://localhost:8096";

/**
 * Run Jellyfin's first-time setup wizard programmatically.
 * Returns the generated API key for the MCP server.
 */
export async function configureJellyfin(username: string, password: string): Promise<string> {
  // Jellyfin's HTTP server responds before the startup wizard endpoints are
  // registered. Poll /Startup/Configuration until 200, then check /Users/Public
  // to distinguish fresh install vs re-run.
  let wizardActive = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const checkRes = await fetch(`${BASE}/Startup/Configuration`, {
        signal: AbortSignal.timeout(5000),
      });
      if (checkRes.ok) {
        wizardActive = true;
        break;
      }
    } catch {
      // Connection error — Jellyfin startup API not ready yet
    }
    await sleep(3000);
  }

  if (!wizardActive) {
    // Wizard never responded with 200 — check if users exist (re-run scenario)
    // or if Jellyfin is genuinely stuck.
    try {
      const usersRes = await fetchWithRetry(`${BASE}/Users/Public`);
      const users = (await usersRes.json()) as Array<{ Name: string }>;
      if (users.length > 0) {
        log.warn("Jellyfin startup wizard already completed, authenticating...");
        return await authenticateAndCreateKey(username, password);
      }
    } catch {
      // ignore — fall through to error
    }
    throw new Error("Jellyfin startup wizard not responding after 60s");
  }

  // All startup wizard steps use single-attempt POSTs (no retry on 5xx)
  // because these are state-changing operations — retrying corrupts wizard state

  // Step A: Set initial configuration
  const configRes = await jellyfinPost(`${BASE}/Startup/Configuration`, {
    UICulture: "en-US",
    MetadataCountryCode: "US",
    PreferredMetadataLanguage: "en",
  });
  if (!configRes.ok) {
    const body = await configRes.text().catch(() => "");
    throw new Error(`Failed to set Jellyfin startup config: ${configRes.status} ${body}`);
  }

  // Step B: Create admin user — Jellyfin needs time after Step A to create
  // a default user internally. Poll GET /Startup/User until it returns a
  // Name (proves the user DB is initialized), then POST to update it.
  const userReady = await pollUntilReady(`${BASE}/Startup/User`, 60_000, {
    validateResponse: async (res) => {
      if (!res.ok) return false;
      const data = await res.json().catch(() => null) as { Name?: string } | null;
      return !!data?.Name;
    },
  });
  if (!userReady) {
    throw new Error("Jellyfin did not initialize default user within 60s");
  }

  const userRes = await jellyfinPost(`${BASE}/Startup/User`, {
    Name: username,
    Password: password,
  });
  if (!userRes.ok) {
    const body = await userRes.text().catch(() => "");
    throw new Error(`Failed to create Jellyfin admin user: ${userRes.status} ${body}`);
  }

  // Authenticate and create API key BEFORE completing the wizard.
  // /Startup/Complete triggers an internal restart that can invalidate sessions
  // and sometimes reset credentials. Doing this while the wizard is still active
  // ensures the user we just created is accessible.
  await sleep(2000);
  const apiKey = await authenticateAndCreateKey(username, password);

  // Step C: Complete startup wizard
  const completeRes = await jellyfinPost(`${BASE}/Startup/Complete`, {});
  if (!completeRes.ok) {
    // Non-fatal — the API key is already created
    log.warn(`Jellyfin startup complete returned ${completeRes.status} (API key already saved)`);
  } else {
    log.success("Jellyfin startup wizard completed");
  }

  return apiKey;
}

/** Wait for Jellyfin to be fully responsive after startup/restart */
async function waitForJellyfin(): Promise<void> {
  const ready = await pollUntilReady(`${BASE}/System/Info/Public`, 60_000);
  if (!ready) {
    throw new Error("Jellyfin not responding after startup wizard completion");
  }
}


async function authenticateAndCreateKey(username: string, password: string): Promise<string> {
  // Step D: Authenticate as admin
  const authRes = await fetchWithRetry(`${BASE}/Users/AuthenticateByName`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Emby-Authorization":
        'MediaBrowser Client="Mediabox CLI", Device="CLI", DeviceId="mediabox-setup", Version="0.2.0"',
    },
    body: JSON.stringify({ Username: username, Pw: password }),
    retries: 5,
    initialDelayMs: 3000,
  });

  if (!authRes.ok) {
    throw new Error(`Jellyfin authentication failed: ${authRes.status}`);
  }

  const authData = (await authRes.json()) as { AccessToken: string };
  const accessToken = authData.AccessToken;

  // Step E: Create API key — "app" is a query parameter per Jellyfin OpenAPI spec
  const createKeyRes = await fetchWithRetry(`${BASE}/Auth/Keys?app=mediabox-mcp`, {
    method: "POST",
    headers: { "X-Emby-Token": accessToken },
  });

  if (!createKeyRes.ok) {
    throw new Error(`Failed to create Jellyfin API key: ${createKeyRes.status}`);
  }

  // Step F: Retrieve the created key
  const keysRes = await fetchWithRetry(`${BASE}/Auth/Keys`, {
    headers: { "X-Emby-Token": accessToken },
  });

  if (!keysRes.ok) {
    throw new Error(`Failed to retrieve Jellyfin API keys: ${keysRes.status}`);
  }

  const keysData = (await keysRes.json()) as {
    Items: Array<{ AppName: string; AccessToken: string }>;
  };
  const mcpKey = keysData.Items.find((k) => k.AppName === "mediabox-mcp");

  if (!mcpKey) {
    throw new Error("Could not find the created mediabox-mcp API key");
  }

  log.success("Jellyfin API key created");
  return mcpKey.AccessToken;
}

/**
 * Add media libraries to Jellyfin (Movies, TV Shows, Anime, Music).
 */
export async function addJellyfinLibraries(apiKey: string): Promise<void> {
  const headers = { "X-Emby-Token": apiKey };

  // Check existing libraries
  const existingRes = await fetchWithRetry(`${BASE}/Library/VirtualFolders`, { headers });
  const existing = (await existingRes.json()) as Array<{ Name: string }>;
  const existingNames = new Set(existing.map((l) => l.Name));

  const libraries: Array<{ name: string; collectionType: string; path: string }> = [
    { name: "Movies", collectionType: "movies", path: "/data/movies" },
    { name: "TV Shows", collectionType: "tvshows", path: "/data/tv" },
    { name: "Anime", collectionType: "tvshows", path: "/data/anime" },
    { name: "Music", collectionType: "music", path: "/data/music" },
  ];

  for (const lib of libraries) {
    if (existingNames.has(lib.name)) {
      log.info(`Jellyfin: Library "${lib.name}" already exists`);
      continue;
    }

    const params = new URLSearchParams({
      name: lib.name,
      collectionType: lib.collectionType,
      refreshLibrary: "false",
    });
    // paths[] must be appended separately for array format
    params.append("paths", lib.path);

    const res = await fetchWithRetry(`${BASE}/Library/VirtualFolders?${params}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: "{}",
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      log.warn(`Jellyfin: Failed to add "${lib.name}" library: ${res.status} ${text}`);
    } else {
      log.success(`Jellyfin: Added "${lib.name}" library`);
    }
  }

  // Trigger a library scan
  await fetchWithRetry(`${BASE}/Library/Refresh`, {
    method: "POST",
    headers,
  });
  log.success("Jellyfin: Library scan started");
}

/** Single-attempt POST for Jellyfin startup wizard steps (no retry on 5xx) */
async function jellyfinPost(url: string, body: object): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
}
