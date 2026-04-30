<p align="center">
  <img src="https://raw.githubusercontent.com/JuanCMPDev/mediabox-mcp/master/assets/logo.png" width="120" alt="Mediabox MCP">
</p>

<h1 align="center">create-mediabox</h1>

<p align="center">
  CLI wizard for the <a href="https://github.com/JuanCMPDev/mediabox-mcp">Mediabox MCP</a> self-hosted media stack — AI-powered Jellyfin / Sonarr / Radarr management via MCP
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-2.1.0--beta.0-blue" alt="Version">
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License">
  <img src="https://img.shields.io/badge/docker-compose-2496ED?logo=docker&logoColor=white" alt="Docker">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
</p>

---

### Quick Start

```bash
npx create-mediabox
```

One command. Answer a few questions. The CLI sets up the full stack automatically on a Linux server or VPS — Docker containers, API keys, service connections, media libraries, everything.

Supports **Local** (home network), **VPS** (with [Caddy](https://caddyserver.com/) and automatic HTTPS), and **Cloudflare Tunnel** (public access from home without opening ports) deployments.

> Recommended for Linux servers, VPS, and headless deployments. Requires Docker, Docker Compose, and Node.js >= 20. The unqualified `npx create-mediabox` command installs the current npm `latest` release.

#### Flags

- `--local-build` — build the MCP server and Telegram bot images from source instead of pulling from `ghcr.io`. This only works from a cloned `mediabox-mcp` repository root; normal `npx` installs use published images.
- `--generate-only` — write `.env`, `docker-compose.yml`, and `Caddyfile` without starting Docker (useful for inspection)

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
│  │                Your AI Client                    │   │
│  │  Mediabox Desktop · Claude · GPT · Telegram bot  │   │
│  └──────────────────┬───────────────────────────────┘   │
│                     │ MCP (Streamable HTTP)             │
│                     ▼                                   │
│  ┌──────────────────────────────────────────────────┐   │
│  │               MCP Server (:3000)                 │   │
│  │      30 tools · OAuth2 · Express · TypeScript    │   │
│  └──┬──────────┬──────────┬──────────┬──────────┬───┘   │
│     ▼          ▼          ▼          ▼          ▼       │
│  Jellyfin   Sonarr    Radarr    qBittorrent   PyLoad    │
│   :8096     :8989     :7878      :8085        :8000     │
│     │          │          │          │                  │
│     │       Prowlarr  ◄───┘          │                  │
│     │        :9696                   │                  │
│     │          │                     │                  │
│     │     FlareSolverr               │                  │
│     │        :8191                   │                  │
│     ▼                                ▼                  │
│  ┌──────────────────────────────────────────────────┐   │
│  │               Shared Media Volume                │   │
│  │   /data/movies · /data/tv · /data/anime · /music │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
  Local mode:   ports exposed directly
  VPS mode:     ports bound to 127.0.0.1 + Caddy reverse proxy
  Tunnel mode:  ports bound to 127.0.0.1 + Cloudflare Tunnel
```

### MCP Tools (30)

| Category | Tools | Description |
|----------|-------|-------------|
| **Jellyfin** | `server_status` `activity_log` `search_media` `show_details` | Library browsing, monitoring, playback history |
| **Library** | `manage_library` `manage_files` `rename_episodes` `get_library_state` `fix_subtitles` | File ops, subtitle conversion, batch renaming, cross-service state |
| **Sonarr** | `series_search` `series_status` `series_remove` `series_releases` `series_grab` `series_import` `series_rescan` | TV/anime management with auto ID resolution |
| **Radarr** | `movie_search` `movie_status` `movie_remove` `movie_releases` `movie_grab` `movie_import` `movie_rescan` | Movie management with duplicate prevention |
| **Downloads** | `download_add` `download_direct` `download_status` `cancel_downloads` | Direct URLs, PyLoad, queue management, orphan cleanup |
| **Maintenance** | `optimize_media` `cleanup_server` `check_jobs` | Strip tracks, clean server, monitor jobs |

### What does the CLI do?

`create-mediabox` replaces ~15 manual setup steps with a single interactive wizard:

1. **Asks** for your preferences — deployment mode (Local/VPS/Tunnel), media paths, passwords, timezone, optional Telegram bot. The CLI only asks for an AI provider when Telegram is enabled because it does not include an interactive chat client.
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

### Prefer a GUI?

The Mediabox MCP repo also ships a [Tauri Desktop App](https://github.com/JuanCMPDev/mediabox-mcp) that drives the same orchestration engine through a 9-step wizard, then gives you a dashboard, AI chat, log viewer, and one-click image updates. Use the Desktop App for Windows/macOS and for the built-in chat experience; use the CLI for Linux/VPS/headless installs.

---

## License

[MIT](https://github.com/JuanCMPDev/mediabox-mcp/blob/master/LICENSE)
