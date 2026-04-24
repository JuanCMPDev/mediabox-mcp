import type { EventHandler } from "../events/types.js";
import { fetchWithRetry, pollUntilReady, sleep } from "../utils/http.js";

export interface JellyfinSetupInput {
  baseUrl: string;
  adminUsername: string;
  adminPassword: string;
  clientVersion: string; // for X-Emby-Authorization header
}

export interface JellyfinLibrariesInput {
  baseUrl: string;
  apiKey: string;
}

/**
 * Run Jellyfin's first-time setup wizard programmatically.
 * Returns the generated API key. Idempotent: if the wizard has already
 * completed, authenticates as the existing admin and provisions a key.
 */
export async function configureJellyfin(
  input: JellyfinSetupInput,
  onEvent: EventHandler,
): Promise<string> {
  const { baseUrl, adminUsername, adminPassword, clientVersion } = input;

  // Jellyfin's HTTP server responds before the startup wizard endpoints are
  // registered. Poll /Startup/Configuration until 200, then check /Users/Public
  // to distinguish fresh install vs re-run.
  let wizardActive = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const checkRes = await fetch(`${baseUrl}/Startup/Configuration`, {
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
    // Wizard never responded with 200 — check if users exist (re-run scenario).
    try {
      const usersRes = await fetchWithRetry(`${baseUrl}/Users/Public`);
      const users = (await usersRes.json()) as Array<{ Name: string }>;
      if (users.length > 0) {
        onEvent({
          kind: "warn",
          phase: "configure:jellyfin",
          message: "Jellyfin startup wizard already completed, authenticating...",
        });
        return await authenticateAndCreateKey(
          baseUrl,
          adminUsername,
          adminPassword,
          clientVersion,
          onEvent,
        );
      }
    } catch {
      // ignore — fall through to error
    }
    throw new Error("Jellyfin startup wizard not responding after 60s");
  }

  // All startup wizard steps use single-attempt POSTs (no retry on 5xx)
  // because these are state-changing operations — retrying corrupts wizard state.

  // Step A: Set initial configuration
  const configRes = await jellyfinPost(`${baseUrl}/Startup/Configuration`, {
    UICulture: "en-US",
    MetadataCountryCode: "US",
    PreferredMetadataLanguage: "en",
  });
  if (!configRes.ok) {
    const body = await configRes.text().catch(() => "");
    throw new Error(`Failed to set Jellyfin startup config: ${configRes.status} ${body}`);
  }

  // Step B: wait for internal user DB, then update the default user.
  const userReady = await pollUntilReady(`${baseUrl}/Startup/User`, 60_000, {
    validateResponse: async (res) => {
      if (!res.ok) return false;
      const data = (await res.json().catch(() => null)) as { Name?: string } | null;
      return !!data?.Name;
    },
  });
  if (!userReady) {
    throw new Error("Jellyfin did not initialize default user within 60s");
  }

  const userRes = await jellyfinPost(`${baseUrl}/Startup/User`, {
    Name: adminUsername,
    Password: adminPassword,
  });
  if (!userRes.ok) {
    const body = await userRes.text().catch(() => "");
    throw new Error(`Failed to create Jellyfin admin user: ${userRes.status} ${body}`);
  }

  // Authenticate + create API key BEFORE completing the wizard to avoid the
  // restart-triggered session invalidation that /Startup/Complete can cause.
  await sleep(2000);
  const apiKey = await authenticateAndCreateKey(
    baseUrl,
    adminUsername,
    adminPassword,
    clientVersion,
    onEvent,
  );

  // Step C: Complete startup wizard
  const completeRes = await jellyfinPost(`${baseUrl}/Startup/Complete`, {});
  if (!completeRes.ok) {
    onEvent({
      kind: "warn",
      phase: "configure:jellyfin",
      message: `Jellyfin /Startup/Complete returned ${completeRes.status} (API key already saved)`,
    });
  } else {
    onEvent({
      kind: "success",
      phase: "configure:jellyfin",
      message: "Jellyfin startup wizard completed",
    });
  }

  return apiKey;
}

async function authenticateAndCreateKey(
  baseUrl: string,
  username: string,
  password: string,
  clientVersion: string,
  onEvent: EventHandler,
): Promise<string> {
  const authRes = await fetchWithRetry(`${baseUrl}/Users/AuthenticateByName`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Emby-Authorization":
        `MediaBrowser Client="Mediabox CLI", Device="CLI", DeviceId="mediabox-setup", Version="${clientVersion}"`,
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

  const createKeyRes = await fetchWithRetry(`${baseUrl}/Auth/Keys?app=mediabox-mcp`, {
    method: "POST",
    headers: { "X-Emby-Token": accessToken },
  });
  if (!createKeyRes.ok) {
    throw new Error(`Failed to create Jellyfin API key: ${createKeyRes.status}`);
  }

  const keysRes = await fetchWithRetry(`${baseUrl}/Auth/Keys`, {
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

  onEvent({
    kind: "success",
    phase: "configure:jellyfin",
    message: "Jellyfin API key created",
  });
  return mcpKey.AccessToken;
}

/**
 * Add media libraries to Jellyfin (Movies, TV Shows, Anime, Music)
 * and kick off an initial scan.
 */
export async function addJellyfinLibraries(
  input: JellyfinLibrariesInput,
  onEvent: EventHandler,
): Promise<void> {
  const { baseUrl, apiKey } = input;
  const headers = { "X-Emby-Token": apiKey };

  const existingRes = await fetchWithRetry(`${baseUrl}/Library/VirtualFolders`, { headers });
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
      onEvent({
        kind: "log",
        level: "info",
        message: `Jellyfin: Library "${lib.name}" already exists`,
      });
      continue;
    }

    const params = new URLSearchParams({
      name: lib.name,
      collectionType: lib.collectionType,
      refreshLibrary: "false",
    });
    params.append("paths", lib.path);

    const res = await fetchWithRetry(`${baseUrl}/Library/VirtualFolders?${params}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: "{}",
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      onEvent({
        kind: "warn",
        phase: "configure:jellyfin-libraries",
        message: `Jellyfin: Failed to add "${lib.name}" library: ${res.status} ${text}`,
      });
    } else {
      onEvent({
        kind: "success",
        phase: "configure:jellyfin-libraries",
        message: `Jellyfin: Added "${lib.name}" library`,
      });
    }
  }

  await fetchWithRetry(`${baseUrl}/Library/Refresh`, { method: "POST", headers });
  onEvent({
    kind: "success",
    phase: "configure:jellyfin-libraries",
    message: "Jellyfin: Library scan started",
  });
}

async function jellyfinPost(url: string, body: object): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
}
