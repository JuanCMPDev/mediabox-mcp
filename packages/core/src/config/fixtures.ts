import type { DeployConfig } from "./types.js";

/**
 * Minimal happy-path DeployConfig used as a base in tests.
 * Mutate via `{ ...baseConfig, deployment: { ...baseConfig.deployment, ... } }`.
 */
export function baseConfig(): DeployConfig {
  return {
    deployment: {
      mode: "local",
      localBuild: false,
      imageTag: "2.2.0-beta.0",
    },
    system: {
      timezone: "UTC",
      puid: 1000,
      pgid: 1000,
    },
    paths: {
      movies: "./media/movies",
      tv: "./media/tv",
      anime: "./media/anime",
      music: "./media/music",
    },
    services: {
      jellyfin: { adminUsername: "admin", adminPassword: "testpass" },
      qbittorrent: { password: "qbitpass1" },
      pyload: { username: "pyload", password: "pyload" },
      bazarr: { enabled: false },
    },
    mcp: {
      publicUrl: "http://localhost:3000",
      internalApiKey: "deadbeef",
    },
  };
}
