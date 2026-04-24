import type { ServiceEndpoint, ServiceId, ServiceStatus } from "@mediabox/contracts";
import {
  JELLYFIN_URL, SONARR_URL, RADARR_URL, PROWLARR_URL,
  QBIT_URL, PYLOAD_URL, PYLOAD_HOST_PORT,
  FLARESOLVERR_URL, BAZARR_URL, BAZARR_ENABLED,
} from "../config.js";
import { toHostUrl } from "./utils.js";

interface ServiceDef {
  id:          ServiceId;
  name:        string;
  description: string;
  pingUrl:     string;   // container-internal URL to health-check
  browserUrl:  string;   // localhost URL opened in the browser
}

function buildDefs(): ServiceDef[] {
  const defs: ServiceDef[] = [
    {
      id:          "jellyfin",
      name:        "Jellyfin",
      description: "Media server",
      pingUrl:     `${JELLYFIN_URL}/System/Info/Public`,
      browserUrl:  toHostUrl(JELLYFIN_URL),
    },
    {
      id:          "sonarr",
      name:        "Sonarr",
      description: "TV & anime management",
      pingUrl:     `${SONARR_URL}/api/v3/system/status`,
      browserUrl:  toHostUrl(SONARR_URL),
    },
    {
      id:          "radarr",
      name:        "Radarr",
      description: "Movie management",
      pingUrl:     `${RADARR_URL}/api/v3/system/status`,
      browserUrl:  toHostUrl(RADARR_URL),
    },
    {
      id:          "prowlarr",
      name:        "Prowlarr",
      description: "Indexer manager",
      pingUrl:     `${PROWLARR_URL}/api/v1/system/status`,
      browserUrl:  toHostUrl(PROWLARR_URL),
    },
    {
      id:          "qbittorrent",
      name:        "qBittorrent",
      description: "Torrent client",
      pingUrl:     `${QBIT_URL}/api/v2/app/version`,
      browserUrl:  toHostUrl(QBIT_URL),
    },
    {
      id:          "pyload",
      name:        "PyLoad",
      description: "Direct downloader",
      pingUrl:     `${PYLOAD_URL}/login`,
      browserUrl:  toHostUrl(PYLOAD_URL, PYLOAD_HOST_PORT),
    },
    {
      id:          "flaresolverr",
      name:        "FlareSolverr",
      description: "Cloudflare bypass",
      pingUrl:     `${FLARESOLVERR_URL}/health`,
      browserUrl:  toHostUrl(FLARESOLVERR_URL),
    },
  ];

  if (BAZARR_ENABLED) {
    defs.push({
      id:          "bazarr",
      name:        "Bazarr",
      description: "Subtitle management",
      pingUrl:     `${BAZARR_URL}/api/system/health`,
      browserUrl:  toHostUrl(BAZARR_URL),
    });
  }

  return defs;
}

/** Reachability: any HTTP response (including auth-required 401/403) = online.
 *  Only network errors, timeouts, and 5xx = offline/warning. */
async function checkStatus(pingUrl: string): Promise<ServiceStatus> {
  try {
    const res = await fetch(pingUrl, { signal: AbortSignal.timeout(2000) });
    if (res.status >= 500) return "warning";
    return "online";
  } catch {
    return "offline";
  }
}

export async function getServices(): Promise<ServiceEndpoint[]> {
  const defs = buildDefs();
  return Promise.all(
    defs.map(async (def): Promise<ServiceEndpoint> => ({
      id:          def.id,
      name:        def.name,
      description: def.description,
      url:         def.browserUrl,
      status:      await checkStatus(def.pingUrl),
    }))
  );
}
