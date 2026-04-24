<p align="center">
  <img src="https://raw.githubusercontent.com/JuanCMPDev/mediabox-mcp/master/assets/logo.png" width="120" alt="Mediabox MCP">
</p>

<h1 align="center">Mediabox MCP</h1>

<p align="center">
  Self-hosted media server with AI-powered management via MCP
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-1.2.2-blue" alt="Version">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
  <img src="https://img.shields.io/badge/docker-compose-2496ED?logo=docker&logoColor=white" alt="Docker">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
</p>

---

### Quick Start

```bash
npx create-mediabox
```

One command. Answer a few questions. The CLI sets up the full stack automatically — Docker containers, API keys, service connections, media libraries, everything.

Supports **Local** (home network), **VPS** (with [Caddy](https://caddyserver.com/) and automatic HTTPS), and **Cloudflare Tunnel** (public access from home without opening ports) deployments.

> Requires Docker, Docker Compose, and Node.js >= 20. Use `--local-build` to build images from source instead of pulling from registry.

### Architecture

```
                        Internet
                           │
              ┌────────────┼────────────┐
              │     Reverse Proxy       │
              │  (Caddy / nginx / etc)  │
              │   :80 / :443 (HTTPS)    │
              └────────────┬────────────┘
                           │ mediabox-net
┌──────────────────────────┼──────────────────────────────┐
│                          ▼                              │
│  ┌──────────────────────────────────────────────────┐   │
│  │                Your AI Client                     │  │
│  │      (Claude / Telegram Bot / Any MCP Client)     │  │
│  └──────────────────┬───────────────────────────────┘   │
│                     │ MCP Protocol (Streamable HTTP)     │
│                     ▼                                   │
│  ┌──────────────────────────────────────────────────┐   │
│  │               MCP Server (:3000)                  │  │
│  │     25 tools · OAuth2 · Express · TypeScript      │  │
│  └──┬──────────┬──────────┬──────────┬──────────┬───┘   │
│     ▼          ▼          ▼          ▼          ▼       │
│  Jellyfin   Sonarr    Radarr    qBittorrent   PyLoad    │
│   :8096     :8989     :7878      :8085        :8000     │
│     │          │          │          │                   │
│     │       Prowlarr  ◄───┘          │                  │
│     │        :9696                   │                  │
│     │          │                     │                  │
│     │     FlareSolverr               │                  │
│     │        :8191                   │                  │
│     ▼                                ▼                  │
│  ┌──────────────────────────────────────────────────┐   │
│  │               Shared Media Volume                 │  │
│  │       /data/movies · /data/tv · /data/anime       │  │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
  Local mode:   ports exposed directly
  VPS mode:     ports bound to 127.0.0.1 + Caddy reverse proxy
  Tunnel mode:  ports bound to 127.0.0.1 + Cloudflare Tunnel
```

### MCP Tools (25)

| Category | Tools | Description |
|----------|-------|-------------|
| **Jellyfin** | `server_status` `activity_log` `search_media` `show_details` | Library browsing, monitoring, playback history |
| **Library** | `manage_library` `manage_files` `rename_episodes` `fix_subtitles` | File ops, subtitle conversion, batch renaming |
| **Sonarr** | `series_search` `series_status` `series_remove` `series_releases` `series_grab` | TV/anime management with auto ID resolution |
| **Radarr** | `movie_search` `movie_status` `movie_remove` `movie_releases` `movie_grab` | Movie management with duplicate prevention |
| **Downloads** | `download_add` `download_direct` `download_status` `cancel_downloads` | Direct URLs, PyLoad, queue management, orphan cleanup |
| **Maintenance** | `optimize_media` `cleanup_server` `check_jobs` | Strip tracks, clean server, monitor jobs |

### What does the CLI do?

The `create-mediabox` CLI replaces ~15 manual setup steps with a single interactive wizard:

1. **Asks** for your preferences — deployment mode (Local/VPS/Tunnel), media paths, passwords, timezone, optional Telegram bot
2. **Generates** `.env`, `docker-compose.yml`, `Caddyfile` (VPS), and pre-configures qBittorrent
3. **Starts** all Docker containers and waits for each service to be ready
4. **Auto-configures** the entire stack via service APIs:
   - Extracts Sonarr/Radarr/Prowlarr API keys
   - Runs Jellyfin setup wizard, creates admin user and API key
   - Configures qBittorrent as download client in Sonarr/Radarr
   - Adds root folders and syncs Prowlarr indexers
   - Sets up FlareSolverr proxy and Jellyfin media libraries
   - Sets web UI credentials across all services

After setup, the only manual step is adding your torrent indexers in Prowlarr.

---

## License

[MIT](LICENSE)
