export const JELLYFIN_URL    = process.env.JELLYFIN_URL    || "http://jellyfin:8096";
export const API_KEY         = process.env.JELLYFIN_API_KEY || "";
export const MEDIA_PATH      = process.env.MEDIA_PATH      || "/data";
export const DOWNLOADS_PATH  = process.env.DOWNLOADS_PATH  || "/downloads";
export const PYLOAD_URL      = process.env.PYLOAD_URL      || "http://pyload:8000";
export const PYLOAD_HOST_PORT= process.env.PYLOAD_HOST_PORT|| "8001"; // host port differs from container
export const SONARR_URL      = process.env.SONARR_URL      || "http://sonarr:8989";
export const SONARR_API_KEY  = process.env.SONARR_API_KEY  || "";
export const RADARR_URL      = process.env.RADARR_URL      || "http://radarr:7878";
export const RADARR_API_KEY  = process.env.RADARR_API_KEY  || "";
export const PROWLARR_URL    = process.env.PROWLARR_URL    || "http://prowlarr:9696";
export const PROWLARR_API_KEY= process.env.PROWLARR_API_KEY|| "";
export const QBIT_URL        = process.env.QBIT_URL        || "http://qbittorrent:8085";
export const QBIT_USER       = process.env.QBIT_USER       || "admin";
export const QBIT_PASS       = process.env.QBIT_PASSWORD   || "";
export const FLARESOLVERR_URL= process.env.FLARESOLVERR_URL|| "http://flaresolverr:8191";
export const BAZARR_ENABLED  = process.env.BAZARR_ENABLED  === "true";
export const BAZARR_URL      = process.env.BAZARR_URL      || "http://bazarr:6767";
export const PYLOAD_USER     = process.env.PYLOAD_USER     || "pyload";
export const PYLOAD_PASS     = process.env.PYLOAD_PASSWORD || "pyload";
export const PORT            = parseInt(process.env.PORT   || "3000");
export const PUBLIC_URL      = process.env.PUBLIC_URL      || `http://localhost:${PORT}`;

// Where to bind the listener. Defaults to 127.0.0.1 so a bare host run
// (node/tsx/dev) is not exposed to the LAN. Container runs opt into 0.0.0.0
// explicitly — via the mcp-server Dockerfile `ENV BIND_HOST=0.0.0.0` and the
// generated/root docker-compose — because Docker's published-port mapping
// cannot reach a loopback-only listener inside the container. The Tauri
// sidecar also forces 127.0.0.1 since only the embedded webview talks to it.
export const BIND_HOST       = process.env.BIND_HOST       || "127.0.0.1";

// Comma-separated extra origins to allow (in addition to localhost regex and
// Tauri webview origins, which are always allowed). The Docker compose
// generator emits this with MCP_PUBLIC_URL as the default; users can extend
// in .env (e.g. for LAN access via IP).
export const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
